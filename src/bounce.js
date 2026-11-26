// Bounce a track's events, without dialogs. Seen on Studio One 5.5.2:
//  - Event/Bounce Selection (with ["Snap", ""], as a saved macro uses it) renders
//    the selected events into one new event in place;
//  - Event/Bounce To New Track renders them onto a new track (named like the
//    source) and mutes the originals;
//  - either is one undo step, and writes a .wav into the song's Bounces folder,
//    which an undo leaves on disk. The undo also re-selects the bounced track.
// Not in the live suite: every run would leave another .wav in the song folder.
// Both modes and their undo were checked by hand on 2026-09-28.
// Song/Export Mixdown, Export Stems and Event/Export Selection open dialogs, so
// they are not offered.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The raw "song" op returns fileUrl (a file:// URL); the live_song tool is what
// adds `file`. Resolve the path here so bounce works off the raw op too.
function songPath(song) {
  if (song.file) return song.file;
  if (!song.fileUrl) return null;
  try { return fileURLToPath(song.fileUrl); } catch { return null; }
}

const COMMANDS = { inPlace: ['Bounce Selection', ['Snap', '']], toNewTrack: ['Bounce To New Track', null] };

// Studio One renders the bounce into "<song folder>/Bounces/<name>.wav". The live
// event doesn't expose its media path, so find the newest .wav the bounce wrote.
function newestBounceWav(songFile, since = 0, { readdir = readdirSync, stat = statSync, exists = existsSync } = {}) {
  if (!songFile) return null;
  const dir = join(dirname(songFile), 'Bounces');
  if (!exists(dir)) return null;
  let best = null;
  let bestT = -Infinity;
  for (const f of readdir(dir)) {
    if (!/\.wav$/i.test(f)) continue;
    const p = join(dir, f);
    try {
      const t = stat(p).mtimeMs;
      if (t >= since && t > bestT) { bestT = t; best = p; }
    } catch { /* skip */ }
  }
  return best;
}

export async function bounce(call, { track, mode = 'inPlace' }, deps = {}) {
  if (!COMMANDS[mode]) throw new Error(`mode must be one of ${Object.keys(COMMANDS).join(', ')}`);
  const song0 = await call('song');
  if (song0.transport.playing || song0.transport.recording) throw new Error('stop playback first');
  const since = Date.now() - 3000; // the .wav the bounce is about to write, allowing clock/fs skew
  const before = await call('tracks', { events: false });
  const src = before.filter((t) => t.name === track);
  if (src.length !== 1) throw new Error(src.length ? `track name is ambiguous: ${track}` : `no track named ${track}`);
  const sel = await call('selectEvents', { track });
  let r;
  try {
    if (!sel.eventCommandsEnabled) throw new Error(`${track} has no events to bounce`);
    const [name, args] = COMMANDS[mode];
    r = await call('command', { category: 'Event', name, ...(args ? { args } : {}) });
    if (!r.executed) throw new Error(`Event/${name} did not run`);
  } finally {
    await call('selectEvents', { none: true }).catch(() => {});
    for (const [i, name] of song0.selectedTracks.entries()) await call('selectTrack', { name, exclusive: i === 0 }).catch(() => {});
  }
  const after = await call('tracks', { name: track });
  const wav = (deps.newestBounceWav || newestBounceWav)(songPath(song0), since);
  const note =
    (wav ? 'Pass wav to audio_analyze (it is the rendered track audio, not the full mix). ' : '') +
    'One live_undo reverts the edit (and re-selects this track); the rendered .wav stays in the song\'s Bounces folder.';
  if (mode === 'inPlace') return { track, mode, wav, events: after.find((t) => t.index === src[0].index)?.events ?? [], note };
  // The source name was unique, so the other track with that name is the new one.
  return {
    track, mode, wav,
    original: after.find((t) => t.index === src[0].index)?.events ?? [],
    newTrack: after.find((t) => t.index !== src[0].index && t.name === track) || null,
    note: `The originals are muted. ${note}`,
  };
}
