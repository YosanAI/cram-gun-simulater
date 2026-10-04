import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
import wasmUrl from '@jitl/quickjs-wasmfile-release-sync/wasm?url';
import { createSandboxWorkerHost } from './sandbox-worker-host.js';

const loadQuickJS = () => newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmLocation: wasmUrl }));
const receive = createSandboxWorkerHost(loadQuickJS, message => self.postMessage(message));
self.onmessage = event => { void receive(event.data); };
