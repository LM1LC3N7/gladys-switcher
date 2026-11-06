// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and
// real local TCP devices: the reads keep their interval (sped up 20 times,
// never early, a little late under load at most); a scene on 5 devices that
// answer in 900 ms is acked within 3.5 s for each, stops and commands alike.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SwitcherApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { SELECTOR, created, quiet } from './helpers/app.js';
import { realClock } from './helpers/clock.js';
import { fakeSwitcher } from './helpers/fakeSwitcher.js';

async function realSetup(t, { speed, specs, config = {} }) {
  const clock = realClock({ speed });
  const ports = { 1: 0, 2: 0 };
  const devs = [];
  for (const spec of specs) {
    const dev = await fakeSwitcher({ ...spec, port: ports[1] });
    ports[1] = dev.port;
    devs.push(dev);
  }
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config,
    devices: devs.map(created),
    scanResults: { 'udp-broadcast': devs.map((d) => d.announcement()) },
  });
  const app = new SwitcherApp({
    gladys,
    store: memoryStore(),
    logger: quiet,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    connect: (args) => createConnection(args),
    ports,
    allowLoopback: true,
  });
  registerHandlers(gladys, app, quiet);
  t.after(async () => {
    await Promise.race([app.stop(), new Promise((resolve) => setTimeout(resolve, 500))]);
    clock.close();
    for (const dev of devs) await dev.close();
  });
  return { app, gladys, devs, clock };
}

const waitReal = async (condition, what, ms = 10_000) => {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('real clock x20: periodic reads every interval, never early', async (t) => {
  const { gladys, devs, clock } = await realSetup(t, {
    speed: 20,
    specs: [{ model: '0317' }],
    config: { read_interval: 10 },
  });
  await gladys.connect();
  // The state requests the device received, on the simulated clock.
  const starts = () =>
    devs[0].requests.filter((r) => r.type === 'state').map((r) => r.at * clock.speed);
  await waitReal(() => starts().length >= 4, '4 reads', 10_000);
  const at = starts();
  const gaps = at.slice(1, 4).map((v, i) => v - at[i]);
  for (const gap of gaps) {
    assert.ok(gap >= 9_000 && gap <= 15_000, `gap ${Math.round(gap)} ms (simulated)`);
  }
  assert.ok(devs[0].count('state') >= 3);
});

test('real clock: a scene on 5 devices answering in 900 ms, every ack within 3.5 s', async (t) => {
  const { app, gladys, devs } = await realSetup(t, {
    speed: 1,
    specs: [1, 2, 3, 4, 5].map(() => ({ model: '01a8', latencyMs: 900 })),
    config: { allow_plug_on: true, read_interval: 600 },
  });
  await gladys.connect();
  await waitReal(() => app.scanState === 'ok', 'scan');
  const timed = (promise) => {
    const started = performance.now();
    return promise.then((ack) => ({ ack, elapsed: performance.now() - started }));
  };
  const click = (dev, value) => {
    const device = created(dev);
    const feature = device.features.find((f) => f.external_id.endsWith(':power'));
    return timed(gladys.fake.setValue(device, feature, value));
  };
  const ons = await Promise.all(devs.map((dev) => click(dev, 1)));
  for (const { ack, elapsed } of ons) {
    assert.equal(ack.success, true, ack.error);
    assert.ok(elapsed < 3500, `on acked in ${Math.round(elapsed)} ms`);
  }
  assert.ok(devs.every((d) => d.count('on') === 1));
  const offs = await Promise.all(devs.map((dev) => click(dev, 0)));
  for (const { ack, elapsed } of offs) {
    assert.equal(ack.success, true, ack.error);
    assert.ok(elapsed < 3500, `off acked in ${Math.round(elapsed)} ms`);
  }
  await waitReal(() => devs.every((d) => d.count('off') === 1), 'offs');
});

test('real clock: a device that never answers the login, the stop acked within 3.5 s', async (t) => {
  const { app, gladys, devs } = await realSetup(t, { speed: 1, specs: [{ model: '0317' }] });
  await gladys.connect();
  await waitReal(() => app.scanState === 'ok', 'scan');
  devs[0].mute.add('login');
  const device = created(devs[0]);
  const started = performance.now();
  const ack = await gladys.fake.setValue(device, device.features[0], 0);
  const elapsed = performance.now() - started;
  assert.equal(ack.success, false);
  assert.ok(elapsed < 3500, `${Math.round(elapsed)} ms`);
  assert.equal(devs[0].count('off'), 0);
  devs[0].mute.clear();
  await waitReal(() => devs[0].count('off') === 1, 'kept stop sent', 45_000);
});
