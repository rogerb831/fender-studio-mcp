// live_show command dispatch over a fake bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { show, SHOW_ACTIONS } from '../src/show.js';

test('indexed actions build "<name> N"; direct actions map 1:1', async () => {
  const calls = [];
  const call = async (op, a) => { calls.push([op, a]); return { executed: true }; };
  const r = await show(call, { action: 'selectSetlistItem', number: 3 });
  assert.deepEqual(calls.at(-1), ['command', { category: 'Show', name: 'Select Setlist Item 3' }]);
  assert.deepEqual([r.action, r.command, r.executed], ['selectSetlistItem', 'Select Setlist Item 3', true]);
  await show(call, { action: 'perform' });
  assert.deepEqual(calls.at(-1), ['command', { category: 'Show', name: 'Perform' }]);
  await show(call, { action: 'playbackLoop' });
  assert.deepEqual(calls.at(-1), ['command', { category: 'Show', name: 'Set Playback Mode Loop' }]);
});

test('validates the slot number and the action name', async () => {
  const call = async () => ({ executed: true });
  await assert.rejects(show(call, { action: 'selectPatch' }), /number 1\.\.10/);
  await assert.rejects(show(call, { action: 'selectPlayer', number: 11 }), /number 1\.\.10/);
  await assert.rejects(show(call, { action: 'nope' }), /action must be one of/);
});

test('a not-executed command (no Show open) is a clear error', async () => {
  await assert.rejects(show(async () => ({ executed: false }), { action: 'nextPatch' }), /open a Show/);
});

test('every advertised action is dispatchable', async () => {
  const call = async () => ({ executed: true });
  for (const action of SHOW_ACTIONS) {
    const needsNumber = /^select(Setlist|Patch|Player)/.test(action) && !/Mute/.test(action);
    await show(call, needsNumber ? { action, number: 1 } : { action });
  }
});
