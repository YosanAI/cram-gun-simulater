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
  const logs = [];
  const phases = [];
  const workers = [];
  const api = suppliedApi || {
    setAzimuth: rad => calls.push(['azimuth', rad]),
    setElevation: rad => calls.push(['elevation', rad]),
    getCurrentAzimuth: () => 1.2,
    getCurrentElevation: () => 0.4,
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
    onLog: entry => logs.push(entry),
    ...overrides,
  });
  t.after(async () => {
    runner.stop();
    await Promise.all(workers.map(worker => worker.terminate()));
  });
  return {
    runner, calls, errors, logs, phases,
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
  assert.equal(await h.run('function updateGun(t, dt) { setAzimuth(getCurrentAzimuth()+t); setElevation(getCurrentElevation()+dt); fire(); }'), true);
  await h.step(0.02);
  await h.step(0.03);
  assert.deepEqual(h.calls.map(call => call[0]), ['azimuth', 'elevation', 'fire', 'azimuth', 'elevation', 'fire']);
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
        setElevation(radarData[0].pos.y);
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
    ['azimuth', 7], ['elevation', 4], ['azimuth', 13],
    ['azimuth', 7], ['elevation', 4], ['azimuth', 13], ['fire'],
  ]);
  assert.deepEqual(radarData, [{ id: 7, pos: { x: 3, y: 4, z: 12 }, distance: 13 }]);
});

test('Stop discards execution and restarting resets the clock and callback closure', async t => {
  const h = createHarness(t);
  const source = 'let count=0; function updateGun(t) { setAzimuth(++count); setElevation(t); }';
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
    ['azimuth', 1], ['elevation', 0],
    ['azimuth', 2], ['elevation', 0.02],
    ['azimuth', 1], ['elevation', 0],
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

test('missing, non-function, and generator frame callbacks are rejected', async t => {
  const h = createHarness(t);
  for (const source of [
    'const unrelated = 1;', 'const updateGun = 42;',
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
    ['setElevation("1");', /finite number/],
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

test('excessive commands, rejected promises, and promises that never settle stop the sandbox', async t => {
  const h = createHarness(t);
  for (const [body, expected] of [
    ['for (let i=0;i<' + (SANDBOX_LIMITS.commandsPerFrame + 1) + ';i++) fire();', /Too many gun commands/],
    ['return Promise.reject(new Error("async fault"));', /async fault/],
    ['return new Promise(() => {});', /did not settle/],
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
  assert.equal(await h.run('function updateGun() { setAzimuth(Math.PI/2); setElevation(Math.PI/6); fire(); }'), true);
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
    { azimuth: 0, elevation: 0 },
    { ...SANDBOX_LIMITS, memoryBytes: 1024 * 1024, executionMs: 500 },
  );
  t.after(() => sandbox.dispose());
  assert.throws(() => sandbox.tick(0, 0.02, { azimuth: 0, elevation: 0 }), /memory/i);
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
  deliverOldMessage({ data: { type: 'frame', id: 1, commands: [['fire']], logs: [{ level: 'log', message: 'stale' }] } });
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.logs, []);
});

test('the installed Three.js library and Math work on radar targets inside the real worker', async t => {
  const h = createHarness(t);
  assert.equal(await h.run(`
    const position = new THREE.Vector3();
    const scene = new THREE.Scene();
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: "red" }));
    scene.add(mesh);
    function updateGun(t, dt, radarData) {
      const { x, y, z } = radarData[0].pos;
      position.set(x, y, z);
      mesh.position.copy(position);
      scene.updateMatrixWorld(true);
      const ray = new THREE.Ray(new THREE.Vector3(), position.clone().normalize());
      if (!ray.intersectsSphere(new THREE.Sphere(position, 1.5))) throw new Error("Ray test failed");
      const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
      const rotated = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation);
      console.log(THREE.REVISION, position.length(), geometry.attributes.position.count, scene.children.length, rotated.x);
      setAzimuth(Math.atan2(x, z));
      setElevation(Math.atan2(y, Math.hypot(x, z)));
      fire();
    }
  `), true);
  await h.step(0.02, [{ id: 1, pos: { x: 3, y: 4, z: 12 }, distance: 13 }]);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.logs, [{ level: 'log', message: '180 13 24 1 1' }]);
  assert.ok(Math.abs(h.calls[0][1] - Math.atan2(3, 12)) < 1e-12);
  assert.ok(Math.abs(h.calls[1][1] - Math.atan2(4, Math.hypot(3, 12))) < 1e-12);
  assert.equal(h.calls[2][0], 'fire');
});

test('ordinary JS helpers, eval, typed arrays, and async computations are available', async t => {
  const h = createHarness(t);
  assert.equal(await h.run(`
    class Controller { async bearing() { return await Promise.resolve(Math.PI / 2); } }
    function* samples() { yield 1; yield 2; }
    const data = new Float32Array([...samples()]);
    const controller = new Controller();
    async function updateGun() {
      const values = await Promise.all([controller.bearing(), Promise.resolve(data.reduce((a, b) => a + b, 0))]);
      setAzimuth(values[0]);
      setElevation(eval("Math.PI / 6"));
      console.log(new Map([["sum", values[1]]]).get("sum"), new Function("return Math.sqrt(9)")());
      fire();
    }
  `), true);
  await h.step(0.02);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.logs, [{ level: 'log', message: '3 3' }]);
  assert.deepEqual(h.calls, [['azimuth', Math.PI / 2], ['elevation', Math.PI / 6], ['fire']]);
});

test('console handles startup output, circular data, and diagnostics before failed commands', async t => {
  const h = createHarness(t);
  await h.run(`
    console.log("starting");
    function updateGun() {
      const value = { id: 1 }; value.self = value;
      console.log(value, undefined, 42n);
      console.warn("warning");
      console.error(new Error("diagnostic"));
      fire();
      throw new Error("script fault");
    }
  `);
  await h.step(0.02);
  assert.equal(h.logs[0].message, 'starting');
  assert.equal(h.logs[1].message, '{"id":1,"self":"[Circular]"} undefined 42n');
  assert.equal(h.logs[2].level, 'warn');
  assert.match(h.logs[3].message, /Error: diagnostic/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.errors[0].message, 'script fault');
});

test('console floods are bounded and the quota resets each frame without stopping commands', async t => {
  const h = createHarness(t);
  await h.run('function updateGun() { for (let i=0;i<100;i++) console.log("x".repeat(20000)); fire(); }');
  await h.step(0.02);
  assert.equal(h.logs.length, SANDBOX_LIMITS.consoleEntries);
  assert.ok(h.logs.every(entry => entry.message.length === SANDBOX_LIMITS.consoleCharacters));
  await h.step(0.02);
  assert.equal(h.logs.length, SANDBOX_LIMITS.consoleEntries * 2);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.calls, [['fire'], ['fire']]);
});

test('Three, console, and Math constructors cannot escape the VM or mutate host prototypes', async t => {
  const h = createHarness(t);
  await h.run(`
    function updateGun() {
      for (const fn of [THREE.Vector3, console.log, Math.sin]) {
        const root = fn.constructor("return globalThis")();
        for (const key of ["window", "document", "fetch", "WebSocket", "localStorage", "process", "require", "postMessage", "Worker", "importScripts"]) {
          if (typeof root[key] !== "undefined") throw new Error("Escaped via " + key);
        }
      }
      THREE.Vector3.prototype.guestOnly = true;
      Object.prototype.guestOnly = true;
      fire();
    }
  `);
  await h.step(0.02);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.calls, [['fire']]);
  const THREE = await import('three');
  assert.equal(THREE.Vector3.prototype.guestOnly, undefined);
  assert.equal({}.guestOnly, undefined);
});

test('an endless Promise job chain is stopped without applying commands', async t => {
  const h = createHarness(t);
  await h.run('function updateGun() { fire(); function loop() { Promise.resolve().then(loop); } loop(); }');
  await h.step(0.02);
  assert.match(h.errors[0].message, /Promise jobs|execution limit/);
  assert.deepEqual(h.calls, []);
});

test('untrusted console messages cannot select arbitrary host functions', t => {
  let instance;
  const h = createHarness(t, { createWorker: () => (instance = { postMessage() {}, terminate() {} }) });
  h.runner.run(DEFAULT_CODE);
  instance.onmessage({ data: { type: 'ready', logs: [{ level: 'constructor', message: 'bad' }] } });
  assert.equal(h.runner.isRunning(), false);
  assert.deepEqual(h.logs, []);
  assert.match(h.errors[0].message, /Invalid sandbox console/);
});

test('rapid console output is limited across frames while the gun keeps running', t => {
  let instance;
  const h = createHarness(t, { createWorker: () => (instance = { postMessage() {}, terminate() {} }) });
  h.runner.run(DEFAULT_CODE);
  instance.onmessage({ data: { type: 'ready' } });
  const logs = Array.from({ length: SANDBOX_LIMITS.consoleEntries }, () => ({ level: 'log', message: 'test' }));
  for (let id = 1; id <= 4; id++) {
    h.runner.tick(0.01);
    instance.onmessage({ data: { type: 'frame', id, commands: [['fire']], logs } });
  }
  assert.equal(h.logs.length, SANDBOX_LIMITS.consoleEntriesPerSecond);
  assert.equal(h.calls.length, 4);
  assert.equal(h.runner.isRunning(), true);
});
