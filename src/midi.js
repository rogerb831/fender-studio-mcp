// The bridge's doorbell: a note press on the port the MCP Bridge device listens to.
// Studio One 5 gives scripts no usable timer, so the device only wakes up when a
// mapped control changes; each press toggles the component's bridgeTick param.
import { createRequire } from 'node:module';
import { createServer, connect } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.js';

const require = createRequire(import.meta.url);
const NOTE = 119; // must match <MidiMessage status="#90" address="#77"> in StudioOneMCP.surface.xml
const PORT = process.env.STUDIO_ONE_MCP_MIDI_PORT || 'IAC';
// With no IAC bus on macOS, the server publishes its own CoreMIDI source under
// this name while it runs; set the device's Receive From to it. Studio One
// reconnects by name when the source comes back (checked on Studio Pro 8.1.2).
export const VIRTUAL_PORT = process.env.STUDIO_ONE_MCP_VIRTUAL_PORT || 'studio-one-mcp';
const canVirtual = process.platform === 'darwin' && !process.env.STUDIO_ONE_MCP_MIDI_PORT;
const SOCKET = join(dataDir, 'doorbell.sock');

let mode = null; // 'port' (an existing bus) or 'virtual'
let output = null; // the MIDI output this process presses on
let relay = null; // in virtual mode without the port: a socket to the server that has it
let claiming = null;
let portName = null;

function loadMidi() {
  try {
    return require('@julusian/midi');
  } catch (e) {
    throw new Error(`MIDI unavailable (${e.message}). Run npm install in the fender-studio-mcp folder.`);
  }
}

function press(out) {
  out.sendMessage([0x90, NOTE, 127]); // press
  out.sendMessage([0x90, NOTE, 0]); // release
}

function open() {
  if (mode) return;
  const out = new (loadMidi().Output)();
  const names = [];
  for (let i = 0; i < out.getPortCount(); i++) names.push(out.getPortName(i));
  // Prefer an exact (case-insensitive) match, then fall back to substring. Without
  // the exact pass, PORT "SSL V-MIDI Port 1" would substring-match "…Port 10/11/12"
  // (enumerated first on Windows) and nudge the wrong bus.
  const want = PORT.toLowerCase();
  let index = names.findIndex((n) => n.toLowerCase() === want);
  if (index < 0) index = names.findIndex((n) => n.toLowerCase().includes(want));
  if (index >= 0) {
    out.openPort(index);
    output = out;
    portName = names[index];
    mode = 'port';
    return;
  }
  out.closePort?.();
  if (!canVirtual) {
    throw new Error(
      `No MIDI output matching "${PORT}" (found: ${names.join(', ') || 'none'}). ` +
        'On macOS enable Audio MIDI Setup → IAC Driver → "Device is online", and set the MCP Bridge ' +
        "device's Receive From to that bus. Override with STUDIO_ONE_MCP_MIDI_PORT.",
    );
  }
  mode = 'virtual';
  claim();
}

// Several servers can run at once (Claude sessions, doctor), but Studio One
// listens to only one source of that name. So one server publishes the port and
// takes the others' presses over a Unix socket; when it exits, the next server
// to press takes over. (Two servers starting in the same instant can both end
// up publishing; the next restart of either sorts it out.)
function claim() {
  if (claiming) return claiming;
  claiming = new Promise((resolve) => {
    const sock = connect(SOCKET);
    let connected = false;
    sock.on('error', () => {});
    sock.once('connect', () => {
      connected = true;
      sock.unref();
      relay = sock;
      portName = `${VIRTUAL_PORT} (virtual, via another server)`;
      resolve();
    });
    sock.once('close', () => {
      if (connected) {
        // The owner went away: the next nudge claims again.
        if (relay === sock) relay = null;
        claiming = null;
      } else {
        own(resolve);
      }
    });
  });
  return claiming;
}

function own(done) {
  const server = createServer((c) => {
    c.on('error', () => {});
    c.on('data', (buf) => {
      for (let i = 0; i < buf.length; i++) press(output);
    });
  });
  server.on('error', () => {
    // Someone else got there first: relay to them instead.
    claiming = null;
    claim().then(done);
  });
  mkdirSync(dataDir, { recursive: true });
  rmSync(SOCKET, { force: true }); // stale: nobody answered on it
  server.listen(SOCKET, () => {
    server.unref();
    const out = new (loadMidi().Output)();
    out.openVirtualPort(VIRTUAL_PORT);
    output = out;
    portName = `${VIRTUAL_PORT} (virtual)`;
    process.once('exit', () => rmSync(SOCKET, { force: true }));
    done();
  });
}

export function nudge() {
  open();
  if (output) press(output);
  else if (relay) relay.write('n');
  else claim(); // still connecting, or the owner just left; the caller presses again
}

export const midiPort = () => portName;

// Open the port now rather than on the first call, so a virtual source is
// already there for Studio One to find. Errors wait for the first call.
export function openEarly() {
  try {
    open();
  } catch {
    /* reported by nudge() */
  }
}

// Resolves once the virtual port is published or relayed (tests, doctor).
export async function ready() {
  openEarly();
  await claiming;
}
