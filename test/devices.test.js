// -----------------------------------------------------------------------------
// The devices: frozen ids, the features of each model, nothing sensitive as a
// switch, the options checked by the rules of the core (one bad option
// rejects the whole Discovery list in Gladys).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { buildDevice, macOfExternalId, nameOf } from '../src/devices.js';

const CORE = `${process.env.HOME}/code/Gladys/server/utils/normalizeSupportedOptions.js`;
const gladys = createFakeGladys({ selector: 'sw' });
const known = (model, extra = {}) => ({
  mac: '0a0000000001',
  id: 'a1b2c3',
  key: '18',
  model,
  ip: '192.168.1.20',
  ...extra,
});
const ALL = ['0317', '030f', '030b', '01a7', '01a1', '01a8', '0c01', '0c02', '0e01'].map((m) =>
  buildDevice(gladys, known(m, m === '0e01' ? { remote: 'ELEC7022' } : {})),
);

/** The rules of the core (server/utils/normalizeSupportedOptions.js), as a fallback. */
function coreRule(options) {
  assert.ok(Array.isArray(options));
  const values = new Set();
  for (const option of options) {
    assert.deepEqual(
      Object.keys(option).filter((k) => !['value', 'label', 'sort_order'].includes(k)),
      [],
    );
    assert.ok(Number.isInteger(option.value));
    assert.equal(typeof option.label, 'string');
    assert.ok(option.label.length > 0 && option.label === option.label.trim());
    assert.ok(!values.has(option.value));
    values.add(option.value);
  }
}

test('identifier rule (frozen): ext:<selector>:switcher:<mac>[:<feature>]', () => {
  const device = buildDevice(gladys, known('0317'));
  assert.equal(device.external_id, 'ext:sw:switcher:0a0000000001');
  assert.deepEqual(
    device.features.map((f) => f.external_id),
    ['power', 'consumption', 'remaining'].map((k) => `ext:sw:switcher:0a0000000001:${k}`),
  );
  assert.deepEqual(macOfExternalId(gladys, 'ext:sw:switcher:0a0000000001:power'), {
    mac: '0a0000000001',
    key: 'power',
  });
  for (const bad of [
    'ext:other:switcher:0a0000000001',
    'ext:sw:switcher:0A0000000001',
    'ext:sw:switcher:0a0000000001:a:b',
    5,
  ]) {
    assert.equal(macOfExternalId(gladys, bad), undefined, String(bad));
  }
  assert.equal(nameOf(known('0317')), 'Switcher V4 0001');
  assert.equal(nameOf(known('0317', { name: 'Boiler' })), 'Boiler');
});

test('a water heater is a water-heater, never a switch; a plug is a switch', () => {
  const [heater] = ALL;
  assert.deepEqual(
    heater.features.map((f) => `${f.category}/${f.type}`),
    ['water-heater/binary', 'energy-sensor/power', 'duration/integer'],
  );
  const plug = ALL.find((d) => d.params.some((p) => p.value === '01a8'));
  assert.equal(plug.features[0].category, 'switch');
  for (const device of ALL) {
    const isPlug = device === plug;
    for (const f of device.features) {
      if (!isPlug) assert.notEqual(f.category, 'switch', device.name);
    }
  }
});

test('shutter and Breeze features; a Breeze without a plain off code is read only', () => {
  const runner = buildDevice(gladys, known('0c01'));
  assert.deepEqual(
    runner.features.map((f) => [f.type, f.read_only, f.min, f.max]),
    [
      ['state', false, -1, 1],
      ['position', false, 0, 100],
    ],
  );
  const breeze = buildDevice(gladys, known('0e01', { remote: 'ELEC7022' }));
  assert.equal(breeze.features[0].read_only, false);
  assert.ok(breeze.features.slice(1).every((f) => f.read_only));
  for (const remote of ['ELEC7001', undefined, 'NOPE']) {
    const ro = buildDevice(gladys, known('0e01', { remote }));
    assert.equal(ro.features[0].read_only, true, String(remote));
  }
});

test('every supported option follows the rules of the core (there are none today)', () => {
  const require = createRequire(import.meta.url);
  const core = existsSync(CORE) ? require(CORE).normalizeSupportedOptions : undefined;
  let checked = 0;
  for (const device of ALL) {
    for (const feature of device.features) {
      if (feature.supported_options === undefined) continue;
      coreRule(feature.supported_options);
      if (core) core(feature.supported_options);
      checked += 1;
    }
  }
  assert.equal(checked, 0);
});

test('the Discovery list is accepted by the host checks of the SDK', async () => {
  const g = createFakeGladys({ selector: 'sw' });
  await g.connect();
  await g.publishDiscoveredDevices(
    ALL.map((d, i) => ({
      ...d,
      external_id: `${d.external_id}${i}`,
      features: d.features.map((f) => ({
        ...f,
        external_id: f.external_id.replace('0a0000000001', `0a0000000001${i}`),
      })),
    })),
  );
  assert.equal(g.fake.discoveredDevices.length, ALL.length);
});
