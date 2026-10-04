import { SANDBOX_LIMITS, validateCommands, serializeSandboxError } from './sandbox-limits.js';

export const DEFAULT_CODE = 'function updateGun(elapsedTime, deltaTime) {\n\n}\n';

const defaultWorker = () => new Worker(new URL('./sandbox.worker.js', import.meta.url), { type: 'module' });

/** The render thread exchanges bounded data with an independently stoppable VM. */
export function createSimulationRunner(api, {
  onStateChange = () => {},
  onError = () => {},
  onStop = () => {},
  createWorker = defaultWorker,
  startupTimeoutMs = SANDBOX_LIMITS.startupMs,
  responseTimeoutMs = SANDBOX_LIMITS.responseMs,
} = {}) {
  let worker = null;
  let ready = false;
  let pendingId = null;
  let nextId = 0;
  let watchdog;
  let elapsedTime = 0;
  let pendingDelta = 0;
  let sentDelta = 0;

  function stop() {
    clearTimeout(watchdog);
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
    worker = null;
    ready = false;
    pendingId = null;
    pendingDelta = 0;
    onStop();
    onStateChange(false, 'stopped');
  }

  function fail(error) {
    stop();
    onError(error);
  }

  function armWatchdog(instance, milliseconds) {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (worker !== instance) return;
      const error = new Error('The script sandbox stopped responding and was terminated.');
      error.name = 'TimeoutError';
      fail(error);
    }, milliseconds);
  }

  function currentPose() {
    return { azimuth: api.getCurrentAzimuth(), altitude: api.getCurrentAltitude() };
  }

  function receive(instance, message) {
    if (worker !== instance) return;
    try {
      if (message?.type === 'error') {
        const detail = serializeSandboxError(message.error);
        const error = new Error(detail.message);
        Object.assign(error, detail);
        fail(error);
      } else if (message?.type === 'ready' && !ready) {
        clearTimeout(watchdog);
        ready = true;
        onStateChange(true, 'running');
      } else if (message?.type === 'frame' && ready && pendingId !== null && message.id === pendingId) {
        // Validate the whole batch before allowing any command to touch the app.
        validateCommands(message.commands);
        clearTimeout(watchdog);
        for (const [name, value] of message.commands) {
          if (name === 'fire') api.fire();
          else api[name](value);
        }
        elapsedTime += sentDelta;
        pendingId = null;
      } else {
        throw new Error('Invalid response from the script sandbox.');
      }
    } catch (error) {
      fail(error);
    }
  }

  return {
    run(source) {
      stop();
      elapsedTime = 0;
      nextId = 0;
      try {
        if (typeof source !== 'string' || source.length > SANDBOX_LIMITS.sourceLength) {
          throw new RangeError('Script must be at most 64K characters.');
        }
        const instance = createWorker();
        worker = instance;
        instance.onmessage = event => receive(instance, event.data);
        instance.onerror = event => {
          event.preventDefault?.();
          if (worker === instance) fail(new Error(event.message || 'The script sandbox crashed.'));
        };
        instance.onmessageerror = () => {
          if (worker === instance) fail(new Error('The script sandbox sent unreadable data.'));
        };
        onStateChange(true, 'starting');
        armWatchdog(instance, startupTimeoutMs);
        instance.postMessage({ type: 'init', source, pose: currentPose() });
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    stop,
    tick(deltaTime) {
      if (!worker || !ready) return;
      if (!Number.isFinite(deltaTime) || deltaTime < 0) return;
      pendingDelta += deltaTime;
      // Never queue frames behind slow code. Its next delta includes skipped time.
      if (pendingId !== null) return;
      const instance = worker;
      pendingId = ++nextId;
      sentDelta = pendingDelta;
      pendingDelta = 0;
      try {
        armWatchdog(instance, responseTimeoutMs);
        instance.postMessage({
          type: 'frame', id: pendingId,
          elapsedTime, deltaTime: sentDelta, pose: currentPose(),
        });
      } catch (error) {
        fail(error);
      }
    },
    isRunning: () => worker !== null,
    getTime: () => elapsedTime,
  };
}
