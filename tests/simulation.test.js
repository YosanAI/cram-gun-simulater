import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { DEFAULT_CODE, createSimulationRunner } from '../src/simulation.js';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
import { createGunSandbox } from '../src/gun-sandbox.js';
import { SANDBOX_LIMITS } from '../src/sandbox-limits.js';

const waitFor = async predicate => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Sandbox test timed out.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

function createHarness(t, { api: suppliedApi, ...overrides } = {}) {
  const calls = [];
  const errors = [];
  const phases = [];
  const workers = [];
  const api = suppliedApi || {
    setAzimuth: rad => calls.push(['azimuth', rad]),
    setAltitude: rad => calls.push(['altitude', rad]),
    getCurrentAzimuth: () => 1.2,
    getCurrentAltitude: () => 0.4,
    fire: () => calls.push(['fire']),
  };
  const createWorker = () => {
    const thread = new Worker(new URL('../test-support/sandbox-worker.mjs', import.meta.url), { execArgv: [] });
    workers.push(thread);
    const adapter = {
      postMessage: data => thread.postMessage(data),
      terminate: () => { void thread.terminate(); },
    };
    thread.on('message', data => adapter.onmessage?.({ data }));
    thread.on('error', error => adapter.onerror?.({ message: error.message }));
    return adapter;
  };
  const runner = createSimulationRunner(api, {
    createWorker,
    onStateChange: (_, phase) => phases.push(phase),
    onError: error => errors.push(error),
    ...overrides,
  });
  t.after(async () => {
    runner.stop();
    await Promise.all(workers.map(worker => worker.terminate()));
  });
  return {
    runner, calls, errors, phases,
    async run(source) {
      const startingErrors = errors.length;
      runner.run(source);
      await waitFor(() => phases.at(-1) === 'running' || errors.length > startingErrors);
      return errors.length === startingErrors;
    },
    async step(delta, radarData) {
      const time = runner.getTime();
      runner.tick(delta, radarData);
      await waitFor(() => runner.getTime() > time || !runner.isRunning());
    },
  };
}

test('the empty template runs in a real worker and idle frames execute no code', async t => {
  const h = createHarness(t);
  h.runner.tick(0.02);
  assert.equal(h.runner.getTime(), 0);
  assert.equal(await h.run(DEFAULT_CODE), true);
  await h.step(0.02);
  assert.equal(h.runner.getTime(), 0.02);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.errors, []);
});

test('frame timing and all five gun functions pass through the isolated API bridge', async t => {
  const h = createHarness(t);
  assert.equal(await h.run('function updateGun(t, dt) { setAzimuth(getCurrentAzimuth()+t); setAltitude(getCurrentAltitude()+dt); fire(); }'), true);
  await h.step(0.02);
  await h.step(0.03);
  assert.deepEqual(h.calls.map(call => call[0]), ['azimuth', 'altitude', 'fire', 'azimuth', 'altitude', 'fire']);
  for (const [index, expected] of [[0, 1.2], [1, 0.42], [3, 1.22], [4, 0.43]]) {
    assert.ok(Math.abs(h.calls[index][1] - expected) < 1e-12);
  }
  assert.equal(h.runner.getTime(), 0.05);
});

test('the third callback parameter delivers fresh radar data through the real worker without host mutation', async t => {
  const h = createHarness(t);
  const radarData = [{ id: 7, pos: { x: 3, y: 4, z: 12 }, distance: 13 }];
  await h.run(`
    let previous;
    JSON.parse = () => { throw new Error("User parser must not affect the bridge"); };
    function updateGun(time, delta, radarData) {
      if (!Array.isArray(radarData)) throw new Error("Expected target array");
      if (radarData.length) {
        if (previous && radarData === previous) throw new Error("Expected fresh snapshot");
        setAzimuth(radarData[0].id);
        setAltitude(radarData[0].pos.y);
        setAzimuth(radarData[0].distance);
        previous = radarData;
        radarData[0].pos.y = 999;
        radarData.pop();
      } else {
        fire();
      }
    }
  `);
  await h.step(0.02, radarData);
  await h.step(0.02, radarData);
  await h.step(0.02, []);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.calls, [
    ['azimuth', 7], ['altitude', 4], ['azimuth', 13],
    ['azimuth', 7], ['altitude', 4], ['azimuth', 13], ['fire'],
  ]);
  assert.deepEqual(radarData, [{ id: 7, pos: { x: 3, y: 4, z: 12 }, distance: 13 }]);
});

test('Stop discards execution and restarting resets the clock and callback closure', async t => {
  const h = createHarness(t);
  const source = 'let count=0; function updateGun(t) { setAzimuth(++count); setAltitude(t); }';
  await h.run(source);
  await h.step(0.02);
  await h.step(0.03);
  h.runner.stop();
  h.runner.tick(10);
  assert.equal(h.calls.length, 4);
  assert.equal(h.runner.isRunning(), false);
  await h.run(source);
  await h.step(0.01);
  assert.deepEqual(h.calls, [
    ['azimuth', 1], ['altitude', 0],
    ['azimuth', 2], ['altitude', 0.02],
    ['azimuth', 1], ['altitude', 0],
  ]);
});

test('syntax errors are reported and corrected scripts can restart', async t => {
  const h = createHarness(t);
  assert.equal(await h.run('function updateGun(t, dt) {'), false);
  assert.equal(h.errors[0].name, 'SyntaxError');
  assert.equal(h.runner.isRunning(), false);
  assert.equal(await h.run('function updateGun() { fire(); }'), true);
  await h.step(0.02);
  assert.deepEqual(h.calls, [['fire']]);
});

test('missing, non-function, async, and generator callbacks are rejected', async t => {
  const h = createHarness(t);
  for (const source of [
    'const unrelated = 1;', 'const updateGun = 42;',
    'async function updateGun() { fire(); }',
    'function* updateGun() { fire(); }',
  ]) {
    assert.equal(await h.run(source), false);
    assert.equal(h.errors.at(-1).name, 'TypeError');
    assert.equal(h.runner.isRunning(), false);
  }
  assert.deepEqual(h.calls, []);
});

test('runtime errors include the editor line and discard the entire failed command batch', async t => {
  let cleanup = 0;
  const h = createHarness(t, { onStop: () => cleanup++ });
  await h.run('function updateGun() {\n  fire();\n  throw new Error("test fault");\n}');
  const before = cleanup;
  await h.step(0.02);
  assert.equal(h.errors[0].message, 'test fault');
  assert.equal(h.errors[0].line, 3);
  assert.equal(h.runner.isRunning(), false);
  assert.equal(cleanup, before + 1);
  assert.deepEqual(h.calls, []);
});

test('thrown primitives and invalid angle arguments display errors', async t => {
  const h = createHarness(t);
  for (const [body, expected] of [
    ['throw "string fault";', /string fault/],
    ['throw null;', /null/],
    ['setAzimuth(NaN);', /finite number/],
    ['setAltitude("1");', /finite number/],
  ]) {
    await h.run('function updateGun() { ' + body + ' }');
    await h.step(0.02);
    assert.match(h.errors.at(-1).message, expected);
    assert.equal(h.runner.isRunning(), false);
  }
});

test('infinite loops during compilation or a frame are interrupted without blocking the host', async t => {
  const h = createHarness(t);
  assert.equal(await h.run('while (true) {} function updateGun() {}'), false);
  assert.equal(h.errors.at(-1).name, 'TimeoutError');
  assert.equal(await h.run('function updateGun() { while (true) {} }'), true);
  let heartbeat = false;
  setTimeout(() => { heartbeat = true; }, 0);
  await h.step(0.02);
  assert.equal(heartbeat, true);
  assert.equal(h.errors.at(-1).name, 'TimeoutError');
  assert.equal(h.runner.isRunning(), false);
  assert.equal(await h.run('function updateGun() { fire(); }'), true);
  await h.step(0.02);
  assert.deepEqual(h.calls, [['fire']]);
});

test('the VM cannot access browser or Node globals, even through function constructors', async t => {
  const h = createHarness(t);
  await h.run(`
    function updateGun() {
      const root = setAzimuth.constructor("return globalThis")();
      for (const key of ["window","document","fetch","XMLHttpRequest","WebSocket","localStorage","indexedDB","postMessage","Worker","process","require","setTimeout"]) {
        if (typeof root[key] !== "undefined") throw new Error("Host leak: " + key);
      }
      Object.prototype.sandboxPollution = true;
      fire();
    }
  `);
  await h.step(0.02);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.calls, [['fire']]);
  assert.equal({}.sandboxPollution, undefined);
});

test('excessive commands and asynchronous return values stop the sandbox', async t => {
  const h = createHarness(t);
  for (const [body, expected] of [
    ['for (let i=0;i<200;i++) fire();', /Too many gun commands/],
    ['return Promise.reject(new Error("async fault"));', /must not return a Promise/],
  ]) {
    await h.run('function updateGun() { ' + body + ' }');
    await h.step(0.02);
    assert.match(h.errors.at(-1).message, expected);
    assert.equal(h.runner.isRunning(), false);
  }
  assert.deepEqual(h.calls, []);
});

test('script commands reach the actual gun API and Stop cancels firing', async t => {
  const api = await import('../src/api.js?worker-integration');
  const h = createHarness(t, { api, onStop: api.stopFiring });
  assert.equal(await h.run('function updateGun() { setAzimuth(Math.PI/2); setAltitude(Math.PI/6); fire(); }'), true);
  await h.step(0.02);
  assert.equal(api.advanceMotion(0.02).firing, true);
  assert.ok(api.getCurrentAzimuth() > 0);
  h.runner.stop();
  assert.equal(api.advanceMotion(0.02).firing, false);
  assert.equal(h.errors.length, 0);
});

test('the guest heap limit rejects oversized allocations', async t => {
  const QuickJS = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
  const sandbox = createGunSandbox(
    QuickJS,
    'function updateGun() { const large = "x".repeat(8 * 1024 * 1024); }',
    { azimuth: 0, altitude: 0 },
    { ...SANDBOX_LIMITS, memoryBytes: 1024 * 1024, executionMs: 500 },
  );
  t.after(() => sandbox.dispose());
  assert.throws(() => sandbox.tick(0, 0.02, { azimuth: 0, altitude: 0 }), /memory/i);
});

test('source and error payloads are bounded before they reach the UI', async t => {
  const h = createHarness(t);
  assert.equal(await h.run(' '.repeat(SANDBOX_LIMITS.sourceLength + 1)), false);
  assert.equal(h.errors[0].name, 'RangeError');
  await h.run('function updateGun() { throw "x".repeat(10000); }');
  await h.step(0.02);
  assert.equal(h.errors.at(-1).message.length, 2000);
});

test('a frame watchdog terminates a worker that never completes its callback', async t => {
  let instance;
  let terminated = 0;
  const h = createHarness(t, {
    createWorker: () => (instance = { postMessage() {}, terminate() { terminated++; } }),
    responseTimeoutMs: 20,
  });
  h.runner.run(DEFAULT_CODE);
  instance.onmessage({ data: { type: 'ready' } });
  await h.step(0.02);
  assert.equal(h.errors[0].name, 'TimeoutError');
  assert.equal(terminated, 1);
});

test('slow callbacks do not queue frames and their next step receives accumulated time', t => {
  let instance;
  const messages = [];
  const h = createHarness(t, {
    createWorker: () => (instance = { postMessage(data) { messages.push(data); }, terminate() {} }),
  });
  h.runner.run(DEFAULT_CODE);
  instance.onmessage({ data: { type: 'ready' } });
  h.runner.tick(0.02);
  h.runner.tick(0.03, [{ id: 1, pos: { x: 0, y: 0, z: 10 }, distance: 10 }]);
  assert.equal(messages.length, 2);
  instance.onmessage({ data: { type: 'frame', id: 1, commands: [] } });
  const latestTargets = [{ id: 2, pos: { x: 0, y: 0, z: 8 }, distance: 8 }];
  h.runner.tick(0.01, latestTargets);
  assert.equal(messages[2].elapsedTime, 0.02);
  assert.equal(messages[2].deltaTime, 0.04);
  assert.deepEqual(messages[2].radarData, latestTargets);
  instance.onmessage({ data: { type: 'frame', id: 2, commands: [] } });
  assert.equal(h.runner.getTime(), 0.06);
});

test('startup watchdog terminates an unresponsive worker and reports a timeout', async t => {
  let terminated = 0;
  const h = createHarness(t, {
    createWorker: () => ({ postMessage() {}, terminate() { terminated++; } }),
    startupTimeoutMs: 20,
  });
  assert.equal(await h.run(DEFAULT_CODE), false);
  assert.equal(h.errors[0].name, 'TimeoutError');
  assert.equal(terminated, 1);
});

test('invalid command batches cannot invoke arbitrary host functions or apply partial commands', async t => {
  let instance;
  const h = createHarness(t, {
    createWorker: () => (instance = { postMessage() {}, terminate() {} }),
  });
  h.runner.run(DEFAULT_CODE);
  instance.onmessage({ data: { type: 'ready' } });
  h.runner.tick(0.02);
  instance.onmessage({ data: { type: 'frame', id: 1, commands: [['fire'], ['constructor', 'bad']] } });
  assert.equal(h.runner.isRunning(), false);
  assert.deepEqual(h.calls, []);
  assert.match(h.errors[0].message, /Invalid sandbox command/);
});

test('commands from a stopped worker cannot affect a later run', async t => {
  const instances = [];
  const h = createHarness(t, {
    createWorker: () => {
      const instance = { postMessage() {}, terminate() {} };
      instances.push(instance);
      return instance;
    },
  });
  h.runner.run(DEFAULT_CODE);
  instances[0].onmessage({ data: { type: 'ready' } });
  const deliverOldMessage = instances[0].onmessage;
  h.runner.tick(0.02);
  h.runner.stop();
  h.runner.run(DEFAULT_CODE);
  deliverOldMessage({ data: { type: 'frame', id: 1, commands: [['fire']] } });
  assert.deepEqual(h.calls, []);
});
