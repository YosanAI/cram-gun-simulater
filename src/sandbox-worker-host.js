import { createGunSandbox } from './gun-sandbox.js';
import { serializeSandboxError } from './sandbox-limits.js';

export function createSandboxWorkerHost(loadQuickJS, send) {
  let sandbox;
  return async function receive(message) {
    try {
      if (message.type === 'init') {
        sandbox = createGunSandbox(await loadQuickJS(), message.source, message.pose);
        send({ type: 'ready' });
      } else if (message.type === 'frame' && sandbox) {
        const commands = sandbox.tick(message.elapsedTime, message.deltaTime, message.pose);
        send({ type: 'frame', id: message.id, commands });
      } else {
        throw new Error('Invalid sandbox request.');
      }
    } catch (error) {
      send({ type: 'error', error: serializeSandboxError(error) });
      sandbox?.dispose();
      sandbox = undefined;
    }
  };
}
