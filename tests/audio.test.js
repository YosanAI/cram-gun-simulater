import assert from 'node:assert/strict';
import test from 'node:test';
import { createSceneAudio, getDroneAcoustics, getExplosionAcoustics, prepareLoop, prepareExplosion, AUDIO_LIMITS } from '../src/audio.js';

class Param {
  constructor(value = 0) { this.value = value; this.targets = []; }
  setTargetAtTime(value, time, constant) { this.value = value; this.targets.push({ value, time, constant }); }
  cancelScheduledValues() {}
}
class Node {
  constructor() { this.connections = []; this.disconnected = false; }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.disconnected = true; }
}
class Context {
  constructor() { this.state = 'suspended'; this.currentTime = 0; this.sources = []; this.destination = new Node(); }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { length, numberOfChannels: channels, sampleRate, duration: length / sampleRate, getChannelData: channel => data[channel] };
  }
  createGain() { return Object.assign(new Node(), { gain: new Param() }); }
  createStereoPanner() { return Object.assign(new Node(), { pan: new Param() }); }
  createBiquadFilter() { return Object.assign(new Node(), { frequency: new Param() }); }
  createDynamicsCompressor() {
    return Object.assign(new Node(), Object.fromEntries(['threshold', 'knee', 'ratio', 'attack', 'release'].map(name => [name, new Param()])));
  }
  createBufferSource() {
    const context = this;
    const source = Object.assign(new Node(), {
      playbackRate: new Param(1),
      start(time, offset) { this.started = { time, offset }; },
      stop(time) { this.stopped = time; if (time <= context.currentTime) this.onended?.(); },
    });
    this.sources.push(source);
    return source;
  }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async close() { this.state = 'closed'; }
}

function samples(context) {
  const buffer = context.createBuffer(2, 5000, 1000);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 500; i < data.length; i++) data[i] = Math.sin(i * Math.PI / 25) * 0.6;
  }
  return Object.fromEntries(['gun', 'engine', 'airburst', 'impact', 'metal'].map(name => [name, buffer]));
}

function harness(t, overrides = {}) {
  const context = new Context();
  let created = 0;
  const handlers = new Map();
  const errors = [];
  const audio = createSceneAudio({
    createContext: () => { created++; return context; },
    loadBuffers: async () => samples(context),
    eventTarget: { addEventListener: (type, handler) => handlers.set(type, handler), removeEventListener: type => handlers.delete(type) },
    onError: error => errors.push(error), ...overrides,
  });
  t.after(() => audio.dispose());
  return { audio, context, handlers, errors, created: () => created };
}
const frame = (radarData = [], firing = false) => ({ firing, drive: 1, deltaTime: 0.05, radarData });
const target = (id, z) => ({ id, pos: { x: 0, y: 0, z }, distance: Math.abs(z) });
const gain = source => source.connections[0].connections[0].gain.value;
const bus = source => source.connections[0].connections[0].connections[0].connections[0];

test('drone distance controls gain and tone, with panning around the gun origin', () => {
  const near = getDroneAcoustics({ x: 0, y: 0, z: 8 });
  const middle = getDroneAcoustics({ x: 0, y: 0, z: 40 });
  const far = getDroneAcoustics({ x: 0, y: 0, z: 200 });
  assert.equal(near.gain, 1);
  assert.ok(near.gain > middle.gain && middle.gain > far.gain && far.gain > 0);
  assert.ok(near.cutoff > middle.cutoff && middle.cutoff > far.cutoff);
  assert.ok(getDroneAcoustics({ x: -10, y: 0, z: 10 }).pan < 0);
  assert.ok(getDroneAcoustics({ x: 10, y: 0, z: 10 }).pan > 0);
  assert.equal(getDroneAcoustics({ x: 0, y: 0, z: 0 }).gain, 1);
});

test('sample preparation skips silence, smooths loop seams and fades explosion tails', () => {
  const context = new Context();
  const input = samples(context).gun;
  const loop = prepareLoop(context, input, 0.65).getChannelData(0);
  assert.ok(loop.some(value => Math.abs(value) > 0.8));
  assert.ok(Math.abs(loop[0] - loop.at(-1)) < 0.15);
  const blast = prepareExplosion(context, input, 2.1);
  assert.equal(blast.duration, 2.1);
  assert.ok(Math.abs(blast.getChannelData(0).at(-1)) < 0.005);
});

test('power crossfades keep both correlated and uncorrelated loops at a steady level', () => {
  const context = new Context();
  const input = context.createBuffer(1, 4000, 1000);
  const data = input.getChannelData(0);
  data.fill(0.4);
  const correlated = prepareLoop(context, input, 1.2, 0.12).getChannelData(0);
  for (const value of correlated) assert.ok(Math.abs(value - 0.85) < 1e-6);

  let seed = 1234;
  for (let i = 0; i < data.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[i] = seed / 0xffffffff * 2 - 1;
  }
  const loop = prepareLoop(context, input, 1.2, 0.12).getChannelData(0);
  const power = values => values.reduce((sum, value) => sum + value * value, 0) / values.length;
  const ratio = power(loop.slice(0, 120)) / power(loop.slice(120));
  assert.ok(ratio > 0.8 && ratio < 1.2, 'the seam should not have the linear crossfade power dip');
});

test('audio waits for activation, changes an engine with distance, and bounds swarm voices', async t => {
  const h = harness(t);
  h.audio.update(frame([target(1, 100)]));
  assert.equal(h.created(), 0);
  assert.equal(h.context.sources.length, 0);
  assert.equal(await h.audio.unlock(), true);
  assert.equal(h.created(), 1);
  const engine = h.context.sources[0];
  const farGain = gain(engine);
  const farCutoff = engine.connections[0].frequency.value;
  h.audio.update(frame([target(1, 20)]));
  assert.equal(h.context.sources.length, 1);
  assert.ok(gain(engine) > farGain);
  assert.ok(engine.connections[0].frequency.value > farCutoff);
  assert.ok(engine.playbackRate.value > 1);
  h.audio.update(frame(Array.from({ length: 200 }, (_, i) => target(i + 1, i + 5))));
  assert.equal(h.audio.getState().engines, AUDIO_LIMITS.engines);
  h.audio.clearDrones();
  assert.equal(h.audio.getState().engines, 0);
  assert.ok(h.context.sources.every(source => source.disconnected));
  assert.deepEqual(h.errors, []);
});

test('the swarm mixes distinct engine sources and grows in volume without distant-count ducking', async t => {
  const h = harness(t);
  await h.audio.unlock();
  h.audio.update(frame([target(1, 8)]));
  const first = h.context.sources[0];
  const singlePower = gain(first) ** 2;
  const nearby = [target(1, 8), target(2, 8), target(3, 8), target(4, 8)];
  nearby[1].pos = { x: -8, y: 0, z: 0 };
  nearby[2].pos = { x: 8, y: 0, z: 0 };
  h.audio.update(frame(nearby));
  assert.equal(h.audio.getState().engines, 4);
  const engines = h.context.sources;
  assert.equal(new Set(engines.map(source => source.started.offset)).size, 4);
  assert.equal(new Set(engines.map(source => source.playbackRate.value)).size, 4);
  assert.ok(engines[1].connections[0].connections[0].connections[0].pan.value < 0);
  assert.ok(engines[2].connections[0].connections[0].connections[0].pan.value > 0);
  assert.ok(engines.every(source => bus(source) === bus(first)));
  assert.ok(engines.reduce((sum, source) => sum + gain(source) ** 2, 0) > singlePower * 3.5);

  const before = gain(first);
  h.audio.update(frame([target(1, 8), ...Array.from({ length: 23 }, (_, i) => target(i + 2, 200))]));
  assert.equal(h.audio.getState().engines, 24);
  assert.equal(gain(first), before, 'far engines should not reduce a close engine simply by increasing the count');
});

test('gun sound follows actual firing and mute/pause/disposal stop audio sources', async t => {
  const h = harness(t);
  await h.audio.unlock();
  h.audio.update(frame([], false));
  assert.equal(h.context.sources.length, 0);
  h.audio.update(frame([], true));
  assert.equal(h.context.sources.length, 1);
  assert.equal(h.context.sources[0].loop, true);
  assert.ok(Math.abs(h.context.sources[0].buffer.duration - 1.08) < 1e-9);
  assert.equal(gain(h.context.sources[0]), 0.22);
  assert.equal(h.context.sources[0].connections[0].frequency.value, 3200);
  h.audio.setEnabled(false);
  assert.ok(h.context.sources[0].disconnected);
  h.audio.update(frame([target(1, 20)], true));
  assert.equal(h.context.sources.length, 1);
  h.audio.setEnabled(true);
  await h.audio.unlock();
  h.audio.setPaused(true);
  assert.equal(h.context.state, 'suspended');
  assert.equal(h.audio.getState().engines, 0);
  assert.ok(h.context.sources.every(source => source.disconnected));
  h.audio.dispose(); h.audio.dispose();
  assert.equal(h.context.state, 'closed');
  assert.equal(h.handlers.size, 0);
  assert.equal(await h.audio.unlock(), false);
});

test('airbursts retain distance cues and audible gain at the far edge of gun range', async t => {
  const near = getExplosionAcoustics({ x: 0, y: 0, z: 8 }, 'airburst');
  const far = getExplosionAcoustics({ x: 100, y: 0, z: 200 }, 'airburst');
  assert.ok(far.gain >= near.gain * 0.7 && far.gain < near.gain);
  assert.ok(far.cutoff >= 5500);
  assert.ok(far.pan > 0);
  assert.ok(getExplosionAcoustics({ x: 0, y: 0, z: 200 }, 'impact').gain < 0.03);

  const h = harness(t);
  await h.audio.unlock();
  h.audio.update(frame([target(1, 20)], true));
  const gun = h.context.sources[0];
  const engine = h.context.sources[1];
  h.audio.playExplosion({ id: 2, kind: 'airburst', pos: { x: 100, y: 0, z: 200 } });
  const air = h.context.sources[2];
  assert.ok(gain(air) >= 0.63);
  assert.notEqual(bus(air), bus(gun));
  assert.notEqual(bus(air), bus(engine));
  assert.equal(bus(air).connections[0], bus(gun).connections[0]);
  assert.deepEqual(bus(gun).gain.targets.slice(-2).map(({ value, time }) => [value, time]), [[0.75, 0], [1, 0.25]]);
  assert.deepEqual(bus(engine).gain.targets.slice(-2).map(({ value, time }) => [value, time]), [[0.8, 0], [1, 0.25]]);
  assert.equal(gun.stopped, undefined);
  assert.equal(engine.stopped, undefined);
  h.audio.dispose();
  assert.ok([gun, engine, air].every(source => bus(source).disconnected));
});

test('airbursts stop engines and differ from impact blasts with metal debris', async t => {
  const h = harness(t);
  await h.audio.unlock();
  h.audio.update(frame([target(1, 20)]));
  h.audio.playExplosion({ id: 1, kind: 'airburst', pos: { x: 0, y: 0, z: 20 } });
  assert.equal(h.audio.getState().engines, 0);
  assert.ok(h.context.sources[0].disconnected);
  assert.equal(h.context.sources.length, 2);
  const air = h.context.sources[1];
  assert.equal(air.buffer.duration, 2.1);
  h.audio.playExplosion({ id: 2, kind: 'impact', pos: { x: 0, y: 0, z: 0 } });
  const impact = h.context.sources[2];
  const metal = h.context.sources[3];
  assert.equal(impact.buffer.duration, 3.3);
  assert.ok(impact.playbackRate.value < air.playbackRate.value);
  assert.ok(gain(impact) > gain(air));
  assert.equal(metal.buffer.duration, 0.9);
  assert.ok(metal.started.time > impact.started.time);
  for (let i = 0; i < 30; i++) h.audio.playExplosion({ id: i, kind: 'impact', pos: { x: 0, y: 0, z: 0 } });
  assert.equal(h.audio.getState().explosions, AUDIO_LIMITS.explosions);
  h.audio.clearDrones();
  assert.equal(h.audio.getState().explosions, 0);
  assert.ok(h.context.sources.every(source => source.disconnected));
});

test('unsupported audio and failed sample loading leave scene audio unavailable without throwing', async t => {
  const absent = harness(t, { createContext: () => null });
  assert.equal(await absent.audio.unlock(), false);
  assert.equal(absent.audio.getState().status, 'Unavailable');
  const failed = harness(t, { loadBuffers: async () => { throw new Error('sample failure'); } });
  assert.equal(await failed.audio.unlock(), false);
  assert.equal(failed.errors[0].message, 'sample failure');
  assert.equal(failed.context.sources.length, 0);
});

test('late audio activation cannot resurrect destroyed or cleared drone engines', async t => {
  let finishLoading;
  let loadingContext;
  const h = harness(t, { loadBuffers: context => {
    loadingContext = context;
    return new Promise(resolve => { finishLoading = resolve; });
  } });
  h.audio.update(frame([target(1, 20), target(2, 30)]));
  const activation = h.audio.unlock();
  h.audio.playExplosion({ id: 1, kind: 'airburst', pos: { x: 0, y: 0, z: 20 } });
  finishLoading(samples(loadingContext));
  assert.equal(await activation, true);
  assert.equal(h.audio.getState().engines, 1);
  assert.equal(h.audio.getState().explosions, 1);

  h.audio.update(frame([target(2, 30)]));
  h.audio.clearDrones();
  await h.audio.unlock();
  assert.equal(h.audio.getState().engines, 0);
  assert.equal(h.audio.getState().explosions, 0);
});

test('pause cancels cached firing and disposal during loading starts no voices', async t => {
  const h = harness(t);
  await h.audio.unlock();
  h.audio.update(frame([], true));
  h.audio.setPaused(true);
  const sourceCount = h.context.sources.length;
  h.audio.setPaused(false);
  await h.audio.unlock();
  assert.equal(h.context.sources.length, sourceCount);

  let finishLoading;
  let loadingContext;
  const delayed = harness(t, { loadBuffers: context => {
    loadingContext = context;
    return new Promise(resolve => { finishLoading = resolve; });
  } });
  delayed.audio.update(frame([target(1, 10)], true));
  const activation = delayed.audio.unlock();
  delayed.audio.dispose();
  finishLoading(samples(loadingContext));
  assert.equal(await activation, false);
  assert.equal(delayed.context.sources.length, 0);
  assert.equal(delayed.context.state, 'closed');
});
