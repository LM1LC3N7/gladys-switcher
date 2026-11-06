// -----------------------------------------------------------------------------
// The commands other than the stops: each behind its option, decided at the
// click and again right before the write, confirmed only by a later read.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { F, MINUTE, SECOND, click, hear, knownOf, runFor, setup, until } from './helpers/app.js';

const ALL = { allow_heater_on: true, allow_plug_on: true, allow_shutter_moves: true };

test('every command but the stops is off by default', async (t) => {
  const ctx = await setup(t, {
    devices: [{ model: '0317' }, { model: '01a8' }, { model: '0c01' }],
  });
  const [heater, plug, runner] = ctx.devs;
  const refused = [
    [heater, 'power', 1, /chauffe-eau est désactivée/],
    [plug, 'power', 1, /prise est désactivée/],
    [runner, 'state', 1, /volet est désactivé/],
    [runner, 'state', -1, /volet est désactivé/],
    [runner, 'position', 40, /volet est désactivé/],
  ];
  for (const [dev, key, value, text] of refused) {
    const r = await click(ctx, dev, key, value);
    assert.equal(r.ok, false);
    assert.match(r.error.message, text);
  }
  assert.equal(heater.count('on') + plug.count('on') + runner.count('position'), 0);
});

test('refused, nothing sent: configuration unread, address not confirmed, /data unwritable', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, {
    store,
    config: ALL,
    devices: [{ model: '0317' }, { model: '01a8' }],
  });
  const plug = ctx.devs[1];
  // /data unwritable: the plug too (a stop could not be kept).
  store.fail = true;
  await ctx.app.saveMemory();
  let r = await click(ctx, plug, 'power', 1);
  assert.match(r.error.message, /\/data ne peut pas être écrit/);
  assert.equal(plug.count('on'), 0);
  store.fail = false;
  await ctx.app.saveMemory();
  // Not seen by a scan for 15 min.
  hear(ctx, []);
  await runFor(ctx.clock, 16 * MINUTE, { step: 1000 });
  r = await click(ctx, ctx.dev, 'power', 1);
  assert.match(r.error.message, /pas confirmée par une recherche récente/);
  assert.equal(ctx.dev.count('on'), 0);
  // The stop still leaves.
  ctx.dev.power = 1;
  assert.equal((await click(ctx, ctx.dev, 'power', 0)).ok, true);
  // Configuration unread.
  ctx.app.config = undefined;
  r = await click(ctx, ctx.dev, 'power', 1);
  assert.match(r.error.message, /configuration n'est pas encore lue/);
});

test('a water heater switch-on carries the configured run; an odd value takes 60 min', async (t) => {
  const ctx = await setup(t, { config: { allow_heater_on: true, heater_minutes: 20 } });
  let r = await click(ctx, ctx.dev, 'power', 1);
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(ctx.dev.last('on').timer, 20 * 60);
  await ctx.gladys.fake.configUpdated({ allow_heater_on: true, heater_minutes: 9999 });
  r = await click(ctx, ctx.dev, 'power', 1);
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(ctx.dev.last('on').timer, 60 * 60);
  for (const value of [2, -1, 0.5, '', null, true, 'on']) {
    r = await click(ctx, ctx.dev, 'power', value);
    assert.equal(r.ok, false, String(value));
  }
  assert.equal(ctx.dev.count('on'), 2);
});

test('the option unticked while the command logs in: nothing is sent', async (t) => {
  const ctx = await setup(t, { devices: [{ model: '01a8' }], config: { allow_plug_on: true } });
  await until(ctx.clock, () => ctx.app.rt.get(ctx.dev.mac)?.ok === true, 'first read');
  // Unticked as the device handles the login of the command, before its answer.
  ctx.dev.latencyMs = 50;
  let unticked;
  ctx.dev.onRequest = (type) => {
    if (type === 'login' && !unticked) {
      unticked = ctx.gladys.fake.configUpdated({ allow_plug_on: false });
    }
  };
  const pending = click(ctx, ctx.dev, 'power', 1);
  const r = await pending;
  assert.equal(r.ok, false);
  assert.match(r.error.message, /rien n'a été envoyé/);
  assert.equal(ctx.dev.count('on'), 0);
});

test('the address no longer confirmed while the command logs in: nothing is sent', async (t) => {
  const ctx = await setup(t, { devices: [{ model: '01a8' }], config: { allow_plug_on: true } });
  await until(ctx.clock, () => ctx.app.rt.get(ctx.dev.mac)?.ok === true, 'first read');
  ctx.dev.onRequest = (type) => {
    // The last scan that saw it becomes older than 15 minutes.
    if (type === 'login') ctx.app.rt.get(ctx.dev.mac).seenAt = -Infinity;
  };
  const r = await click(ctx, ctx.dev, 'power', 1);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /rien n'a été envoyé/);
  assert.equal(ctx.dev.count('on'), 0);
});

test('a command cuts a read in progress, which is not a failure', async (t) => {
  const ctx = await setup(t, { devices: [{ model: '01a8' }], config: { allow_plug_on: true } });
  await until(ctx.clock, () => ctx.app.rt.get(ctx.dev.mac)?.ok === true, 'first read');
  ctx.dev.mute.add('state');
  const reads = ctx.dev.count('state');
  await until(ctx.clock, () => ctx.dev.count('state') > reads, 'read waiting', {
    max: 2 * MINUTE,
  });
  // That read is never answered; the next ones are.
  ctx.dev.mute.clear();
  const r = await click(ctx, ctx.dev, 'power', 1);
  assert.equal(r.ok, true, r.error?.message);
  assert.ok(r.elapsed < 1200, `cut, not waited for (${r.elapsed} ms)`);
  assert.equal(ctx.dev.count('on'), 1);
  // Cut, not timed out: never counted as a failure of the device.
  assert.notEqual(ctx.app.rt.get(ctx.dev.mac).ok, false);
  assert.equal(ctx.app.rt.get(ctx.dev.mac).failures, 0);
  assert.equal(ctx.sockets.peak, 1);
});

test('refused while a stop of the device is being sent', async (t) => {
  const ctx = await setup(t, { devices: [{ model: '01a8' }], config: { allow_plug_on: true } });
  await until(ctx.clock, () => ctx.app.rt.get(ctx.dev.mac)?.ok === true, 'first read');
  // Clicked on as the device handles the login of the stop.
  ctx.dev.latencyMs = 50;
  let on;
  ctx.dev.onRequest = (type) => {
    if (type === 'login' && !on) on = click(ctx, ctx.dev, 'power', 1);
  };
  const stop = click(ctx, ctx.dev, 'power', 0);
  await until(ctx.clock, () => on !== undefined, 'on clicked', { step: 1 });
  const r = await on;
  assert.equal(r.ok, false);
  assert.match(r.error.message, /arrêt de cet appareil est en cours/);
  assert.equal((await stop).ok, true);
  assert.equal(ctx.dev.count('on'), 0);
});

test('a command not applied: sent, without confirmation; read again 5 s and 20 s later', async (t) => {
  const ctx = await setup(t, { devices: [{ model: '01a8' }], config: { allow_plug_on: true } });
  await until(ctx.clock, () => ctx.dev.count('state') >= 1, 'first read');
  ctx.dev.ignore = true;
  const r = await click(ctx, ctx.dev, 'power', 1);
  assert.equal(r.ok, true);
  assert.ok(r.elapsed < 3500);
  assert.equal(ctx.dev.count('on'), 1);
  await until(
    ctx.clock,
    () =>
      ctx.gladys.fake.transports.some((b) => b.degraded && /sans confirmation/.test(b.message?.fr)),
    'badge',
  );
  const sent = ctx.dev.last('on').at;
  await until(
    ctx.clock,
    () => ctx.dev.requests.some((q) => q.type === 'state' && q.at >= sent + 4900),
    '5 s',
  );
  await until(
    ctx.clock,
    () => ctx.dev.requests.some((q) => q.type === 'state' && q.at >= sent + 19900),
    '20 s',
  );
  assert.equal(ctx.app.rt.get(ctx.dev.mac).expect !== undefined, true, 'still not confirmed');
  // Applied: confirmed by the next read.
  ctx.dev.power = 1;
  await until(ctx.clock, () => ctx.app.rt.get(ctx.dev.mac).expect === undefined, 'confirmed');
});

test('a read equal to the state before, right after the write, does not confirm', async (t) => {
  const ctx = await setup(t, { devices: [{ model: '01a8' }], config: { allow_plug_on: true } });
  ctx.dev.power = 1;
  await until(ctx.clock, () => ctx.gladys.fake.lastState(F(ctx.dev, 'power')) === 1, 'on', {
    max: 2 * MINUTE,
  });
  ctx.dev.ignore = true;
  const r = await click(ctx, ctx.dev, 'power', 1);
  assert.equal(r.ok, true);
  assert.notEqual(ctx.app.rt.get(ctx.dev.mac).expect, undefined, 'not confirmed by the quick read');
  await until(ctx.clock, () => ctx.app.rt.get(ctx.dev.mac).expect === undefined, 'follow-up');
});

test('shutter: open, close and position, values checked', async (t) => {
  const ctx = await setup(t, { devices: [{ model: '0c01' }], config: ALL });
  let r = await click(ctx, ctx.dev, 'state', 1);
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(ctx.dev.last('position').position, 100);
  r = await click(ctx, ctx.dev, 'state', -1);
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(ctx.dev.last('position').position, 0);
  r = await click(ctx, ctx.dev, 'position', 37);
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(ctx.dev.last('position').position, 37);
  for (const value of [101, -1, 37.5, '', null, true]) {
    r = await click(ctx, ctx.dev, 'position', value);
    assert.equal(r.ok, false, String(value));
  }
  r = await click(ctx, ctx.dev, 'state', 2);
  assert.equal(r.ok, false);
  assert.equal(ctx.dev.count('position'), 3);
});

test('a water heater is switched on only once its run is written to /data', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store, config: { allow_heater_on: true } });
  // The last save worked; this one fails.
  store.fail = true;
  let r = await click(ctx, ctx.dev, 'power', 1);
  assert.match(r.error.message, /\/data ne peut pas être écrit/);
  store.fail = false;
  await ctx.app.saveMemory();
  // A save that hangs: refused within the ack, nothing sent.
  store.hang = true;
  r = await click(ctx, ctx.dev, 'power', 1);
  assert.equal(r.ok, false);
  assert.ok(r.elapsed < 3500);
  assert.equal(ctx.dev.count('on'), 0);
});

test('a run the device does not end is switched off by the module; restarted elsewhere, left alone', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store, config: { allow_heater_on: true, heater_minutes: 10 } });
  ctx.dev.noTimer = true;
  const r = await click(ctx, ctx.dev, 'power', 1);
  assert.equal(r.ok, true);
  assert.equal(store.data.runs.length, 1);
  // A read that started before the switch-on left says nothing about the run.
  const run = ctx.app.runs.get(ctx.dev.mac);
  ctx.app.checkRun(ctx.dev.mac, { power: 0 }, run.sentMono - 0.0005);
  assert.equal(ctx.app.runs.get(ctx.dev.mac), run);
  await runFor(ctx.clock, 11 * MINUTE, { step: 1000 });
  assert.equal(ctx.dev.count('off'), 0, 'not before the end and its grace');
  await until(ctx.clock, () => ctx.dev.count('off') === 1, 'ended by the module', {
    step: 1000,
    max: 3 * MINUTE,
  });
  assert.equal(store.data.runs.length, 0);
  // Switched on again, then off and on elsewhere (time on shorter than the run): not stopped.
  await click(ctx, ctx.dev, 'power', 1);
  await runFor(ctx.clock, 5 * MINUTE, { step: 1000 });
  ctx.dev.onSince = ctx.clock.elapsed;
  await runFor(ctx.clock, 10 * MINUTE, { step: 1000 });
  assert.equal(ctx.dev.count('off'), 1);
  assert.equal(store.data.runs.length, 0);
});

test('a run kept in /data is still bounded after a restart', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store, connect: false, heard: (d) => d });
  store.data = {
    format: 1,
    attemptAt: 0,
    devices: [knownOf(ctx.dev)],
    stops: [],
    runs: [{ mac: ctx.dev.mac, minutes: 5, startedAt: ctx.clock.now() - 10 * MINUTE }],
  };
  ctx.dev.power = 1;
  ctx.dev.onSince = ctx.clock.elapsed - 10 * MINUTE;
  await ctx.gladys.connect();
  await until(ctx.clock, () => ctx.dev.count('off') === 1, 'stopped after restart', {
    max: MINUTE,
  });
});

test('commands on 5 devices at once all leave', async (t) => {
  const ctx = await setup(t, {
    devices: [1, 2, 3, 4, 5].map(() => ({ model: '01a8' })),
    config: { allow_plug_on: true },
  });
  const results = await Promise.all(ctx.devs.map((dev) => click(ctx, dev, 'power', 1)));
  for (const r of results) assert.equal(r.ok, true, r.error?.message);
  assert.ok(ctx.devs.every((d) => d.count('on') === 1 && d.power === 1));
  void SECOND;
});

test('a heater whose time on always reads 0 is still switched off at the end of its run', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store, config: { allow_heater_on: true, heater_minutes: 5 } });
  ctx.dev.noTimer = true;
  ctx.dev.timeOnZero = true;
  assert.equal((await click(ctx, ctx.dev, 'power', 1)).ok, true);
  await until(ctx.clock, () => ctx.dev.count('off') === 1, 'ended by the module', {
    step: 1000,
    max: 10 * MINUTE,
  });
});

test('a run read off is over: never stopped later by the module', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store, config: { allow_heater_on: true, heater_minutes: 5 } });
  ctx.dev.noTimer = true;
  ctx.dev.timeOnZero = true;
  assert.equal((await click(ctx, ctx.dev, 'power', 1)).ok, true);
  // Switched off from the app, then on again from the app.
  await runFor(ctx.clock, MINUTE, { step: 500 });
  ctx.dev.power = 0;
  await until(ctx.clock, () => store.data.runs.length === 0, 'run over', {
    step: 500,
    max: 2 * MINUTE,
  });
  ctx.dev.power = 1;
  await runFor(ctx.clock, 10 * MINUTE, { step: 1000 });
  assert.equal(ctx.dev.count('off'), 0);
});
