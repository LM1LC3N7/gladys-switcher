// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, fake Switcher devices on real
// loopback sockets (one port per protocol family, one address per device), a
// virtual clock and a /data in memory.
// -----------------------------------------------------------------------------

import { createConnection } from 'node:net';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SwitcherApp } from '../../src/app.js';
import { buildDevice } from '../../src/devices.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { MODELS } from '../../src/protocol/packets.js';
import { fakeSwitcher } from './fakeSwitcher.js';
import { settle, testClock } from './clock.js';

export const SELECTOR = 'switcher-test';
export const quiet = { info() {}, warn() {}, error() {}, debug() {} };
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

/** The external id of a device feature: `F(dev, 'power')`. */
export const F = (dev, key) => `ext:${SELECTOR}:switcher:${dev.mac}${key ? `:${key}` : ''}`;

/** The known-device record of a fake (what a scan would learn). */
export const knownOf = (dev) => ({
  mac: dev.mac,
  id: dev.id,
  model: dev.model,
  key: dev.family === 1 ? dev.key : undefined,
  name: dev.name,
  ip: dev.ip,
  remote: dev.kind === 'breeze' ? dev.remote : undefined,
});

/** The Gladys device of a fake, as the user created it. */
export function created(dev) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  return buildDevice(gladys, knownOf(dev));
}

/** Starts fake devices: specs like { model: '0317' } (one port per family). */
export async function startDevices(specs, clock) {
  const ports = { 1: 0, 2: 0 };
  const devs = [];
  for (const spec of specs) {
    const family = MODELS[spec.model ?? '0317'].family;
    const dev = await fakeSwitcher({ clock: () => clock.elapsed, ...spec, port: ports[family] });
    ports[family] = dev.port;
    devs.push(dev);
  }
  return { devs, ports };
}

/**
 * options: devices (specs), created (which fakes are created in Gladys: true
 * for all), config, data (/data content), store, heard (which fakes the scan
 * hears: true for all), connect (false: not connected yet), app (overrides).
 */
export async function setup(t, options = {}) {
  const clock = options.clock ?? testClock();
  const { devs, ports } = await startDevices(options.devices ?? [{ model: '0317' }], clock);
  const store = options.store ?? memoryStore(options.data ?? null);
  const createdDevs =
    options.created === false
      ? []
      : options.created === undefined || options.created === true
        ? devs
        : options.created(devs);
  const heard = options.heard === false ? [] : options.heard ? options.heard(devs) : devs;
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...options.config },
    devices: createdDevs.map(created),
    scanResults: { 'udp-broadcast': heard.map((d) => d.announcement()) },
  });
  const sockets = { open: 0, peak: 0, made: 0, live: new Set() };
  const connect = (args) => {
    const socket = createConnection(args);
    const entry = { socket, connecting: true, written: 0, port: undefined, ip: args.host };
    const write = socket.write.bind(socket);
    socket.write = (...a) => {
      entry.written += 1;
      return write(...a);
    };
    socket.once('connect', () => {
      entry.connecting = false;
      entry.port = socket.localPort;
    });
    sockets.live.add(entry);
    sockets.made += 1;
    sockets.open += 1;
    sockets.peak = Math.max(sockets.peak, sockets.open);
    socket.once('close', () => {
      sockets.open -= 1;
      sockets.live.delete(entry);
    });
    return socket;
  };
  // Real I/O in progress (a connection opening, a request the device has not
  // handled yet, an answer it has not written yet): the virtual clock waits
  // for it, so no test depends on a race between virtual timers and real answers.
  clock.busy = () =>
    devs.some((d) => d.pendingReplies > 0) ||
    [...sockets.live].some((e) => {
      if (e.socket.destroyed) return false;
      if (e.connecting) return true;
      const dev = devs.find((d) => d.ip === e.ip);
      return dev !== undefined && e.written > (dev.processed.get(e.port) ?? 0);
    });
  const app = new SwitcherApp({
    gladys,
    store,
    logger: quiet,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    connect,
    ports,
    allowLoopback: true,
    ...options.app,
  });
  registerHandlers(gladys, app, quiet);
  t.after(async () => {
    await Promise.race([app.stop(), new Promise((resolve) => setTimeout(resolve, 100))]);
    for (const dev of devs) await dev.close();
  });
  const ctx = { app, gladys, devs, dev: devs[0], clock, store, sockets };
  if (options.connect !== false) {
    await gladys.connect();
    if (options.waitScan !== false)
      await until(clock, () => app.scanState !== 'none', 'first scan');
  }
  return ctx;
}

/** Sets what the next scans hear. */
export function hear(ctx, devs) {
  ctx.gladys.fake.scanResults = { 'udp-broadcast': devs.map((d) => d.announcement()) };
}

/** Advances the virtual clock until `condition()` (real I/O runs in between), bounded. */
/** Lets real I/O in progress finish before the virtual clock moves (bounded: 2 s real). */
export async function ioSettle(clock) {
  await settle(3);
  for (let i = 0; i < 2000 && clock.busy?.(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await settle(2);
  }
}

export async function until(clock, condition, what, { step = 10, max = 30_000 } = {}) {
  for (let spent = 0; spent <= max; spent += step) {
    await ioSettle(clock);
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
    await ioSettle(clock);
    await clock.advance(step);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Runs the virtual clock for `ms` in small steps, real I/O in between (unlike advance()). */
export async function runFor(clock, ms, { step = 100 } = {}) {
  const end = clock.elapsed + ms;
  while (clock.elapsed < end) {
    await ioSettle(clock);
    await new Promise((resolve) => setTimeout(resolve, 1));
    await ioSettle(clock);
    await clock.advance(Math.min(step, end - clock.elapsed));
  }
}

/**
 * The answer of a click, the virtual clock run until it comes (bounded: a
 * test fails, never hangs, even when a mutant keeps the command waiting).
 * Resolves { ok, error, elapsed } (elapsed on the virtual clock).
 */
export async function answer(ctx, promise, { step = 5, max = 30_000 } = {}) {
  const started = ctx.clock.elapsed;
  const box = { done: false };
  promise.then(
    () => {
      box.done = true;
      box.ok = true;
    },
    (err) => {
      box.done = true;
      box.ok = false;
      box.error = err;
    },
  );
  await until(ctx.clock, () => box.done, 'answer', { step, max });
  return { ok: box.ok, error: box.error, elapsed: ctx.clock.elapsed - started };
}

/** A click on a feature through the SDK, as Gladys sends it. */
export function click(ctx, dev, key, value) {
  const device = created(dev);
  const feature = device.features.find((f) => f.external_id === F(dev, key));
  return answer(
    ctx,
    ctx.gladys.fake.setValue(device, feature, value).then((ack) => {
      if (!ack.success) throw new Error(ack.error ?? 'refused');
      return ack;
    }),
  );
}

/** getConfig() fails for the app (the first call, the resync of the SDK, answers). */
export function failConfig(t, gladys, { times = Infinity } = {}) {
  const original = gladys.getConfig.bind(gladys);
  let calls = 0;
  return t.mock.method(gladys, 'getConfig', async () => {
    calls += 1;
    if (calls > 1 && calls <= times + 1) throw new Error('Gladys busy');
    return original();
  });
}

export { settle, testClock };
