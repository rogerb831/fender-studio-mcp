// Where things live on this machine. Everything is overridable by env var so the
// server works for other Studio One versions and non-default song folders.
import { homedir, platform } from 'node:os';
import { join, delimiter } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

// Split a PATH-style env var on the platform's list separator (":" on POSIX,
// ";" on Windows). Splitting on ":" would shatter Windows paths at the drive
// colon ("C:\\Songs" -> ["C", "\\Songs"]).
const splitPaths = (s) => s.split(delimiter).filter(Boolean);

const home = homedir();
const isMac = platform() === 'darwin';

// Studio One's per-user profile ("Studio One 5", "Studio One 6", "Studio Pro 8"…).
export function studioOneProfiles() {
  if (process.env.STUDIO_ONE_PROFILE) return [process.env.STUDIO_ONE_PROFILE];
  const roots = isMac
    ? [join(home, 'Library/Application Support/PreSonus'), join(home, 'Library/Application Support/Fender')]
    : [join(process.env.APPDATA || join(home, 'AppData/Roaming'), 'PreSonus'), join(process.env.APPDATA || join(home, 'AppData/Roaming'), 'Fender')];
  const out = [];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    // withFileTypes so crash dumps like "Studio Pro_8_1_0_…Win x64_….dmp" that sit
    // next to the real "Studio Pro 8" profile dir and match the name regex are skipped.
    for (const d of readdirSync(r, { withFileTypes: true }))
      if (d.isDirectory() && /^Studio (One|Pro)/.test(d.name)) out.push(join(r, d.name));
  }
  return out.sort(byVersionDesc); // newest version first
}

// "Studio Pro 8" > "Studio One 6" > "Studio One 5": compare the version number in
// the folder name, not the whole path (…/Fender/… sorts before …/PreSonus/…).
function byVersionDesc(a, b) {
  const v = (p) => Number((p.match(/Studio (?:One|Pro)\D*(\d+)[^\\/]*$/) || [])[1] || 0);
  return v(b) - v(a) || b.localeCompare(a);
}

export function songRoots() {
  if (process.env.STUDIO_ONE_SONGS) return splitPaths(process.env.STUDIO_ONE_SONGS);
  return [join(home, 'Documents/Studio One/Songs'), join(home, 'Documents/Studio Pro/Songs')].filter(existsSync);
}

// Studio One installs (the folder holding Presets/ and PlugIns/), newest first.
export function studioOneApps() {
  if (process.env.STUDIO_ONE_APP) return [process.env.STUDIO_ONE_APP];
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const roots = isMac ? ['/Applications'] : [join(pf, 'PreSonus'), join(pf, 'Fender')];
  const out = [];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    for (const d of readdirSync(r, { withFileTypes: true }))
      if (d.isDirectory() && /^Studio (One|Pro)/.test(d.name)) out.push(isMac ? join(r, d.name, 'Contents') : join(r, d.name));
  }
  return out.sort(byVersionDesc);
}

// Where plug-in presets live: the user's own first, then the factory ones.
export function presetRoots() {
  if (process.env.STUDIO_ONE_PRESETS) return splitPaths(process.env.STUDIO_ONE_PRESETS);
  const user = [join(home, 'Documents/Studio One/Presets'), join(home, 'Documents/Studio Pro/Presets')];
  return [...user, ...studioOneApps().map((a) => join(a, 'Presets'))].filter(existsSync);
}

// Studio One's built-in remote-control map (surfacedata XML): curated parameter
// names for every PreSonus plug-in, keyed by plug-in class.
export function remoteMapFiles() {
  if (process.env.STUDIO_ONE_REMOTE_MAP) return splitPaths(process.env.STUDIO_ONE_REMOTE_MAP);
  // The Windows path is a guess (only the Mac layout has been seen); a miss just means fewer names.
  const rel = isMac ? 'PlugIns/remoteservice.bundle/Contents/Resources/device/remotedevice.surfacedata' : 'Plugins/remoteservice/device/remotedevice.surfacedata';
  return studioOneApps().map((a) => join(a, rel)).filter(existsSync);
}

export const dataDir = process.env.STUDIO_ONE_MCP_HOME || (isMac ? join(home, 'Library/Application Support/studio-one-mcp') : join(home, '.studio-one-mcp'));
export const mailboxDir = join(dataDir, 'mailbox');
