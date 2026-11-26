// Hearing the mix (macOS 14.2+): audio/bin/s1tap records what Studio One plays
// through a Core Audio process tap (nothing installed, the output device left
// alone), and audio/analyze.py measures a recording. Build both with
// `npm run build:audio`.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './paths.js';
import { bounce } from './bounce.js';

const isWin = process.platform === 'win32';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'audio');
export const tapBin = join(root, 'bin', 's1tap'); // macOS process tap
export const winCapture = join(root, 'capture_win.py'); // Windows WASAPI loopback
// The venv's interpreter lives under Scripts\python.exe on Windows, bin/python elsewhere.
export const python = join(root, '.venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
export const analyzer = join(root, 'analyze.py');
export const capturesDir = join(dataDir, 'captures');

// Both helpers print one JSON object; an error comes back as {"error"} with a non-zero exit.
export function runJson(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const parse = (s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      };
      const out = parse(stdout) || parse(stderr.trim().split('\n').pop() || '');
      if (out && out.error) return reject(new Error(out.error));
      if (err) return reject(new Error(`${cmd.split(/[\\/]/).pop()} failed: ${(stderr || err.message).trim()}`));
      if (!out) return reject(new Error(`${cmd.split(/[\\/]/).pop()} printed no result`));
      resolve(out);
    });
  });
}

export function studioPid() {
  try {
    if (isWin) {
      // tasklist is the portable "is it running"; the PID is unused by the WASAPI
      // capturer (it loops back a device, not a process) but keeps the same check.
      const out = execFileSync('tasklist', ['/fi', 'imagename eq Studio Pro.exe', '/nh', '/fo', 'csv'], { encoding: 'utf8' });
      const m = out.match(/"(?:Studio Pro\.exe|studioapp\.exe)","(\d+)"/i);
      return m ? Number(m[1]) : null;
    }
    const pids = execFileSync('pgrep', ['-f', '/Contents/MacOS/(studioapp|Studio Pro)( |$)'], { encoding: 'utf8' }).trim().split('\n');
    return Number(pids[0]) || null;
  } catch {
    return null;
  }
}

const stamp = (d) => d.toISOString().replace(/[:.]/g, '-').replace('Z', '');

// Record `seconds` of Studio One's output. If the transport is stopped, it plays
// from the given position (or where the playhead is) and afterwards stops and puts
// the playhead back. The metronome click and precount are off while it plays and
// set back after, so they are not in the recording. Never records in Studio One.
export async function capture(call, { seconds, from_seconds, from_bars, out } = {}, deps = {}) {
  const {
    run = runJson, pid = studioPid, now = () => new Date(),
    bin = tapBin, py = python, cap = winCapture, platform = process.platform,
    rate = Number(process.env.STUDIO_ONE_MCP_CAPTURE_RATE) || 48000,
  } = deps;
  const win = platform === 'win32';
  if (!(seconds > 0 && seconds <= 600)) throw new Error('seconds must be more than 0 and at most 600');
  if (win) {
    if (!existsSync(py) || !existsSync(cap))
      throw new Error('the Windows capturer is not set up: run "npm run build:audio" in the fender-studio-mcp folder (creates audio/.venv with soundcard)');
  } else if (!existsSync(bin)) {
    throw new Error('s1tap is not built: run "npm run build:audio" in the fender-studio-mcp folder');
  }
  const p = pid();
  if (!p) throw new Error('Studio One is not running');
  const t = (await call('song')).transport;
  if (t.recording) throw new Error('Studio One is recording; capture leaves the transport alone');
  const file = out || join(capturesDir, `${stamp(now())}.wav`);
  mkdirSync(dirname(file), { recursive: true });
  const startsPlay = !t.playing;
  const home = t.position.seconds;
  let metro = null;
  let result;
  try {
    if (from_seconds !== undefined || from_bars !== undefined) await call('setTransport', { positionSeconds: from_seconds, positionBars: from_bars });
    if (startsPlay) {
      metro = await call('metronome', {});
      if (metro.click || metro.precount) await call('metronome', { click: false, precount: false });
      await call('transport', { action: 'play' });
    }
    const [cmd, args] = win
      ? [py, [cap, '--seconds', String(seconds), '--out', file, '--rate', String(rate)]]
      : [bin, ['--pid', String(p), '--seconds', String(seconds), '--out', file]];
    result = await run(cmd, args, (seconds + 15) * 1000);
  } finally {
    if (startsPlay) {
      await call('transport', { action: 'stop' }).catch(() => {});
      await call('setTransport', { positionSeconds: home }).catch(() => {});
      if (metro && (metro.click || metro.precount)) await call('metronome', { click: metro.click, precount: metro.precount }).catch(() => {});
    }
  }
  const final = {
    ...result,
    from: from_bars ?? from_seconds ?? home,
    transport: startsPlay ? 'played for the capture, then stopped; playhead put back' : 'was already playing; left playing',
  };
  // Windows loopback only hears the Windows audio engine. Near-silence after a
  // real playback usually means Studio One's output is on an exclusive ASIO
  // driver, which bypasses it.
  if (win && typeof result.peakDb === 'number' && result.peakDb <= -140) {
    final.recommend = 'bounce';
    final.warning =
      'Captured near-silence. If Studio One plays through an exclusive ASIO driver (e.g. a "Studio USB" interface) its output bypasses Windows loopback — set its Audio Device to a Windows Audio (WASAPI) driver, or live_bounce a track and audio_analyze that instead.';
  }
  return final;
}

// What capture backend this machine has, so the agent can choose capture vs
// bounce before trying. It cannot read Studio One's audio driver (not exposed to
// scripts), so on Windows "capture" is only a candidate: an exclusive ASIO output
// bypasses WASAPI loopback and a capture then comes back near-silent (recommend
// "bounce"). macOS taps the process directly and always hears it.
export async function audioCapabilities(deps = {}) {
  const { run = runJson, py = python, cap = winCapture, bin = tapBin, platform = process.platform } = deps;
  const win = platform === 'win32';
  if (!win) {
    const ready = existsSync(bin);
    return {
      platform,
      captureBackend: 'coreaudio-process-tap',
      ready,
      canCapture: ready,
      recommended: ready ? 'capture' : 'bounce',
      reason: ready
        ? 'macOS taps Studio One directly; capture hears the process output.'
        : 's1tap is not built (run "npm run build:audio"); use live_bounce + audio_analyze.',
    };
  }
  const ready = existsSync(py) && existsSync(cap);
  let endpoints = [];
  let defaultEndpoint = null;
  if (ready) {
    try {
      const r = await run(py, [cap, '--list'], 15000);
      endpoints = Array.isArray(r.loopbackEndpoints) ? r.loopbackEndpoints : [];
      defaultEndpoint = r.defaultSpeaker || null;
    } catch {
      /* leave endpoints empty */
    }
  }
  const canCapture = ready && endpoints.length > 0;
  return {
    platform,
    captureBackend: 'wasapi-loopback',
    ready,
    loopbackEndpoints: endpoints,
    defaultEndpoint,
    canCapture,
    recommended: canCapture ? 'capture' : 'bounce',
    reason: !ready
      ? 'the Windows capturer is not set up (run "npm run build:audio"); use live_bounce + audio_analyze.'
      : canCapture
        ? 'A WASAPI loopback endpoint exists, so try audio_capture — but it hears only the Windows audio engine; an exclusive ASIO output bypasses it and the capture comes back near-silent (then switch to live_bounce).'
        : 'No WASAPI loopback endpoint is available, so audio_capture cannot hear the output; use live_bounce + audio_analyze (or export a mixdown and audio_analyze it).',
    note: 'audio_capture returns peakDb and recommend:"bounce" when a capture is near-silent — use that to confirm the method at runtime.',
  };
}

// Measure a recording, optionally against a reference; writes a PNG next to it.
export async function analyze({ file, reference, sections, segment, plot = true } = {}, deps = {}) {
  const { run = runJson, py = python } = deps;
  if (!existsSync(py)) throw new Error('the analyzer is not set up: run "npm run build:audio" in the fender-studio-mcp folder');
  if (!existsSync(file)) throw new Error(`no such file: ${file}`);
  if (reference && !existsSync(reference)) throw new Error(`no such file: ${reference}`);
  const args = [analyzer, file];
  if (reference) args.push('--reference', reference);
  if (sections) args.push('--sections', JSON.stringify(sections));
  if (segment) args.push('--segment', String(segment));
  if (plot) args.push('--plot', file.replace(/\.wav$/i, '') + (reference ? '-vs-reference' : '') + '.png');
  return run(py, args, 300000);
}

// Bounce one track to a WAV and measure it, then undo the bounce so the song is
// left unchanged (the rendered WAV stays in the Bounces folder). This is the
// driver-independent way to measure audio: an offline render, so it works on
// Windows even when loopback capture can't hear the output. It is one track's
// audio with its own inserts, not the full stereo mix. keepBounce leaves the
// bounced event in the song.
export async function analyzeTrack(call, { track, mode = 'inPlace', reference, keepBounce = false, plot = true } = {}, deps = {}) {
  const { doBounce = bounce, doAnalyze = analyze } = deps;
  const b = await doBounce(call, { track, mode });
  if (!b.wav) {
    if (!keepBounce) await call('undo').catch(() => {});
    throw new Error('could not locate the rendered .wav (save the song to disk first). The bounce was undone.');
  }
  let analysis;
  try {
    analysis = await doAnalyze({ file: b.wav, reference, plot });
  } finally {
    if (!keepBounce) await call('undo').catch(() => {});
  }
  return { track, mode: b.mode, wav: b.wav, bounceUndone: !keepBounce, analysis };
}
