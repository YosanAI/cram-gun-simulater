import assert from 'node:assert/strict';
import test from 'node:test';
import { createFullscreenView } from '../src/fullscreen-view.js';
import { createRadar } from '../src/radar.js';

class Element extends EventTarget {
  dataset = {};
  attributes = new Map();
  hidden = false;
  setAttribute(name, value) { this.attributes.set(name, value); }
  focus() { this.ownerDocument.activeElement = this; }
  click() { this.dispatchEvent(new Event('click')); }
}

const settle = () => new Promise(resolve => setImmediate(resolve));

function fullscreenHarness(t) {
  const document = new EventTarget();
  document.fullscreenEnabled = true;
  document.fullscreenElement = null;
  const stage = new Element();
  const button = new Element();
  stage.ownerDocument = button.ownerDocument = document;
  let requests = 0;
  let exits = 0;
  stage.requestFullscreen = async () => {
    requests++;
    document.fullscreenElement = stage;
    document.dispatchEvent(new Event('fullscreenchange'));
  };
  document.exitFullscreen = async () => {
    exits++;
    document.fullscreenElement = null;
    document.dispatchEvent(new Event('fullscreenchange'));
  };
  const view = createFullscreenView(stage, button);
  t.after(() => view.destroy());
  return { document, stage, button, view, requests: () => requests, exits: () => exits };
}

test('fullscreen follows the browser state, including an external Escape exit, and restores its control', async t => {
  const h = fullscreenHarness(t);
  h.button.click();
  await settle();
  assert.equal(h.document.fullscreenElement, h.stage, 'the whole scene must enter fullscreen, keeping the camera tabs inside it');
  assert.equal(h.stage.dataset.fullscreen, 'true');
  assert.equal(h.button.attributes.get('aria-pressed'), 'true');
  assert.equal(h.button.attributes.get('aria-label'), 'Exit fullscreen');
  assert.equal(h.document.activeElement, h.button, 'keyboard focus must leave the panels that will be hidden');

  // Browsers exit natively on Escape without clicking our exit button.
  await h.document.exitFullscreen();
  assert.equal(h.stage.dataset.fullscreen, 'false');
  assert.equal(h.button.attributes.get('aria-pressed'), 'false');
  assert.equal(h.button.attributes.get('aria-label'), 'Enter fullscreen');
  h.button.click();
  await settle();
  h.button.click();
  await settle();
  assert.equal(h.requests(), 2);
  assert.equal(h.exits(), 2);
  assert.equal(h.stage.dataset.fullscreen, 'false');
});

test('unsupported, restricted, or rejected fullscreen requests still allow an unobstructed view and Escape restoration', async t => {
  for (const restriction of ['unsupported', 'restricted', 'rejected']) {
    const h = fullscreenHarness(t);
    if (restriction === 'unsupported') delete h.stage.requestFullscreen;
    else if (restriction === 'restricted') h.document.fullscreenEnabled = false;
    else h.stage.requestFullscreen = async () => { throw new Error('Fullscreen unavailable'); };
    h.button.click();
    await settle();
    assert.equal(h.document.fullscreenElement, null);
    assert.equal(h.stage.dataset.fullscreen, 'true');
    const escape = new Event('keydown', { cancelable: true });
    Object.defineProperty(escape, 'key', { value: 'Escape' });
    h.document.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(h.stage.dataset.fullscreen, 'false');
    h.button.click();
    await settle();
    h.button.click();
    await settle();
    assert.equal(h.stage.dataset.fullscreen, 'false');
  }
});

test('disposing during a fullscreen request cleans up a late grant and detaches controls', async t => {
  const h = fullscreenHarness(t);
  let grant;
  h.stage.requestFullscreen = () => new Promise(resolve => {
    grant = () => {
      h.document.fullscreenElement = h.stage;
      h.document.dispatchEvent(new Event('fullscreenchange'));
      resolve();
    };
  });
  h.button.click();
  h.button.click();
  h.view.destroy();
  grant();
  await settle();
  assert.equal(h.document.fullscreenElement, null);
  assert.equal(h.exits(), 1);
  assert.equal(h.stage.dataset.fullscreen, 'false');
  assert.equal(h.button.attributes.get('aria-pressed'), 'false');
  h.button.click();
  await settle();
  assert.equal(h.stage.dataset.fullscreen, 'false');
});

test('collapsed radar keeps counts current, stops drawing, resumes at its current size, and detaches on disposal', t => {
  const nodes = new Map(['radar-widget', 'radar-body', 'toggle-radar', 'radar-canvas', 'radar-count', 'radar-range', 'radar-detail', 'radar-kills']
    .map(id => [id, new Element()]));
  const panel = nodes.get('radar-widget');
  const body = nodes.get('radar-body');
  const button = nodes.get('toggle-radar');
  const canvas = nodes.get('radar-canvas');
  const properties = new Map();
  panel.parentElement = { style: { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) } };
  panel.dataset.collapsed = 'false';
  panel.getBoundingClientRect = () => ({ height: body.hidden ? 50 : 326 });
  canvas.getBoundingClientRect = () => ({ width: body.hidden ? 0 : 236, left: 0, top: 0 });
  let draws = 0;
  const context = new Proxy({
    createRadialGradient: () => ({ addColorStop() {} }),
    drawImage: () => draws++,
  }, { get: (target, key) => target[key] ?? (() => {}) });
  canvas.getContext = () => context;
  const globals = { document: globalThis.document, window: globalThis.window, ResizeObserver: globalThis.ResizeObserver };
  let disconnected = false;
  globalThis.document = { getElementById: id => nodes.get(id), createElement: () => ({ getContext: () => context }) };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.ResizeObserver = class { observe() {} disconnect() { disconnected = true; } };
  t.after(() => {
    for (const [key, value] of Object.entries(globals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  const radar = createRadar();
  t.after(() => radar.destroy());
  radar.update(0.02, 0, [], { queued: 0, killed: 0 });
  assert.equal(draws, 1);
  button.click();
  assert.equal(body.hidden, true);
  assert.equal(button.attributes.get('aria-expanded'), 'false');
  assert.equal(properties.get('--radar-panel-height'), '50px');
  const target = { id: 1, pos: { x: 3, y: 5, z: 10 }, distance: 12 };
  radar.update(0.02, 0, [target], { queued: 4, killed: 2 });
  assert.equal(nodes.get('radar-count').textContent, '1 live / 4 queued');
  assert.equal(nodes.get('radar-kills').textContent, '2 killed');
  assert.equal(draws, 1, 'hidden radar must not draw to its canvas');
  button.click();
  radar.update(0.02, 0, [target], { queued: 4, killed: 2 });
  assert.equal(body.hidden, false);
  assert.equal(button.attributes.get('aria-expanded'), 'true');
  assert.equal(canvas.width, 236);
  assert.equal(draws, 2);
  assert.equal(properties.get('--radar-panel-height'), '326px');
  radar.destroy();
  assert.equal(disconnected, true);
  button.click();
  assert.equal(body.hidden, false);
  assert.equal(properties.has('--radar-panel-height'), false);
});
