// live_panner client: get vs set dispatch over a fake bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panner } from '../src/panner.js';

test('get: a plain read when no value/text/normalized is given', async () => {
  let got;
  const call = async (op, a) => ((got = [op, a]), { type: 'Simple', params: { pan: { value: 0.5 } } });
  const r = await panner(call, { channel: 'Vox' });
  assert.deepEqual(got, ['panner', { channel: 'Vox' }]);
  assert.equal(r.type, 'Simple');
});

test('set: value/text/normalized sends set=true with param defaulting to "pan"', async () => {
  const sent = [];
  const call = async (op, a) => (sent.push([op, a]), { channel: a.channel, param: a.param, after: {} });
  await panner(call, { channel: 'Vox', value: 0.25 });
  assert.deepEqual(sent.at(-1), ['panner', { channel: 'Vox', set: true, param: 'pan', value: 0.25, text: undefined, normalized: undefined }]);
  await panner(call, { channel: 'Vox', param: 'angle', text: 'L25' });
  assert.equal(sent.at(-1)[1].param, 'angle');
  assert.equal(sent.at(-1)[1].text, 'L25');
  await panner(call, { channel: 'Vox', normalized: 0.8 });
  assert.equal(sent.at(-1)[1].normalized, 0.8);
  assert.equal(sent.at(-1)[1].set, true);
});

test('channel is required', async () => {
  await assert.rejects(panner(async () => ({}), {}), /channel is required/);
});
