const FILES = Object.freeze({
  gun: 'phalanx.mp3', engine: 'drone-engine.mp3',
  airburst: 'airburst.mp3', impact: 'impact.mp3', metal: 'metal-crash.mp3',
});
export const AUDIO_LIMITS = Object.freeze({ engines: 24, explosions: 16, referenceDistance: 8, rolloff: 1.6 });
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Listener stays at the gun pivot, facing +Z, independently of the camera. */
export function getDroneAcoustics(pos) {
  const distance = Math.hypot(pos.x, pos.y, pos.z);
  return {
    distance,
    gain: AUDIO_LIMITS.referenceDistance / (AUDIO_LIMITS.referenceDistance + AUDIO_LIMITS.rolloff * Math.max(0, distance - AUDIO_LIMITS.referenceDistance)),
    pan: clamp(pos.x / Math.max(1, distance), -0.85, 0.85),
    cutoff: 1000 + 6500 / (1 + distance / 35),
  };
}

function mono(buffer) {
  const data = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const input = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) data[i] += input[i] / buffer.numberOfChannels;
  }
  return data;
}

function normalizedBuffer(context, samples, sampleRate) {
  const peak = samples.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  const buffer = context.createBuffer(1, samples.length, sampleRate);
  const output = buffer.getChannelData(0);
  const scale = peak > 0 ? 0.85 / peak : 1;
  for (let i = 0; i < output.length; i++) output[i] = samples[i] * scale;
  return buffer;
}

/** Find a sustained section, avoiding silence/startup, and crossfade its seam. */
export function prepareLoop(context, input, seconds) {
  const samples = mono(input);
  const size = Math.min(samples.length, Math.floor(seconds * input.sampleRate));
  const step = Math.max(1, Math.floor(input.sampleRate * 0.05));
  const energy = [];
  for (let start = 0; start < samples.length; start += step) {
    let sum = 0;
    const end = Math.min(samples.length, start + step);
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    energy.push(sum / (end - start));
  }
  let best = 0;
  let score = -Infinity;
  for (let start = 0; start + size <= samples.length; start += step) {
    const windows = energy.slice(start / step, Math.ceil((start + size) / step));
    const mean = windows.reduce((sum, value) => sum + value, 0) / windows.length;
    const candidate = Math.min(...windows) * 0.7 + mean * 0.3;
    if (candidate > score) { score = candidate; best = start; }
  }
  const fade = Math.min(Math.floor(input.sampleRate * 0.035), Math.floor(size / 4));
  const loop = samples.slice(best, best + size - fade);
  for (let i = 0; i < fade; i++) {
    const mix = i / fade;
    loop[i] = samples[best + size - fade + i] * (1 - mix) + loop[i] * mix;
  }
  return normalizedBuffer(context, loop, input.sampleRate);
}

/** Keep the first detonation and its decay, omitting pauses or later blasts. */
export function prepareExplosion(context, input, seconds) {
  const samples = mono(input);
  const peak = samples.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  const onset = samples.findIndex(value => Math.abs(value) > peak * 0.08);
  const start = Math.max(0, onset - Math.floor(input.sampleRate * 0.008));
  const clip = samples.slice(start, start + Math.floor(seconds * input.sampleRate));
  const fade = Math.min(Math.floor(input.sampleRate * 0.25), Math.floor(clip.length / 3));
  for (let i = 0; i < fade; i++) clip[clip.length - fade + i] *= 1 - i / fade;
  return normalizedBuffer(context, clip, input.sampleRate);
}

function fetchSamples() {
  const base = import.meta.env?.BASE_URL || '/';
  return Promise.all(Object.entries(FILES).map(async ([name, filename]) => {
    const response = await fetch(base + 'audio/' + filename);
    if (!response.ok) throw new Error('Could not load sound: ' + filename);
    return [name, await response.arrayBuffer()];
  }));
}

/** One shared Web Audio mixer for firing, engines, and classified explosions. */
export function createSceneAudio({
  createContext = () => {
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    return AudioContext ? new AudioContext() : null;
  },
  loadBuffers,
  eventTarget = globalThis.document,
  onError = error => console.warn('Scene audio:', error),
} = {}) {
  // Fetch before the first gesture; decoding/resume still happen on activation.
  const bytes = loadBuffers ? null : fetchSamples().then(value => ({ value }), error => ({ error }));
  const engines = new Map();
  const bursts = new Set();
  const voices = new Set();
  const pending = [];
  let context;
  let master;
  let compressor;
  let buffers;
  let loading;
  let gun;
  let enabled = true;
  let volume = 0.65;
  let paused = false;
  let disposed = false;
  let failed = false;
  let lastFrame = { firing: false, drive: 0, radarData: [], deltaTime: 0 };
  const canPlay = () => !disposed && !failed && enabled && !paused && buffers && context?.state === 'running';

  function stopVoice(voice, immediate = false) {
    if (!voice || voice.cleaned || (voice.stopped && !immediate)) return;
    voice.stopped = true;
    const now = context.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setTargetAtTime(0, now, 0.012);
    try { voice.source.stop(immediate ? now : now + 0.08); } catch { /* Already ended. */ }
    if (immediate) voice.cleanup();
  }

  function voice(buffer, { loop = false, gain = 0, pan = 0, cutoff = 16000, rate = 1, offset = 0, delay = 0, onEnded } = {}) {
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const amplitude = context.createGain();
    const panner = context.createStereoPanner();
    source.buffer = buffer;
    source.loop = loop;
    source.playbackRate.value = rate;
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    amplitude.gain.value = gain;
    panner.pan.value = pan;
    source.connect(filter).connect(amplitude).connect(panner).connect(master);
    const result = { source, filter, gain: amplitude, panner, stopped: false, cleaned: false,
      cleanup() {
        if (result.cleaned) return;
        result.cleaned = true;
        for (const node of [source, filter, amplitude, panner]) node.disconnect();
        voices.delete(result);
        onEnded?.();
      },
    };
    source.onended = result.cleanup;
    voices.add(result);
    source.start(context.currentTime + delay, offset);
    return result;
  }

  function clearDrones() {
    lastFrame = { ...lastFrame, radarData: [] };
    for (const engine of engines.values()) stopVoice(engine, true);
    engines.clear();
    for (const burst of [...bursts]) { stopVoice(burst.main, true); stopVoice(burst.metal, true); }
    bursts.clear();
    pending.length = 0;
  }

  function stopFiring() {
    stopVoice(gun); gun = null;
    lastFrame = { ...lastFrame, firing: false, drive: 0 };
  }
  function silence() {
    stopFiring();
    clearDrones();
    for (const active of [...voices]) stopVoice(active, true);
  }

  function update(frame) {
    lastFrame = frame;
    if (!canPlay()) return;
    const now = context.currentTime;
    if (frame.firing && frame.drive > 0.01) {
      if (!gun) gun = voice(buffers.gun, { loop: true });
      gun.gain.gain.setTargetAtTime(0.45 * (0.55 + 0.45 * frame.drive), now, 0.015);
    } else stopFiring();
    const audible = frame.radarData.map(target => ({ target, ...getDroneAcoustics(target.pos) }))
      .sort((a, b) => a.distance - b.distance).slice(0, AUDIO_LIMITS.engines);
    const liveIds = new Set(audible.map(item => item.target.id));
    for (const [id, engine] of engines) if (!liveIds.has(id)) { stopVoice(engine); engines.delete(id); }
    const mix = 1 / Math.sqrt(Math.max(1, audible.length));
    for (const item of audible) {
      const id = item.target.id;
      let engine = engines.get(id);
      if (!engine) {
        engine = voice(buffers.engine, { loop: true, offset: ((id * 0.61803398875) % 1) * buffers.engine.duration });
        engine.baseRate = 0.97 + (id % 7) * 0.01;
        engine.distance = item.distance;
        engines.set(id, engine);
      }
      const closingSpeed = frame.deltaTime > 0 ? (engine.distance - item.distance) / frame.deltaTime : 0;
      const doppler = clamp(343 / (343 - clamp(closingSpeed, -30, 30)), 0.9, 1.1);
      engine.source.playbackRate.setTargetAtTime(engine.baseRate * doppler, now, 0.1);
      engine.gain.gain.setTargetAtTime(0.5 * mix * item.gain, now, 0.04);
      engine.filter.frequency.setTargetAtTime(item.cutoff, now, 0.07);
      engine.panner.pan.setTargetAtTime(item.pan, now, 0.05);
      engine.distance = item.distance;
    }
  }

  function playExplosion(event) {
    // An activation/loading completion must not restart a destroyed engine.
    lastFrame = { ...lastFrame, radarData: lastFrame.radarData.filter(target => target.id !== event.id) };
    const engine = engines.get(event.id);
    if (engine) { stopVoice(engine, true); engines.delete(event.id); }
    if (!canPlay()) {
      if (!disposed && enabled && !paused && loading && !buffers) {
        if (pending.length === AUDIO_LIMITS.explosions) pending.shift();
        pending.push({ event, time: Date.now() });
      }
      return;
    }
    if (bursts.size >= AUDIO_LIMITS.explosions) {
      const oldest = bursts.values().next().value;
      stopVoice(oldest.main, true); stopVoice(oldest.metal, true);
    }
    const spatial = getDroneAcoustics(event.pos);
    const impact = event.kind === 'impact';
    const burst = {};
    burst.main = voice(impact ? buffers.impact : buffers.airburst, {
      gain: spatial.gain * (impact ? 0.95 : 0.8), pan: spatial.pan,
      cutoff: Math.min(spatial.cutoff, impact ? 3600 : 10000), rate: impact ? 0.88 : 1.04,
      onEnded() { bursts.delete(burst); stopVoice(burst.metal, true); },
    });
    if (impact) burst.metal = voice(buffers.metal, { gain: 0.48 * spatial.gain, pan: spatial.pan, delay: 0.018 });
    bursts.add(burst);
  }

  async function unlock() {
    if (disposed || !enabled || paused || failed) return false;
    try {
      if (!context) {
        context = createContext();
        if (!context) { failed = true; return false; }
        master = context.createGain();
        master.gain.value = volume;
        compressor = context.createDynamicsCompressor();
        compressor.threshold.value = -8;
        compressor.knee.value = 6;
        compressor.ratio.value = 12;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.16;
        master.connect(compressor).connect(context.destination);
        loading = (async () => {
          let decoded;
          if (loadBuffers) decoded = await loadBuffers(context);
          else {
            const fetched = await bytes;
            if (fetched.error) throw fetched.error;
            const entries = await Promise.all(fetched.value.map(async ([name, data]) => [name, await context.decodeAudioData(data)]));
            decoded = Object.fromEntries(entries);
          }
          if (disposed) return;
          buffers = {
            gun: prepareLoop(context, decoded.gun, 0.65),
            engine: prepareLoop(context, decoded.engine, 2.5),
            airburst: prepareExplosion(context, decoded.airburst, 2.1),
            impact: prepareExplosion(context, decoded.impact, 3.3),
            metal: prepareExplosion(context, decoded.metal, 0.9),
          };
        })();
      }
      // Call resume synchronously from the gesture, before awaiting downloads.
      await Promise.all([context.state === 'running' ? undefined : context.resume(), loading]);
      if (!canPlay()) return false;
      update(lastFrame);
      for (const item of pending.splice(0)) if (Date.now() - item.time < 1500) playExplosion(item.event);
      return true;
    } catch (error) {
      if (!disposed) { failed = true; silence(); onError(error); }
      return false;
    }
  }

  const activate = () => { void unlock(); };
  eventTarget?.addEventListener('pointerdown', activate, { passive: true });
  eventTarget?.addEventListener('keydown', activate);
  return {
    update, playExplosion, clearDrones, stopFiring, unlock,
    setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) silence();
      else void unlock();
    },
    setVolume(value) {
      if (!Number.isFinite(value)) return;
      volume = clamp(value, 0, 1);
      if (master) master.gain.setTargetAtTime(volume, context.currentTime, 0.025);
    },
    setPaused(value) {
      paused = Boolean(value);
      if (paused) {
        silence();
        if (context?.state === 'running') void context.suspend().catch(() => {});
      } else void unlock();
    },
    getState: () => ({
      enabled, volume, ready: Boolean(buffers), engines: engines.size, explosions: bursts.size,
      status: failed ? 'Unavailable' : !enabled ? 'Muted' : paused ? 'Paused' : canPlay() ? 'Ready' : loading && !buffers ? 'Loading sounds…' : 'Click / tap to start',
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      silence();
      eventTarget?.removeEventListener('pointerdown', activate);
      eventTarget?.removeEventListener('keydown', activate);
      master?.disconnect(); compressor?.disconnect();
      if (context) void context.close().catch(() => {});
    },
  };
}
