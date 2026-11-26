// A channel's panner, through the live bridge. Read the panner type and its
// parameters, or set one by name. A stereo channel has a "Simple" panner with
// just "pan" (0..1); a surround or Dolby Atmos song gives a surround/object
// panner with more parameters, whose names depend on the type — so read first.
export async function panner(call, { channel, param, value, text, normalized } = {}) {
  if (!channel) throw new Error('channel is required (a track/channel name)');
  const setting = value !== undefined || text !== undefined || normalized !== undefined;
  return call('panner', setting
    ? { channel, set: true, param: param || 'pan', value, text, normalized }
    : { channel });
}
