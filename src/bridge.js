// Client side of the file mailbox (see device/StudioOneMCP/BridgeComponent.js).
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mailboxDir } from './paths.js';
import { nudge as midiNudge } from './midi.js';

const RENUDGE_MS = 150;

const readJson = (p) => {
  try {
    // Studio One's createTextFile writes a UTF-8 BOM.
    return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
};

// The bridge only runs when nudged, so status.json says whether it has loaded,
// not whether it is alive; call('ping') is the liveness check.
export function bridgeStatus(dir = mailboxDir) {
  const s = readJson(join(dir, 'status.json'));
  if (!s) return { loaded: false, reason: 'No status.json yet — is the MCP Bridge device added in Studio One (Studio One → Preferences / Options → External Devices)?' };
  if (s.closed) return { loaded: false, reason: 'Studio One closed the bridge (song or app closed).', ...s };
  return { loaded: true, ...s };
}

let queue = Promise.resolve();

// One request in flight at a time: the mailbox has a single slot.
export function call(op, args = {}, { timeoutMs = 5000, dir = mailboxDir, nudge = midiNudge } = {}) {
  const run = async () => {
    const status = bridgeStatus(dir);
    if (!status.loaded) throw new Error(`Studio One bridge not loaded: ${status.reason}`);
    mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    const tmp = join(dir, `request.${id}.tmp`);
    writeFileSync(tmp, JSON.stringify({ id, op, args }) + '\n');
    renameSync(tmp, join(dir, 'request.json'));
    const deadline = Date.now() + timeoutMs;
    let lastNudge = 0;
    let nudgeError = null;
    while (Date.now() < deadline) {
      if (Date.now() - lastNudge >= RENUDGE_MS) {
        // Best-effort: on Studio Pro 8 the device's own surface timer polls the
        // mailbox, so a missing MIDI loopback is not fatal — the response still
        // arrives within the timer interval. The nudge only speeds older Studio
        // One versions (5/6) that have no script timer.
        try { nudge(); } catch (e) { nudgeError = e; }
        lastNudge = Date.now();
      }
      await new Promise((r) => setTimeout(r, 20));
      const res = readJson(join(dir, 'response.json'));
      if (res && res.id === id) {
        if (!res.ok) throw new Error(`Studio One: ${res.error}`);
        return res.result;
      }
    }
    throw new Error(
      `Studio One did not answer "${op}" within ${timeoutMs}ms. Is it running, with a song open and the MCP Bridge device added?` +
        (nudgeError ? ` (MIDI nudge unavailable — ${nudgeError.message} — relying on the device's surface timer.)` : ''),
    );
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}
