import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, integerIn, normalizeConfig } from '../src/config.js';

test('defaults: every command but the stops off, 30 s, 60 min', () => {
  assert.deepEqual(normalizeConfig(undefined), {
    readInterval: 30_000,
    allowHeaterOn: false,
    heaterMinutes: 60,
    allowPlugOn: false,
    allowShutterMoves: false,
  });
  assert.deepEqual(normalizeConfig({}), normalizeConfig(DEFAULT_CONFIG));
});

test('values out of their bounds take the default, never a value beyond them', () => {
  for (const v of [0, 151, 1.5, '', null, '60min', -5, 1e9, true]) {
    assert.equal(normalizeConfig({ heater_minutes: v }).heaterMinutes, 60, String(v));
  }
  assert.equal(normalizeConfig({ heater_minutes: '150' }).heaterMinutes, 150);
  assert.equal(normalizeConfig({ read_interval: 5 }).readInterval, 30_000);
  assert.equal(normalizeConfig({ read_interval: 600 }).readInterval, 600_000);
  for (const v of ['yes', 1, 'TRUE', {}, null]) {
    assert.equal(normalizeConfig({ allow_heater_on: v }).allowHeaterOn, false, String(v));
  }
  assert.equal(normalizeConfig({ allow_plug_on: 'true' }).allowPlugOn, true);
  assert.equal(integerIn(' 7 ', 1, 9), 7);
  assert.equal(integerIn('7.0', 1, 9), undefined);
});
