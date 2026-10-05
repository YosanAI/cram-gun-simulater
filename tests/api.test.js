import assert from 'node:assert/strict';
import test from 'node:test';

const DEG = Math.PI / 180;
let instance = 0;
const freshApi = () => import(`../src/api.js?test=${instance++}`);
const settle = api => {
  for (let i = 0; i < 120; i++) api.advanceMotion(0.05);
};
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test('radian commands preserve smooth motion and getters report the actual pose', async () => {
  const api = await freshApi();
  closeTo(api.getCurrentAzimuth(), 0);
  closeTo(api.getCurrentElevation(), 10 * DEG);

  api.setAzimuth(Math.PI / 2);
  api.setElevation(Math.PI / 4);
  closeTo(api.getCurrentAzimuth(), 0);
  closeTo(api.getCurrentElevation(), 10 * DEG);

  api.advanceMotion(0.05);
  assert.ok(api.getCurrentAzimuth() > 0 && api.getCurrentAzimuth() < Math.PI / 2);
  assert.ok(api.getCurrentElevation() > 10 * DEG && api.getCurrentElevation() < Math.PI / 4);
  settle(api);
  closeTo(api.getCurrentAzimuth(), Math.PI / 2);
  closeTo(api.getCurrentElevation(), Math.PI / 4);
});

test('azimuth wraps and travels across north using the shortest path', async () => {
  const api = await freshApi();
  api.setAzimuth(359 * DEG);
  api.advanceMotion(0.05);
  assert.ok(api.getSceneState().azimuth < 0);
  settle(api);
  closeTo(api.getCurrentAzimuth(), 359 * DEG);

  api.setAzimuth(361 * DEG);
  closeTo(api.getSceneState().targetAzimuth, 1);
  settle(api);
  closeTo(api.getCurrentAzimuth(), DEG);

  api.setAzimuth(-Math.PI / 2);
  settle(api);
  closeTo(api.getCurrentAzimuth(), Math.PI * 1.5);
});

test('elevation retains the original limits and invalid commands cannot corrupt the pose', async () => {
  const api = await freshApi();
  api.setElevation(Math.PI);
  settle(api);
  closeTo(api.getCurrentElevation(), 85 * DEG);
  api.setElevation(-Math.PI);
  settle(api);
  closeTo(api.getCurrentElevation(), -15 * DEG);

  for (const value of [NaN, Infinity, -Infinity, '1', null, undefined]) {
    assert.throws(() => api.setAzimuth(value), TypeError);
    assert.throws(() => api.setElevation(value), TypeError);
  }
  api.setAzimuth(Number.MAX_VALUE);
  api.setElevation(Number.MAX_VALUE);
  settle(api);
  assert.ok(Number.isFinite(api.getCurrentAzimuth()));
  closeTo(api.getCurrentElevation(), 85 * DEG);
});

test('fire starts a finite burst, repeated calls extend it, and the drive winds down', async () => {
  const api = await freshApi();
  api.fire();
  assert.equal(api.getSceneState().firing, true);
  for (let i = 0; i < 10; i++) {
    const frame = api.advanceMotion(0.05);
    assert.equal(frame.firing, api.getSceneState().firing);
  }
  assert.ok(api.getSceneState().drive > 0.9);

  api.fire();
  for (let i = 0; i < 6; i++) api.advanceMotion(0.05);
  assert.equal(api.getSceneState().firing, true);
  for (let i = 0; i < 10; i++) api.advanceMotion(0.05);
  assert.equal(api.getSceneState().firing, false);
  settle(api);
  assert.equal(api.getSceneState().drive, 0);
});

test('a lifecycle interruption cancels firing without changing the commanded angles', async () => {
  const api = await freshApi();
  api.setAzimuth(Math.PI / 3);
  api.setElevation(Math.PI / 6);
  api.fire();
  api.advanceMotion(0.05);
  api.stopFiring();
  assert.equal(api.advanceMotion(0.05).firing, false);
  settle(api);
  closeTo(api.getCurrentAzimuth(), Math.PI / 3);
  closeTo(api.getCurrentElevation(), Math.PI / 6);
  assert.equal(api.getSceneState().drive, 0);
});
