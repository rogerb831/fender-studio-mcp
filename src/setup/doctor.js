// `fender-studio-mcp doctor`: check every link in the chain and say how to fix
// the first broken one. Read-only.
import { studioOneProfiles, songRoots, mailboxDir } from '../paths.js';
import { deviceStatus } from './device.js';
import {
  midiOutputs, pickMidiPort, studioOneRunning, claudeCodeAvailable, claudeCodeRegistered,
  desktopConfigPath, desktopRegistered, isMac, isWindows,
} from './checks.js';
import { bridgeStatus, call } from '../bridge.js';
import { audioCapabilities } from '../audio.js';

const PASS = 'pass';
const FAIL = 'fail';
const WARN = 'warn';
const INFO = 'info';

export async function runChecks({ profile, live = true } = {}) {
  const results = [];
  const add = (name, status, detail, fix) => results.push({ name, status, detail, fix });

  const major = Number(process.versions.node.split('.')[0]);
  add('Node.js', major >= 20 ? PASS : FAIL, process.versions.node, major >= 20 ? null : 'Install Node.js 20 or newer');

  const profiles = studioOneProfiles();
  const chosen = profile || profiles[0];
  add('Studio One profile', chosen ? PASS : FAIL, chosen || 'none found', chosen ? null : 'Run Studio One once, or pass --profile "<…/PreSonus/Studio One N>"');

  const roots = songRoots();
  add('Songs folder', roots.length ? PASS : WARN, roots.join(', ') || 'none found', roots.length ? null : 'Set STUDIO_ONE_SONGS to your Songs folder for the song_* tools');

  let editTasks = null;
  if (chosen) {
    const d = deviceStatus(chosen);
    editTasks = d.editTasks;
    const deviceStale = (d.stale || []).filter((s) => !d.editTasks.stale.includes(s));
    if (!d.installed) add('Bridge device installed', FAIL, 'not installed', 'Run: fender-studio-mcp setup');
    else if (deviceStale.length) add('Bridge device installed', WARN, `out of date (${deviceStale.join(', ')})`, 'Run: fender-studio-mcp setup (then restart Studio One)');
    else add('Bridge device installed', PASS, `live_eval ${d.config?.allowEval ? 'enabled' : 'disabled'}`, null);
    if (!editTasks.installed) add('Edit-task extension', FAIL, 'not installed (live_edit_notes needs it)', 'Run: fender-studio-mcp setup (then restart Studio One)');
    else if (!editTasks.current) add('Edit-task extension', WARN, `out of date (${editTasks.stale.join(', ')})`, 'Run: fender-studio-mcp setup (then restart Studio One)');
    else add('Edit-task extension', PASS, 'installed', null);
  }

  const midi = midiOutputs();
  const port = pickMidiPort(midi.names);
  if (!midi.ok) add('MIDI', FAIL, midi.error, 'Run npm install in the fender-studio-mcp folder');
  else if (!port && isMac && !process.env.STUDIO_ONE_MCP_MIDI_PORT)
    add('MIDI nudge port', PASS, 'no IAC bus; the server publishes its own port "studio-one-mcp" while it runs', null);
  else if (!port)
    // Not fatal: Studio Pro 8 drives the bridge from a surface timer, so the MIDI
    // doorbell is only a fallback (e.g. for Studio One 5/6, which have no timer).
    // Real breakage shows up as "Bridge answers" failing below.
    add('MIDI nudge port (fallback)', WARN, 'none found — the bridge runs on the Studio Pro 8 surface timer; MIDI is only a fallback', isMac
      ? 'Only if the bridge does not answer below: Audio MIDI Setup → IAC Driver → tick "Device is online"'
      : 'Only if the bridge does not answer below: install loopMIDI and add a port named "studio-one-mcp"');
  else add('MIDI nudge port', PASS, port, null);

  const running = studioOneRunning();
  add('Studio One running', running ? PASS : INFO, running ? 'yes' : 'no', running ? null : 'Start Studio One to use the live_* tools');

  if (live && running) {
    const s = bridgeStatus();
    if (!s.loaded)
      add('Bridge loaded in Studio One', FAIL, s.reason,
        'Studio One → Preferences… (Options on Windows) → External Devices → Add… → studio-one-mcp → MCP Bridge; Receive From: ' + (port || 'your virtual MIDI port'));
    else {
      try {
        const t0 = Date.now();
        await call('ping', {}, { timeoutMs: 2500 });
        add('Bridge answers', PASS, `ping ${Date.now() - t0} ms`, null);
        // Studio One loads extensions only at startup: installed is not the same as loaded.
        if (editTasks?.installed) {
          try {
            const cmds = await call('listCommands', { filter: 'MCP Edit' }, { timeoutMs: 5000 });
            const loaded = cmds.some((c) => c.category === 'Musical Functions' && c.name === 'MCP Edit');
            add('Edit task loaded', loaded ? PASS : WARN, loaded ? 'Musical Functions/MCP Edit' : 'not loaded yet', loaded ? null : 'Restart Studio One: it loads extensions only at startup');
          } catch (e) {
            add('Edit task loaded', WARN, `could not check: ${e.message}`, null);
          }
        }
      } catch (e) {
        add('Bridge answers', FAIL, e.message,
          `Check the MCP Bridge device's Receive From is "${port || 'the virtual MIDI port'}", then restart Studio One. A Scripting Error dialog left open can also block it.`);
      }
    }
  }

  // Audio: which capture method works here (for audio_capture / audio_analyze_track).
  try {
    const audio = await audioCapabilities();
    const eps = audio.loopbackEndpoints;
    if (!audio.ready)
      add('Audio capture', INFO, `${audio.captureBackend} not set up`, 'Optional: npm run build:audio (for audio_capture / audio_analyze / audio_analyze_track)');
    else if (audio.recommended === 'capture')
      add('Audio capture', PASS, `${audio.captureBackend}${eps && eps.length ? ` → ${eps.join(', ')}` : ''}`, null);
    else
      add('Audio capture', WARN, `${audio.captureBackend}: no loopback endpoint`, isWindows
        ? 'Loopback cannot hear an exclusive ASIO output — use audio_analyze_track (offline bounce), or set a Windows Audio driver'
        : 'Build the capturer: npm run build:audio');
  } catch (e) {
    add('Audio capture', INFO, `could not check: ${e.message}`, null);
  }

  const cc = claudeCodeAvailable();
  if (cc) add('Claude Code', claudeCodeRegistered() ? PASS : WARN, claudeCodeRegistered() ? 'studio-one registered' : 'not registered', claudeCodeRegistered() ? null : 'Run: fender-studio-mcp setup (or claude mcp add -s user studio-one -- node <path>/src/server.js)');
  const dp = desktopConfigPath();
  const dr = desktopRegistered(dp);
  add('Claude Desktop', dr ? PASS : INFO, dr ? 'studio-one registered' : 'not registered', dr ? null : 'Optional: fender-studio-mcp setup can add it to ' + dp);

  add('Mailbox', INFO, mailboxDir, null);
  return results;
}

const ICON = { [PASS]: '✔', [FAIL]: '✖', [WARN]: '!', [INFO]: '·' };

export function formatReport(results) {
  const width = Math.max(...results.map((r) => r.name.length));
  const lines = results.map((r) => {
    const line = `${ICON[r.status]} ${r.name.padEnd(width)}  ${r.detail ?? ''}`;
    return r.fix ? `${line}\n  ${' '.repeat(width)}  → ${r.fix}` : line;
  });
  const failed = results.filter((r) => r.status === FAIL).length;
  lines.push('', failed ? `${failed} problem(s) found.` : 'All good.');
  return lines.join('\n');
}

export async function doctor(opts) {
  const results = await runChecks(opts);
  console.log(formatReport(results));
  return results.some((r) => r.status === FAIL) ? 1 : 0;
}
