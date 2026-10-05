import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
import { createSandboxWorkerHost } from '../src/sandbox-worker-host.js';

const receive = createSandboxWorkerHost(
  () => newQuickJSWASMModuleFromVariant(RELEASE_SYNC),
  data => parentPort.postMessage(data),
  { threeSource: readFileSync(createRequire(import.meta.url).resolve('three'), 'utf8') },
);
parentPort.on('message', data => { void receive(data); });
