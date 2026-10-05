import { SANDBOX_LIMITS } from './sandbox-limits.js';
import { sandboxGlobalsSource } from './sandbox-globals.js';

/** User JavaScript runs in its own QuickJS heap, never in the host JS realm. */
export function createGunSandbox(QuickJS, source, initialPose, limits = SANDBOX_LIMITS, { threeSource, onLog = () => {} } = {}) {
  if (typeof source !== 'string' || source.length > limits.sourceLength) {
    throw new RangeError('Script must be at most ' + limits.sourceLength / 1024 + 'K characters.');
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
  let logCount = 0;
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

  function bounded(operation, milliseconds = limits.executionMs) {
    interrupted = false;
    deadline = Date.now() + milliseconds;
    try {
      const result = operation();
      if (interrupted) throw new Error('Execution interrupted.');
      return result;
    } catch (error) {
      if (interrupted) {
        const timeout = new Error('Script exceeded the ' + milliseconds + ' ms execution limit.');
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

  function drainJobs() {
    let jobs = 0;
    while (runtime.hasPendingJob()) {
      if (++jobs > limits.promiseJobs) throw new RangeError('Too many Promise jobs in one callback.');
      unwrap(runtime.executePendingJobs(1));
    }
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
    addFunction('setElevation', value => { queue('setElevation', angle(value)); });
    addFunction('fire', () => { queue('fire'); });
    addFunction('getCurrentAzimuth', () => vm.newNumber(pose.azimuth));
    addFunction('getCurrentElevation', () => vm.newNumber(pose.elevation));

    addFunction('__reserveConsoleEntry', () => logCount++ < limits.consoleEntries ? vm.true : vm.false);
    addFunction('__writeConsoleEntry', (level, message) => {
      onLog({ level: vm.getString(level), message: vm.getString(message).slice(0, limits.consoleCharacters) });
    });
    addFunction('__sandboxNow', () => vm.newNumber(globalThis.performance?.now() ?? Date.now()));
    bounded(() => unwrap(vm.evalCode(sandboxGlobalsSource(limits), 'sandbox-globals.js')).dispose());

    if (threeSource) {
      // Load the installed library into the guest heap, with no host THREE objects.
      bounded(() => unwrap(vm.evalCode(
        'globalThis.THREE = (function (exports) {\n' + threeSource + '\n;return exports; })({});',
        'three.cjs',
      )).dispose(), limits.libraryMs);
    }

    // Capture intrinsics before user code can modify its own globals.
    invoke = bounded(() => unwrap(vm.evalCode(
      '(function () { const apply = Reflect.apply; const tag = Object.prototype.toString; const Fail = TypeError; const parse = JSON.parse; const P = Promise; const resolve = P.resolve;' +
      'return function (fn, radarJson, time, delta, validateOnly) {' +
      'const kind = apply(tag, fn, []);' +
      'if (kind !== "[object Function]" && kind !== "[object AsyncFunction]") throw new Fail("updateGun must be a function, not a generator.");' +
      'if (validateOnly) return;' +
      'const result = apply(fn, undefined, [parse(radarJson), time, delta]);' +
      'return apply(resolve, P, [result]);' +
      '}; })()', 'sandbox-internal.js',
    )));
    callback = bounded(() => unwrap(vm.evalCode(
      '(function () { "use strict";\n' + source +
      '\n;return typeof updateGun === "function" ? updateGun : null; })()',
      'update-gun.js',
    )));
    if (vm.typeof(callback) !== 'function') throw new TypeError('Define function updateGun(radarData, elapsedTime, deltaTime).');
    bounded(() => unwrap(vm.callFunction(invoke, vm.undefined, callback, vm.undefined, vm.undefined, vm.undefined, vm.true)).dispose());
    bounded(drainJobs);
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    tick(elapsedTime, deltaTime, currentPose, radarData = []) {
      if (disposed) throw new Error('The sandbox has been stopped.');
      pose = currentPose;
      commands = [];
      logCount = 0;
      inFrame = true;
      const time = vm.newNumber(elapsedTime);
      const delta = vm.newNumber(deltaTime);
      let radarJson;
      try {
        // Parse into the guest heap; no host objects or functions cross the VM boundary.
        radarJson = vm.newString(JSON.stringify(radarData));
        bounded(() => {
          const result = unwrap(vm.callFunction(invoke, vm.undefined, callback, radarJson, time, delta, vm.false));
          try {
            drainJobs();
            const state = vm.getPromiseState(result);
            if (state.type === 'pending') throw new TypeError('updateGun returned a Promise that did not settle within this callback.');
            unwrap(state).dispose();
          } finally { result.dispose(); }
        });
        return commands;
      } finally {
        inFrame = false;
        time.dispose();
        delta.dispose();
        radarJson?.dispose();
      }
    },
    dispose,
  };
}
