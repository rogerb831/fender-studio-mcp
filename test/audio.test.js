// audio_capture over a fake bridge and a fake s1tap; audio/analyze.py on
// synthetic signals with known answers (skipped until `npm run build:audio`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture, analyze, audioCapabilities, analyzeTrack, python } from '../src/audio.js';

function bridge({ playing = false, recording = false, click = true, precount = false } = {}) {
  const calls = [];
  const metro = { click, precount, preroll: false, precountBars: 1 };
  const call = async (op, args) => {
    calls.push([op, args]);
    switch (op) {
      case 'song': return { transport: { playing, recording, position: { seconds: 42 } } };
      case 'metronome': Object.assign(metro, args); return { ...metro };
      case 'transport': case 'setTransport': return {};
      default: throw new Error(`unexpected ${op}`);
    }
  };
  return { call, calls, metro };
}

const deps = (log, over = {}) => ({
  pid: () => 1234,
  bin: process.execPath, // exists; never run
  platform: 'darwin', // pin the macOS s1tap path; a Windows host would pick the WASAPI one
  now: () => new Date('2026-10-06T21:00:00Z'),
  run: async (cmd, args) => (log.push(args), { file: args[args.indexOf('--out') + 1], frames: 480000, peakDb: -3 }),
  ...over,
});

test('capture from a stopped transport: click off, play, record, stop, playhead and click back', async () => {
  const b = bridge();
  const runs = [];
  const r = await capture(b.call, { seconds: 10, from_seconds: 30, out: '/tmp/x.wav' }, deps(runs));
  assert.deepEqual(b.calls.map(([op]) => op), ['song', 'setTransport', 'metronome', 'metronome', 'transport', 'transport', 'setTransport', 'metronome']);
  assert.deepEqual(b.calls[1][1], { positionSeconds: 30, positionBars: undefined });
  assert.deepEqual(b.calls[3][1], { click: false, precount: false });
  assert.deepEqual(b.calls[4][1], { action: 'play' });
  assert.deepEqual(b.calls[5][1], { action: 'stop' });
  assert.deepEqual(b.calls[6][1], { positionSeconds: 42 });
  assert.equal(b.metro.click, true, 'click restored');
  assert.deepEqual(runs[0], ['--pid', '1234', '--seconds', '10', '--out', '/tmp/x.wav']);
  assert.equal(r.from, 30);
});

test('capture while already playing leaves the transport and metronome alone', async () => {
  const b = bridge({ playing: true });
  const r = await capture(b.call, { seconds: 2, out: '/tmp/y.wav' }, deps([]));
  assert.deepEqual(b.calls.map(([op]) => op), ['song']);
  assert.match(r.transport, /already playing/);
});

test('capture refuses while recording, and checks its arguments', async () => {
  await assert.rejects(capture(bridge({ recording: true }).call, { seconds: 2 }, deps([])), /recording/);
  await assert.rejects(capture(bridge().call, { seconds: 0 }, deps([])), /seconds/);
  await assert.rejects(capture(bridge().call, { seconds: 2 }, { ...deps([]), pid: () => null }), /not running/);
});

test('the transport is stopped and put back even when the tap fails', async () => {
  const b = bridge();
  await assert.rejects(capture(b.call, { seconds: 2, out: '/tmp/z.wav' }, { ...deps([]), run: async () => { throw new Error('tap failed'); } }), /tap failed/);
  assert.deepEqual(b.calls.slice(-3).map(([op, a]) => [op, a]), [['transport', { action: 'stop' }], ['setTransport', { positionSeconds: 42 }], ['metronome', { click: true, precount: false }]]);
});

test('on Windows: runs the WASAPI loopback capturer (no --pid), warns on near-silence', async () => {
  const win = (log, runResult) => deps(log, {
    platform: 'win32',
    py: process.execPath, // stands in for the venv python; exists, never run
    cap: process.execPath, // stands in for capture_win.py; exists
    run: async (cmd, args) => (log.push(args), runResult),
  });
  const runs = [];
  const r = await capture(bridge({ playing: true }).call, { seconds: 2, out: '/tmp/w.wav' }, win(runs, { file: '/tmp/w.wav', frames: 96000, peakDb: -6 }));
  assert.deepEqual(runs[0], [process.execPath, '--seconds', '2', '--out', '/tmp/w.wav', '--rate', '48000']);
  assert.ok(!runs[0].includes('--pid'), 'the WASAPI capturer loops back a device, not a process');
  assert.equal(r.warning, undefined, 'no warning when the capture has signal');
  assert.equal(r.recommend, undefined, 'no bounce recommendation when the capture has signal');
  // Near-silence -> the ASIO-bypass hint plus a structured recommendation to bounce.
  const quiet = await capture(bridge({ playing: true }).call, { seconds: 2, out: '/tmp/q.wav' }, win([], { file: '/tmp/q.wav', frames: 96000, peakDb: -144 }));
  assert.match(quiet.warning, /ASIO/);
  assert.equal(quiet.recommend, 'bounce');
});

test('analyzeTrack: bounces, analyzes the rendered wav, then undoes the bounce', async () => {
  const calls = [];
  const call = async (op) => { calls.push(op); return {}; };
  const doBounce = async (_c, a) => ({ track: a.track, mode: a.mode, wav: '/songs/Song/Bounces/Gtr.wav' });
  const doAnalyze = async ({ file }) => ({ file, loudness: { integratedLufs: -12 } });
  const r = await analyzeTrack(call, { track: 'Gtr', plot: false }, { doBounce, doAnalyze });
  assert.equal(r.wav, '/songs/Song/Bounces/Gtr.wav');
  assert.equal(r.bounceUndone, true);
  assert.equal(r.analysis.loudness.integratedLufs, -12);
  assert.ok(calls.includes('undo'), 'the bounce is undone so the song is unchanged');

  // keepBounce leaves it in place (no undo).
  const kept = [];
  await analyzeTrack(async (op) => (kept.push(op), {}), { track: 'Gtr', keepBounce: true }, { doBounce, doAnalyze });
  assert.ok(!kept.includes('undo'));

  // No wav (unsaved song) -> error, and still undone.
  const undo = [];
  await assert.rejects(
    analyzeTrack(async (op) => (undo.push(op), {}), { track: 'Gtr' }, { doBounce: async () => ({ wav: null }), doAnalyze }),
    /save the song/,
  );
  assert.ok(undo.includes('undo'));
});

test('audioCapabilities: macOS taps the process; Windows depends on a loopback endpoint', async () => {
  const mac = await audioCapabilities({ platform: 'darwin', bin: process.execPath });
  assert.equal(mac.captureBackend, 'coreaudio-process-tap');
  assert.equal(mac.recommended, 'capture');

  // Windows with an endpoint -> capture is a candidate (ASIO still verified at runtime).
  const withEp = await audioCapabilities({
    platform: 'win32', py: process.execPath, cap: process.execPath,
    run: async () => ({ loopbackEndpoints: ['Speakers'], defaultSpeaker: 'Speakers' }),
  });
  assert.deepEqual([withEp.recommended, withEp.canCapture, withEp.loopbackEndpoints], ['capture', true, ['Speakers']]);

  // Windows with no endpoint (e.g. RDP with nothing capturable) -> bounce.
  const noEp = await audioCapabilities({
    platform: 'win32', py: process.execPath, cap: process.execPath,
    run: async () => ({ loopbackEndpoints: [], defaultSpeaker: null }),
  });
  assert.equal(noEp.recommended, 'bounce');

  // Windows capturer not built -> bounce.
  const notReady = await audioCapabilities({ platform: 'win32', py: '/no/such/python', cap: '/no/such/cap' });
  assert.equal(notReady.recommended, 'bounce');
});

test('analyzer: known answers for a sine, an anti-phase copy and a wide bass', { skip: !existsSync(python) && 'run npm run build:audio' }, async () => {
  // Forward slashes so the path embeds cleanly in the Python source; on Windows a
  // raw "C:\\Users\\..." would be read as string escapes (\U -> unicodeescape error).
  const dir = mkdtempSync(join(tmpdir(), 's1mcp-audio-')).replace(/\\/g, '/');
  execFileSync(python, ['-c', `
import numpy as np, soundfile as sf
sr = 48000; t = np.arange(sr * 10) / sr
s = 0.1 * np.sin(2 * np.pi * 997 * t)
sf.write("${dir}/sine.wav", np.c_[s, s], sr, subtype="FLOAT")
sf.write("${dir}/anti.wav", np.c_[s, -s], sr, subtype="FLOAT")
sf.write("${dir}/bass.wav", np.c_[np.sin(2 * np.pi * 60 * t), np.sin(2 * np.pi * 60 * t + 1.2)] * 0.3, sr, subtype="FLOAT")`]);
  const sine = await analyze({ file: `${dir}/sine.wav`, plot: false });
  assert.ok(Math.abs(sine.loudness.integratedLufs + 20) < 0.1, `a -20 dBFS 997 Hz sine in both channels is -20 LUFS (${sine.loudness.integratedLufs})`);
  assert.ok(Math.abs(sine.peaks.truePeakDbtp + 20) < 0.1);
  assert.ok(Math.abs(sine.peaks.crestFactorDb - 3.01) < 0.05);
  assert.ok(Math.abs(sine.loudness.meanLufsUngated + 20) < 0.1, 'a steady sine: ungated mean = integrated');
  assert.equal(sine.stereo.correlation, 1);
  assert.equal((await analyze({ file: `${dir}/anti.wav`, plot: false })).stereo.correlation, -1);
  const bass = await analyze({ file: `${dir}/bass.wav`, reference: `${dir}/sine.wav` });
  assert.equal(bass.stereo.lowEnd.mono, false);
  assert.ok(bass.flags.some((f) => /not mono/.test(f)));
  assert.ok(bass.comparison.bands.low.deltaDb > 20, 'far more low end than the 1 kHz reference');
  assert.ok(existsSync(`${dir}/bass-vs-reference.png`));
});
