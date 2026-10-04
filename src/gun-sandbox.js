import { SANDBOX_LIMITS } from './sandbox-limits.js';

/** User JavaScript runs in its own QuickJS heap, never in the host JS realm. */
export function createGunSandbox(QuickJS, source, initialPose, limits = SANDBOX_LIMITS) {
  if (typeof source !== 'string' || source.length > limits.sourceLength) {
    throw new RangeError('Script must be at most 64K characters.');
  }
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  const vm = runtime.newContext();
  let deadline = Infinity;
  let interrupted = false;
  let commands = [];
  let pose = initialPose;
  let inFrame = false;
  let callback;
  let invoke;
  let disposed = false;

  runtime.setInterruptHandler(() => {
    if (Date.now() >= deadline) interrupted = true;
    return interrupted;
  });

  function unwrap(result) {
    if (!result.error) return result.value;
    let detail;
    try {
      detail = vm.dump(result.error);
    } finally {
      result.error.dispose();
    }
    const error = new Error(typeof detail === 'object' && detail ? detail.message || 'Script error.' : String(detail));
    error.name = detail?.name || 'Error';
    const location = /update-gun\.js:(\d+)(?::(\d+))?/.exec(detail?.stack || '');
    // The wrapper adds one line before the user's source.
    if (location) {
      error.line = Math.max(1, Number(location[1]) - 1);
      if (location[2]) error.column = Number(location[2]);
    }
    throw error;
  }

  function bounded(operation) {
    interrupted = false;
    deadline = Date.now() + limits.executionMs;
    try {
      const result = operation();
      if (interrupted) throw new Error('Execution interrupted.');
      return result;
    } catch (error) {
      if (interrupted) {
        const timeout = new Error('Script exceeded the ' + limits.executionMs + ' ms execution limit.');
        timeout.name = 'TimeoutError';
        throw timeout;
      }
      throw error;
    } finally {
      deadline = Infinity;
    }
  }

  function addFunction(name, implementation) {
    const handle = vm.newFunction(name, implementation);
    try { vm.setProp(vm.global, name, handle); } finally { handle.dispose(); }
  }

  function queue(name, value) {
    if (!inFrame) throw new Error('Gun commands must be called inside updateGun.');
    if (commands.length >= limits.commandsPerFrame) {
      throw new RangeError('Too many gun commands in one frame.');
    }
    commands.push(name === 'fire' ? [name] : [name, value]);
  }

  function angle(handle) {
    if (!handle || vm.typeof(handle) !== 'number') {
      throw new TypeError('Angle must be a finite number in radians.');
    }
    const value = vm.getNumber(handle);
    if (!Number.isFinite(value)) throw new TypeError('Angle must be a finite number in radians.');
    return value;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    callback?.dispose();
    invoke?.dispose();
    vm.dispose();
    runtime.dispose();
  }

  try {
    addFunction('setAzimuth', value => { queue('setAzimuth', angle(value)); });
    addFunction('setAltitude', value => { queue('setAltitude', angle(value)); });
    addFunction('fire', () => { queue('fire'); });
    addFunction('getCurrentAzimuth', () => vm.newNumber(pose.azimuth));
    addFunction('getCurrentAltitude', () => vm.newNumber(pose.altitude));

    // Capture intrinsics before user code can modify its own globals.
    invoke = bounded(() => unwrap(vm.evalCode(
      '(function () { const apply = Reflect.apply; const tag = Object.prototype.toString; const Fail = TypeError;' +
      'return function (fn, time, delta, validateOnly) {' +
      'if (apply(tag, fn, []) !== "[object Function]") throw new Fail("updateGun must be a synchronous function.");' +
      'if (validateOnly) return;' +
      'const result = apply(fn, undefined, [time, delta]);' +
      'if (result && typeof result.then === "function") throw new Fail("updateGun must not return a Promise.");' +
      '}; })()', 'sandbox-internal.js',
    )));
    callback = bounded(() => unwrap(vm.evalCode(
      '(function () { "use strict";\n' + source +
      '\n;return typeof updateGun === "function" ? updateGun : null; })()',
      'update-gun.js',
    )));
    if (vm.typeof(callback) !== 'function') throw new TypeError('Define function updateGun(elapsedTime, deltaTime).');
    bounded(() => unwrap(vm.callFunction(invoke, vm.undefined, callback, vm.undefined, vm.undefined, vm.true)).dispose());
    if (runtime.hasPendingJob()) throw new TypeError('Asynchronous code is not supported in updateGun.');
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    tick(elapsedTime, deltaTime, currentPose) {
      if (disposed) throw new Error('The sandbox has been stopped.');
      pose = currentPose;
      commands = [];
      inFrame = true;
      const time = vm.newNumber(elapsedTime);
      const delta = vm.newNumber(deltaTime);
      try {
        bounded(() => unwrap(vm.callFunction(invoke, vm.undefined, callback, time, delta, vm.false)).dispose());
        if (runtime.hasPendingJob()) throw new TypeError('Asynchronous code is not supported in updateGun.');
        return commands;
      } finally {
        inFrame = false;
        time.dispose();
        delta.dispose();
      }
    },
    dispose,
  };
}
