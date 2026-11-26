// Drive the Show page (live performance): setlist items, patches, players,
// playback mode and Perform. These are Studio One "Show" commands, so they run
// only when a Show document is open; otherwise the command reports not executed.

// action -> "Show" command name (one call each).
const DIRECT = {
  nextSetlistItem: 'Next Setlist Item',
  prevSetlistItem: 'Previous Setlist Item',
  loopSetlistItem: 'Loop Setlist Item',
  addSetlistItem: 'Add Setlist Item',
  removeSetlistItem: 'Remove Setlist Item',
  enableSetlistItem: 'Enable Setlist Item',
  disableSetlistItem: 'Disable Setlist Item',
  duplicateSetlistItem: 'Duplicate Setlist Item',
  nextPatch: 'Next Patch',
  prevPatch: 'Previous Patch',
  selectMutePatch: 'Select Mute Patch',
  nextPlayer: 'Next Player',
  prevPlayer: 'Previous Player',
  perform: 'Perform',
  playbackContinue: 'Set Playback Mode Continue',
  playbackStopAtEnd: 'Set Playback Mode Stop at End',
  playbackLoop: 'Set Playback Mode Loop',
};

// action -> "<prefix> N" (number 1..10).
const INDEXED = {
  selectSetlistItem: 'Select Setlist Item',
  selectPatch: 'Select Patch',
  selectPlayer: 'Select Player',
};

export const SHOW_ACTIONS = [...Object.keys(INDEXED), ...Object.keys(DIRECT)];

export async function show(call, { action, number } = {}) {
  let name;
  if (INDEXED[action]) {
    if (!(Number.isInteger(number) && number >= 1 && number <= 10))
      throw new Error(`${action} needs number 1..10 (the slot on the Show page)`);
    name = `${INDEXED[action]} ${number}`;
  } else if (DIRECT[action]) {
    name = DIRECT[action];
  } else {
    throw new Error(`action must be one of: ${SHOW_ACTIONS.join(', ')}`);
  }
  const r = await call('command', { category: 'Show', name });
  if (!r.executed)
    throw new Error(`Show/${name} did not run — open a Show (Song page → Show) and make sure that item/patch/player exists.`);
  return { action, command: name, executed: true };
}
