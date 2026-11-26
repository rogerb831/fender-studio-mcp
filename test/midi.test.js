// src/midi.js port selection. Runs in a child process per case because the
// module keeps its opened port for the life of the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const midiUrl = new URL('../src/midi.js', import.meta.url).href;
const tryPort = (port) =>
  execFileSync(process.execPath, ['--input-type=module', '-e', `import { nudge, midiPort } from ${JSON.stringify(midiUrl)}; try { nudge(); console.log('ok ' + midiPort()); } catch (e) { console.log('err ' + e.message); }`], {
    env: { ...process.env, STUDIO_ONE_MCP_MIDI_PORT: port },
    encoding: 'utf8',
  }).trim();

test('a port that does not exist gives setup instructions', () => {
  const out = tryPort('no-such-port-xyz');
  assert.match(out, /^err No MIDI output matching "no-such-port-xyz"/);
  assert.match(out, /IAC Driver/);
});

// The virtual-port fallback, on a private port name and data folder so it does
// not meet a real server: one process publishes the port, a second one relays
// its press through it, and the note comes out of that one port.
test('on macOS without an IAC bus, servers share one virtual port', { skip: process.platform !== 'darwin' }, async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const { createRequire } = await import('node:module');
  const midi = createRequire(import.meta.url)('@julusian/midi');
  const name = `s1mcp-test-${process.pid}`;
  const env = { ...process.env, STUDIO_ONE_MCP_MIDI_PORT: '', STUDIO_ONE_MCP_VIRTUAL_PORT: name, STUDIO_ONE_MCP_HOME: mkdtempSync(join(tmpdir(), 's1mcp-')) };
  const script = (keep) =>
    `import { ready, nudge, midiPort } from ${JSON.stringify(midiUrl)}; await ready(); console.log(midiPort()); ${keep ? 'setInterval(() => {}, 1000);' : 'nudge(); setTimeout(() => {}, 300);'}`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', script(true)], { env });
  try {
    const ownerPort = await new Promise((r) => owner.stdout.once('data', (d) => r(d.toString().trim())));
    if (/IAC/.test(ownerPort)) return; // an IAC bus is online here: no fallback to test
    assert.equal(ownerPort, `${name} (virtual)`);
    const input = new midi.Input();
    const index = [...Array(input.getPortCount()).keys()].find((i) => input.getPortName(i) === name);
    assert.notEqual(index, undefined, 'the virtual source is visible');
    const notes = [];
    input.on('message', (_, m) => notes.push(m));
    input.openPort(index);
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script(false)], { env, encoding: 'utf8' }).trim();
    assert.equal(out, `${name} (virtual, via another server)`);
    await new Promise((r) => setTimeout(r, 200));
    input.closePort();
    assert.deepEqual(notes, [[0x90, 119, 127], [0x90, 119, 0]]);
  } finally {
    owner.kill();
  }
});
