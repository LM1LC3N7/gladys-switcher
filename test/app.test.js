// -----------------------------------------------------------------------------
// The app end to end: scans, reads, commands and stops against fake devices.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { F, MINUTE, SECOND, click, setup, until } from './helpers/app.js';

test('a scan publishes the supported devices with their identity', async (t) => {
  const ctx = await setup(t, {
    devices: [{ model: '0317' }, { model: '01a8' }, { model: '0c01' }, { model: '0e01' }],
    created: false,
  });
  await until(ctx.clock, () => ctx.gladys.fake.discoveredDevices.length === 4, 'discovery');
  const found = ctx.gladys.fake.discoveredDevices;
  for (const dev of ctx.devs) {
    const d = found.find((x) => x.external_id === F(dev));
    assert.ok(d, dev.kind);
    const params = Object.fromEntries(d.params.map((p) => [p.name, p.value]));
    assert.equal(params.SWITCHER_MAC, dev.mac);
    assert.equal(params.SWITCHER_ID, dev.id);
    assert.equal(params.IP_ADDRESS, dev.ip);
  }
});

test('reads publish the states of each device every interval', async (t) => {
  const ctx = await setup(t, {
    devices: [{ model: '0317' }, { model: '0c01' }, { model: '0e01' }],
  });
  const [heater, runner, breeze] = ctx.devs;
  heater.power = 1;
  heater.watts = 2400;
  heater.onSince = ctx.clock.elapsed;
  heater.timerEnd = ctx.clock.elapsed + 30 * MINUTE;
  await until(ctx.clock, () => ctx.gladys.fake.lastState(F(heater, 'power')) === 1, 'heater', {
    max: 2 * MINUTE,
  });
  await until(ctx.clock, () => ctx.gladys.fake.lastState(F(runner, 'position')) === 50, 'runner');
  await until(
    ctx.clock,
    () => ctx.gladys.fake.lastState(F(breeze, 'temperature')) === 24.5,
    'breeze',
  );
  assert.equal(ctx.gladys.fake.lastState(F(heater, 'consumption')), 2400);
  assert.equal(ctx.gladys.fake.lastState(F(breeze, 'mode')), 4);
  const reads = heater.count('state');
  const last = heater.last('state').at;
  await runFor(ctx.clock, last + 29 * SECOND - ctx.clock.elapsed, { step: 50 });
  assert.equal(heater.count('state'), reads, 'not sooner than the interval');
  await until(ctx.clock, () => heater.count('state') === reads + 1, 'next read');
  // The request reaches the device a few ms after the start of its read.
  assert.ok(heater.last('state').at - last >= 29.9 * SECOND);
});

test('switching a water heater off is never behind an option', async (t) => {
  const ctx = await setup(t);
  ctx.dev.power = 1;
  const r = await click(ctx, ctx.dev, 'power', 0);
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(ctx.dev.count('off'), 1);
  assert.equal(ctx.dev.power, 0);
  assert.ok(r.elapsed < 3500);
});

test('switching a water heater on is off by default; allowed, it carries the run length', async (t) => {
  const ctx = await setup(t);
  const r = await click(ctx, ctx.dev, 'power', 1);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /désactivée/);
  assert.equal(ctx.dev.count('on'), 0);
  await ctx.gladys.fake.configUpdated({ allow_heater_on: true, heater_minutes: 45 });
  const r2 = await click(ctx, ctx.dev, 'power', 1);
  assert.equal(r2.ok, true, r2.error?.message);
  assert.equal(ctx.dev.last('on').timer, 45 * 60);
});

// --- lifecycle ---------------------------------------------------------------

import { GladysApiError } from '@gladysassistant/integration-sdk';
import { memoryStore } from '../src/store.js';
import { failConfig, hear, knownOf, runFor } from './helpers/app.js';

test('getConfig() failing in `connected`: tried again with a status, then the reads start', async (t) => {
  const ctx = await setup(t, { connect: false });
  failConfig(t, ctx.gladys, { times: 2 });
  await ctx.gladys.connect();
  assert.equal(ctx.app.config, undefined);
  assert.match(
    ctx.gladys.fake.connectionStatus.message.fr,
    /configuration de Gladys n'a pas pu être lue/,
  );
  assert.equal(ctx.dev.count('state'), 0);
  await until(ctx.clock, () => ctx.app.config !== undefined, 'config read', { max: MINUTE });
  await until(ctx.clock, () => ctx.dev.count('state') >= 1, 'first read');
  assert.doesNotMatch(ctx.gladys.fake.connectionStatus.message.fr, /pas pu être lue/);
});

test('a restart never reads sooner than the interval after the last attempt kept in /data', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store, connect: false });
  store.data = {
    format: 1,
    attemptAt: ctx.clock.now() - 10 * SECOND,
    devices: [knownOf(ctx.dev)],
    stops: [],
    runs: [],
  };
  await ctx.gladys.connect();
  await runFor(ctx.clock, 19 * SECOND, { step: 50 });
  assert.equal(ctx.dev.count('state'), 0);
  await until(ctx.clock, () => ctx.dev.count('state') === 1, 'read at 20 s', { max: 3 * SECOND });
});

test('failed reads back off (30 s, 1, 2, 5 min), never a storm; a reconnection reads nothing', async (t) => {
  const ctx = await setup(t);
  await until(ctx.clock, () => ctx.dev.count('state') >= 1, 'first read');
  ctx.dev.refuse = true;
  const before = ctx.dev.connections;
  await runFor(ctx.clock, 10 * MINUTE, { step: 200 });
  const tries = ctx.dev.connections - before;
  assert.ok(tries >= 4 && tries <= 7, `${tries} tries in 10 min`);
  ctx.dev.refuse = false;
  await until(ctx.clock, () => ctx.app.rt.get(ctx.dev.mac).ok === true, 'back', {
    step: 200,
    max: 6 * MINUTE,
  });
  const reads = ctx.dev.count('state');
  await ctx.app.publisher.flush();
  const states = ctx.gladys.fake.states.length;
  await ctx.app.connected();
  await runFor(ctx.clock, 2 * SECOND, { step: 50 });
  assert.equal(ctx.dev.count('state'), reads, 'no read on a reconnection');
  assert.equal(ctx.gladys.fake.states.length, states, 'nothing old published again');
});

test('scans: an address that moved is followed; two devices on one address are not trusted', async (t) => {
  const ctx = await setup(t, { devices: [{ model: '0317' }, { model: '01a8' }] });
  const [a, b] = ctx.devs;
  await until(ctx.clock, () => a.count('state') >= 1 && b.count('state') >= 1, 'reads');
  // b now announces a's address: neither is trusted there.
  ctx.gladys.fake.scanResults = {
    'udp-broadcast': [
      a.announcement(),
      { ...b.announcement(), ...b.announcement({ sourceIp: a.ip }) },
    ],
  };
  const edited = { ...b, ip: a.ip };
  ctx.gladys.fake.scanResults = {
    'udp-broadcast': [
      a.announcement(),
      (await import('./helpers/fakeSwitcher.js')).announcement(edited),
    ],
  };
  await ctx.app.scan({ publish: true });
  const ipOf = (dev) =>
    ctx.gladys.fake.discoveredDevices
      .find((d) => d.external_id === F(dev))
      .params.find((p) => p.name === 'IP_ADDRESS')?.value;
  assert.equal(ipOf(a), a.ip, 'unchanged: the conflict is not taken');
  assert.equal(ipOf(b), b.ip);
  // An announcement whose source is not the address inside: ignored.
  hear(ctx, []);
  ctx.gladys.fake.scanResults = { 'udp-broadcast': [b.announcement({ sourceIp: '127.0.0.99' })] };
  const { heard } = await ctx.app.scan();
  assert.deepEqual(heard, []);
});

test('the Test button scans and names what it heard, the token models included', async (t) => {
  const ctx = await setup(t, { devices: [{ model: '0317', name: 'Boiler' }] });
  const token = {
    ...knownOf(ctx.dev),
    mac: '0a00000000ff',
    model: '0f02',
    ip: '127.0.0.99',
    name: 'Runner plus',
  };
  const { announcement } = await import('./helpers/fakeSwitcher.js');
  ctx.gladys.fake.scanResults = {
    'udp-broadcast': [ctx.dev.announcement(), announcement({ ...token, family: 2 })],
  };
  const ack = await ctx.gladys.fake.action('test_connection', {});
  assert.equal(ack.success, true);
  assert.match(ack.data?.message ?? JSON.stringify(ack), /1 appareil\(s\) entendu\(s\) \(Boiler\)/);
  assert.match(JSON.stringify(ack), /jeton du compte Switcher/);
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /Runner plus \(Switcher Runner S12\)/);
  assert.equal(
    ctx.gladys.fake.discoveredDevices.some((d) => d.external_id.endsWith('0a00000000ff')),
    false,
  );
});

test('a Gladys without the network scan: said in the status', async (t) => {
  const ctx = await setup(t, { connect: false, created: false });
  t.mock.method(ctx.gladys, 'scanNetwork', async () => {
    throw new GladysApiError(404, 'NOT_FOUND', 'no route');
  });
  await ctx.gladys.connect();
  await until(ctx.clock, () => ctx.app.scanState === 'unavailable', 'scan');
  assert.match(
    ctx.gladys.fake.connectionStatus.message.fr,
    /recherche réseau de Gladys n'est pas disponible/,
  );
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
});

test('/data unreadable at start: read again, never overwritten; a stop clicked meanwhile is kept', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store, connect: false });
  // The file holds an old stop of the device, sent 3 times.
  store.data = {
    format: 1,
    attemptAt: 0,
    devices: [knownOf(ctx.dev)],
    stops: [{ mac: ctx.dev.mac, sent: true, sends: 3, clickedAt: 1 }],
    runs: [],
  };
  store.unreadable = true;
  await ctx.gladys.connect();
  assert.equal(ctx.app.memoryState, 'unreadable');
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /\/data est illisible/);
  ctx.dev.ignore = true;
  ctx.dev.power = 1;
  await click(ctx, ctx.dev, 'power', 0);
  const saves = store.saves;
  await runFor(ctx.clock, 5 * SECOND);
  assert.equal(store.saves, saves, 'nothing written over it');
  assert.equal(store.data.stops[0].sends, 3);
  const loads = store.loads;
  store.unreadable = false;
  await until(ctx.clock, () => ctx.app.memoryState === 'ok', 'read again', { max: 15 * SECOND });
  assert.ok(store.loads > loads);
  // The click made meanwhile wins over the file (its own count of writes).
  await until(
    ctx.clock,
    () => ctx.app.memoryState === 'ok' && store.data.stops[0].clickedAt > 1,
    'the stop clicked meanwhile kept',
  );
  assert.ok(ctx.app.stops.get(ctx.dev.mac).clickedAt > 1);
  assert.ok(ctx.dev.count('off') <= 3);
});

test('/data that hangs at start: read again later, one read at a time, taken when it answers', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store, connect: false });
  store.data = { format: 1, attemptAt: 0, devices: [knownOf(ctx.dev)], stops: [], runs: [] };
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const load = store.load.bind(store);
  let loads = 0;
  store.load = async () => {
    loads += 1;
    await gate;
    return load();
  };
  const connecting = ctx.gladys.connect();
  await until(ctx.clock, () => ctx.app.memoryState === 'unreadable', 'load given up');
  await until(
    ctx.clock,
    async () => {
      await Promise.race([connecting, new Promise((r) => setTimeout(r, 1))]);
      return true;
    },
    'connected',
  );
  await runFor(ctx.clock, 35 * SECOND, { step: 500 });
  assert.equal(loads, 1, 'one read at a time');
  release();
  await until(ctx.clock, () => ctx.app.memoryState === 'ok', 'late answer taken');
});

test('a read older than the one shown is never published over it (order of start)', async (t) => {
  const ctx = await setup(t, { devices: [{ model: '01a8' }] });
  await until(ctx.clock, () => ctx.app.rt.get(ctx.dev.mac)?.ok === true, 'first read');
  const rt = ctx.app.rt.get(ctx.dev.mac);
  const newer = rt.appliedStart + 1000;
  ctx.app.applyState(ctx.dev.mac, { power: 1, watts: 5 }, newer);
  ctx.app.applyState(ctx.dev.mac, { power: 0, watts: 0 }, newer - 500);
  assert.equal(rt.state.power, 1);
  await ctx.app.publisher.flush();
  assert.equal(ctx.gladys.fake.lastState(F(ctx.dev, 'power')), 1);
});

test('only the devices created in Gladys are read; a creation reads it at its turn', async (t) => {
  const ctx = await setup(t, { created: false });
  await runFor(ctx.clock, 40 * SECOND, { step: 200 });
  assert.equal(ctx.dev.count('state'), 0);
  const device = ctx.gladys.fake.discoveredDevices[0];
  await ctx.gladys.fake.deviceCreated(device);
  await until(ctx.clock, () => ctx.dev.count('state') === 1, 'read once created', {
    max: 40 * SECOND,
  });
});

test('failing scans keep the reads; scans that work without the device stop them', async (t) => {
  const ctx = await setup(t, { config: { allow_heater_on: true } });
  await until(ctx.clock, () => ctx.dev.count('state') >= 1, 'first read');
  const scan = t.mock.method(ctx.gladys, 'scanNetwork', async () => {
    throw new GladysApiError(503, 'UNAVAILABLE', 'busy');
  });
  await runFor(ctx.clock, 20 * MINUTE, { step: 1000 });
  const reads = ctx.dev.count('state');
  await runFor(ctx.clock, MINUTE, { step: 500 });
  assert.ok(ctx.dev.count('state') > reads, 'still read');
  // But no command without a recent scan.
  const r = await click(ctx, ctx.dev, 'power', 1);
  assert.match(r.error.message, /pas confirmée par une recherche récente/);
  scan.mock.restore();
  hear(ctx, []);
  await runFor(ctx.clock, 6 * MINUTE, { step: 1000 });
  const after = ctx.dev.count('state');
  await runFor(ctx.clock, 2 * MINUTE, { step: 1000 });
  assert.equal(ctx.dev.count('state'), after, 'no longer read');
});

test('a new interval never reads sooner than it after the last read', async (t) => {
  const ctx = await setup(t);
  await until(ctx.clock, () => ctx.app.rt.get(ctx.dev.mac)?.ok === true, 'first read');
  const last = ctx.dev.last('state').at;
  await ctx.gladys.fake.configUpdated({ read_interval: 40 });
  await runFor(ctx.clock, last + 39 * SECOND - ctx.clock.elapsed, { step: 50 });
  assert.equal(ctx.dev.last('state').at, last);
  await until(ctx.clock, () => ctx.dev.last('state').at > last, 'read at 40 s', {
    max: 5 * SECOND,
  });
});

test('CRC: family 1 frames that differ are read and flagged; family 2 announcements refused are named', async (t) => {
  const ctx = await setup(t, {
    devices: [
      { model: '0317', garbage: true },
      { model: '0c01', name: 'Runner hall' },
    ],
    heard: (devs) => [devs[0]],
  });
  const [heater, runner] = ctx.devs;
  // The water heater answers with another CRC: read, stopped, flagged.
  await until(ctx.clock, () => ctx.app.rt.get(heater.mac)?.ok === true, 'heater read');
  heater.power = 1;
  const r = await click(ctx, heater, 'power', 0);
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(heater.power, 0);
  assert.equal(ctx.app.stops.get(heater.mac)?.answered ?? true, true);
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /CRC non vérifié, à signaler/);
  // A Runner announcement with another CRC: refused, named in the status and by the button.
  const a = runner.announcement();
  const bytes = Buffer.from(a.payload_base64, 'base64');
  bytes[bytes.length - 4] ^= 1;
  ctx.gladys.fake.scanResults = {
    'udp-broadcast': [heater.announcement(), { ...a, payload_base64: bytes.toString('base64') }],
  };
  const ack = await ctx.gladys.fake.action('test_connection', {});
  assert.match(JSON.stringify(ack), /CRC différent, à signaler/);
  assert.match(JSON.stringify(ack), /Switcher Runner \(127\.0\.0\.\d+\)/);
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /Annonces Switcher refusées/);
});

test('a stop leaves although the login answer of a Runner fails its CRC', async (t) => {
  const ctx = await setup(t, { devices: [{ model: '0c01', garbage: true }] });
  const r = await click(ctx, ctx.dev, 'state', 0);
  assert.equal(ctx.dev.count('stop'), 1, r.error?.message);
  // Answered on its session (another CRC): an answer, not "no answer".
  assert.equal(ctx.app.stops.get(ctx.dev.mac)?.answered, true);
  assert.doesNotMatch(ctx.gladys.fake.connectionStatus.message.fr, /n'a pas répondu/);
});

test('the attempt time is in /data before every periodic read (a crash never reads sooner)', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store });
  await until(ctx.clock, () => ctx.dev.count('state') >= 2, 'two reads', { max: 2 * MINUTE });
  const second = ctx.dev.requests.filter((q) => q.type === 'state')[1].at;
  // The device clock is the elapsed virtual time; /data holds wall-clock ms.
  assert.ok(store.data.attemptAt >= ctx.clock.now() - (ctx.clock.elapsed - second) - 1000);
});
