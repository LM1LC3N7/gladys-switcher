// -----------------------------------------------------------------------------
// The stops (water heater, plug, Breeze off; shutter stop): never refused,
// never waiting for /data, kept until a read shows them applied.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import {
  F,
  MINUTE,
  SECOND,
  click,
  failConfig,
  knownOf,
  runFor,
  setup,
  until,
} from './helpers/app.js';

test('a stop leaves with every option off, the configuration unread and no scan heard', async (t) => {
  const ctx = await setup(t, { heard: false, connect: false });
  failConfig(t, ctx.gladys);
  await ctx.gladys.connect();
  ctx.dev.power = 1;
  const r = await click(ctx, ctx.dev, 'power', 0);
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(ctx.dev.count('off'), 1);
  assert.equal(ctx.dev.power, 0);
  assert.equal(ctx.app.config, undefined);
  assert.ok(r.elapsed < 3500);
});

test('a stop kept in /data leaves at start: no getConfig, no scan, no read first', async (t) => {
  const clockData = (dev) => ({
    format: 1,
    attemptAt: 0,
    devices: [knownOf(dev)],
    stops: [{ mac: dev.mac, sent: false, sends: 0, clickedAt: 1 }],
    runs: [],
  });
  const store = memoryStore(null);
  const ctx = await setup(t, { heard: false, created: false, connect: false, store });
  store.data = clockData(ctx.dev);
  failConfig(t, ctx.gladys);
  ctx.dev.power = 1;
  await ctx.gladys.connect();
  await until(ctx.clock, () => ctx.dev.count('off') === 1, 'kept stop sent', { max: 3000 });
  assert.equal(ctx.dev.count('state'), 0, 'no read before it');
  // Written: kept in /data as sent, until a read started after it shows it applied.
  await until(ctx.clock, () => store.data.stops[0]?.sent === true, 'saved as sent');
  assert.equal(store.data.stops[0].sends, 1);
});

test('/data that never answers: stops still leave, several in a row', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store });
  ctx.dev.ignore = true;
  ctx.dev.power = 1;
  store.hang = true;
  for (let i = 1; i <= 3; i += 1) {
    const r = await click(ctx, ctx.dev, 'power', 0);
    assert.equal(r.ok, true, r.error?.message);
    assert.ok(r.elapsed < 3500, `${r.elapsed}`);
    assert.equal(ctx.dev.count('off'), i);
  }
});

test('a stop cuts a read in progress; one connection at a time', async (t) => {
  const ctx = await setup(t);
  await until(ctx.clock, () => ctx.dev.count('state') >= 1, 'first read');
  ctx.dev.mute.add('state');
  const reads = ctx.dev.count('state');
  await until(ctx.clock, () => ctx.dev.count('state') > reads, 'read waiting', { max: 2 * MINUTE });
  ctx.dev.power = 1;
  ctx.dev.mute.clear();
  ctx.dev.mute.add('state');
  const r = await click(ctx, ctx.dev, 'power', 0);
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(ctx.dev.count('off'), 1);
  assert.ok(r.elapsed < 1000, `the read was cut (${r.elapsed} ms)`);
  assert.equal(ctx.sockets.peak, 1);
  // The read cut is not a failure of the device.
  assert.notEqual(ctx.app.rt.get(ctx.dev.mac).ok, false);
});

test('a stop cancels a command still opening: nothing clicked before it leaves after it', async (t) => {
  const ctx = await setup(t, { devices: [{ model: '01a8' }], config: { allow_plug_on: true } });
  await until(ctx.clock, () => ctx.dev.count('state') >= 1, 'first read');
  // The stop is clicked as the device handles the login of the command.
  ctx.dev.latencyMs = 50;
  let off;
  ctx.dev.onRequest = (type) => {
    if (type === 'login' && !off) off = click(ctx, ctx.dev, 'power', 0);
  };
  const on = click(ctx, ctx.dev, 'power', 1);
  await until(ctx.clock, () => off !== undefined, 'stop clicked', { step: 1 });
  off = await off;
  const onResult = await on;
  assert.equal(off.ok, true, off.error?.message);
  assert.equal(onResult.ok, false);
  assert.match(onResult.error.message, /Annulée par un arrêt/);
  assert.equal(ctx.dev.count('on'), 0);
  assert.equal(ctx.dev.count('off'), 1);
  assert.equal(ctx.sockets.peak, 1);
});

test('a stop that cannot leave is kept, never given up, and leaves when the device answers', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store });
  await until(ctx.clock, () => ctx.dev.count('state') >= 1, 'first read');
  ctx.dev.power = 1;
  ctx.dev.refuse = true;
  const r = await click(ctx, ctx.dev, 'power', 0);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /gardé et envoyé dès qu'il répond/);
  assert.ok(r.elapsed < 3500);
  await until(ctx.clock, () => store.data?.stops?.length === 1, 'kept in /data');
  assert.equal(store.data.stops[0].sent, false);
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /Arrêt gardé, pas encore envoyé/);
  // Hours later, never dropped, never counted as tried.
  await ctx.clock.advance(3 * 60 * MINUTE);
  assert.equal(ctx.app.stops.get(ctx.dev.mac).sends, 0);
  assert.equal(store.data.stops[0].sent, false);
  ctx.dev.refuse = false;
  await until(ctx.clock, () => ctx.dev.count('off') === 1, 'stop sent', {
    step: 100,
    max: 2 * MINUTE,
  });
  await until(ctx.clock, () => store.data.stops.length === 0, 'confirmed by a read', {
    step: 100,
    max: 10 * MINUTE,
  });
  assert.equal(ctx.dev.power, 0);
});

test('resent only by reads started after its write, 3 writes at most, never lifted by the time', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store });
  await until(ctx.clock, () => ctx.dev.count('state') >= 1, 'first read');
  ctx.dev.ignore = true;
  ctx.dev.power = 1;
  const r = await click(ctx, ctx.dev, 'power', 0);
  assert.equal(r.ok, true);
  assert.equal(ctx.dev.count('off'), 1);
  // A state read that started before the write (answered after it) never sends it again.
  const stop = ctx.app.stops.get(ctx.dev.mac);
  ctx.app.applyState(ctx.dev.mac, { power: 1, watts: 0 }, stop.sentMono - 0.0005);
  // Nor its own answer.
  await runFor(ctx.clock, 4 * SECOND, { step: 20 });
  assert.equal(ctx.dev.count('off'), 1);
  await until(ctx.clock, () => ctx.dev.count('off') === 2, 'resent by the 5 s read');
  await until(ctx.clock, () => ctx.dev.count('off') === 3, 'resent by the 20 s read');
  const reads = ctx.dev.count('state');
  await runFor(ctx.clock, 5 * MINUTE, { step: 200 });
  assert.ok(ctx.dev.count('state') >= reads + 5, 'still read');
  assert.equal(ctx.dev.count('off'), 3, '3 writes at most');
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /Arrêt reçu 3 fois/);
  await runFor(ctx.clock, 60 * MINUTE, { step: 5000 });
  assert.equal(store.data.stops.length, 1, 'never lifted by the time');
  // Read off: confirmed and lifted (the reads may be backing off after the jump in time).
  ctx.dev.power = 0;
  await until(ctx.clock, () => store.data.stops.length === 0, 'confirmed', {
    step: 100,
    max: 10 * MINUTE,
  });
});

test('a switch-on from Gladys that left lifts the stop', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store, config: { allow_heater_on: true } });
  await until(ctx.clock, () => ctx.dev.count('state') >= 1, 'first read');
  ctx.dev.ignore = true;
  ctx.dev.power = 1;
  await click(ctx, ctx.dev, 'power', 0);
  await until(ctx.clock, () => store.data.stops.length === 1, 'kept');
  ctx.dev.ignore = false;
  const offs = ctx.dev.count('off');
  const r = await click(ctx, ctx.dev, 'power', 1);
  assert.equal(r.ok, true, r.error?.message);
  await until(ctx.clock, () => store.data.stops.length === 0, 'lifted');
  assert.equal(ctx.app.stops.size, 0);
  // Never sent again over the newer switch-on.
  await runFor(ctx.clock, 40 * SECOND, { step: 200 });
  assert.equal(ctx.dev.count('off'), offs);
  assert.equal(ctx.dev.power, 1);
});

test('a shutter stop needs no option, is never kept in /data, and is momentary', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store, devices: [{ model: '0c01' }] });
  await until(ctx.clock, () => ctx.dev.count('state') >= 1, 'first read');
  ctx.dev.direction = 'down';
  const r = await click(ctx, ctx.dev, 'state', 0);
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(ctx.dev.count('stop'), 1);
  assert.equal(ctx.dev.direction, 'stop');
  ctx.dev.refuse = true;
  const kept = await click(ctx, ctx.dev, 'state', 0);
  assert.equal(kept.ok, false);
  await runFor(ctx.clock, 2 * MINUTE);
  assert.equal(ctx.app.stops.get(ctx.dev.mac)?.sent, false, 'kept in RAM');
  await ctx.app.saveMemory();
  assert.equal(store.data.stops.length, 0, 'never in /data');
  assert.equal(ctx.dev.count('stop'), 1);
  await runFor(ctx.clock, 70 * SECOND);
  ctx.dev.refuse = false;
  await runFor(ctx.clock, 3 * MINUTE);
  assert.equal(ctx.dev.count('stop'), 1, 'not sent past the travel of the shutter');
});

test('Breeze: off with the code of its remote; a toggle remote is read only and refused', async (t) => {
  const ctx = await setup(t, {
    devices: [{ model: '0e01' }, { model: '0e01', remote: 'ELEC7001' }],
  });
  const [breeze, toggle] = ctx.devs;
  breeze.power = 1;
  const r = await click(ctx, breeze, 'power', 0);
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(breeze.last('ir').code, breeze.offCode);
  assert.equal(breeze.power, 0);
  const on = await click(ctx, breeze, 'power', 1);
  assert.match(on.error.message, /pas prise en charge/);
  const device = ctx.gladys.fake.discoveredDevices.find((d) => d.external_id === F(toggle));
  assert.equal(device.features.find((f) => f.external_id === F(toggle, 'power')).read_only, true);
  const refused = await click(ctx, toggle, 'power', 0);
  assert.match(refused.error.message, /code « arrêt » simple/);
  assert.equal(toggle.count('ir'), 0);
});

test('a device that never answers the login: the stop answers within 3.5 s, kept', async (t) => {
  const ctx = await setup(t);
  await until(ctx.clock, () => ctx.dev.count('state') >= 1, 'first read');
  ctx.dev.mute.add('login');
  const r = await click(ctx, ctx.dev, 'power', 0);
  assert.equal(r.ok, false);
  assert.ok(r.elapsed <= 3500, `${r.elapsed}`);
  assert.equal(ctx.dev.count('off'), 0);
  assert.equal(ctx.app.stops.get(ctx.dev.mac).sent, false);
  ctx.dev.mute.clear();
  await until(ctx.clock, () => ctx.dev.count('off') === 1, 'sent later', { max: MINUTE });
});

test('at start, a kept stop sent but not confirmed is sent again within its 3 writes, never beyond', async (t) => {
  for (const [sends, expected] of [
    [1, 1],
    [3, 0],
  ]) {
    const store = memoryStore(null);
    const ctx = await setup(t, { heard: false, created: false, connect: false, store });
    store.data = {
      format: 1,
      attemptAt: 0,
      devices: [knownOf(ctx.dev)],
      stops: [{ mac: ctx.dev.mac, sent: true, sends, clickedAt: 1 }],
      runs: [],
    };
    ctx.dev.ignore = true;
    ctx.dev.power = 1;
    await ctx.gladys.connect();
    await runFor(ctx.clock, 3 * SECOND, { step: 20 });
    assert.equal(ctx.dev.count('off'), expected, `sends kept: ${sends}`);
  }
});

test('a stop the device never answers is never given up; only answered writes count', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store });
  await until(ctx.clock, () => ctx.app.rt.get(ctx.dev.mac)?.ok === true, 'first read');
  ctx.dev.power = 1;
  // The device takes the stops in but neither answers nor applies them.
  ctx.dev.mute.add('off');
  ctx.dev.ignore = true;
  const r = await click(ctx, ctx.dev, 'power', 0);
  assert.equal(r.ok, true);
  await until(ctx.clock, () => ctx.dev.count('off') >= 4, '4 writes', {
    step: 100,
    max: 5 * MINUTE,
  });
  assert.equal(ctx.app.stops.get(ctx.dev.mac).sends, 0);
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /l'appareil n'a pas répondu/);
  assert.equal(store.data.stops.length, 1);
  // Back to normal: the next send is applied and confirmed.
  ctx.dev.mute.clear();
  ctx.dev.ignore = false;
  await until(ctx.clock, () => ctx.dev.power === 0, 'applied', { step: 100, max: 5 * MINUTE });
  await until(ctx.clock, () => store.data.stops.length === 0, 'confirmed', {
    step: 100,
    max: 5 * MINUTE,
  });
});

test('a stop goes before a read waiting for the lane', async (t) => {
  const ctx = await setup(t, { config: { read_interval: 600 } });
  await until(ctx.clock, () => ctx.app.rt.get(ctx.dev.mac)?.ok === true, 'first read');
  ctx.dev.mute.add('state');
  // A read in progress (its state never answered), another one waiting behind it.
  const first = ctx.app.read(ctx.dev.mac);
  await until(ctx.clock, () => ctx.dev.count('state') >= 2, 'read in progress');
  const second = ctx.app.read(ctx.dev.mac);
  await runFor(ctx.clock, 50, { step: 10 });
  ctx.dev.power = 1;
  const states = ctx.dev.count('state');
  const r = await click(ctx, ctx.dev, 'power', 0);
  assert.equal(r.ok, true, r.error?.message);
  const types = ctx.dev.requests.map((q) => q.type);
  const off = types.indexOf('off');
  assert.ok(off >= 0);
  assert.equal(
    types.slice(0, off).filter((x) => x === 'state').length,
    states,
    'the read waiting came after the stop',
  );
  ctx.dev.mute.clear();
  await runFor(ctx.clock, 5 * SECOND, { step: 50 });
  await Promise.allSettled([first, second]);
  assert.ok(types.length <= ctx.dev.requests.length);
});

test('a kept stop goes first at the next read, and at the next scan', async (t) => {
  const ctx = await setup(t, { config: { read_interval: 600 } });
  await until(ctx.clock, () => ctx.app.rt.get(ctx.dev.mac)?.ok === true, 'first read');
  ctx.dev.power = 1;
  ctx.dev.refuse = true;
  const r = await click(ctx, ctx.dev, 'power', 0);
  assert.equal(r.ok, false);
  const rt = ctx.app.rt.get(ctx.dev.mac);
  // The retry timer out of the way: only the read can send it.
  ctx.clock.timers.clearTimeout(rt.stopTimer);
  ctx.dev.refuse = false;
  const before = ctx.dev.requests.length;
  await ctx.app.read(ctx.dev.mac).catch(() => {});
  await runFor(ctx.clock, SECOND, { step: 20 });
  const types = ctx.dev.requests.slice(before).map((q) => q.type);
  assert.ok(types.includes('off'), types.join());
  assert.ok(
    !types.includes('state') || types.indexOf('off') < types.indexOf('state'),
    `the stop first: ${types.join()}`,
  );
  // Again with a scan.
  ctx.dev.power = 1;
  ctx.dev.refuse = true;
  assert.equal((await click(ctx, ctx.dev, 'power', 0)).ok, false);
  ctx.clock.timers.clearTimeout(rt.stopTimer);
  ctx.dev.refuse = false;
  const offs = ctx.dev.count('off');
  await ctx.app.scan();
  await runFor(ctx.clock, SECOND, { step: 20 });
  assert.equal(ctx.dev.count('off'), offs + 1);
});

test('a stop never answered: resent at the periodic reads only, /data written only when it changes', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store });
  await until(ctx.clock, () => ctx.app.rt.get(ctx.dev.mac)?.ok === true, 'first read');
  ctx.dev.power = 1;
  ctx.dev.mute.add('off');
  ctx.dev.ignore = true;
  const reads = ctx.dev.count('state');
  const saves = store.saves;
  assert.equal((await click(ctx, ctx.dev, 'power', 0)).ok, true);
  await runFor(ctx.clock, 5 * MINUTE, { step: 100 });
  const readCount = ctx.dev.count('state') - reads;
  // Every 30 s, plus the reads 5 s and 20 s after the click.
  assert.ok(readCount <= 10 + 2 + 1, `${readCount} reads in 5 min`);
  assert.ok(ctx.dev.count('off') <= readCount + 1, `${ctx.dev.count('off')} stop writes`);
  assert.ok(ctx.dev.count('off') >= 5, 'still resent');
  // The attempt time before each periodic read, and the stop when it changed.
  assert.ok(store.saves - saves <= readCount + 3, `${store.saves - saves} writes of /data`);
});

test('once a heater passed its CRC, a frame with another CRC never lifts its stop', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store });
  await until(ctx.clock, () => ctx.app.rt.get(ctx.dev.mac)?.ok === true, 'first read');
  ctx.dev.power = 1;
  ctx.dev.ignore = true;
  await click(ctx, ctx.dev, 'power', 0);
  // The device now reads "off", but with another CRC.
  ctx.dev.garbage = true;
  ctx.dev.power = 0;
  await runFor(ctx.clock, 2 * MINUTE, { step: 100 });
  assert.equal(store.data.stops.length, 1, 'kept');
  assert.equal(ctx.app.rt.get(ctx.dev.mac).ok, false);
});
