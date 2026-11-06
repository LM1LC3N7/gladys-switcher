// -----------------------------------------------------------------------------
// The configuration: DEFAULT_CONFIG mirrors the defaults of the manifest
// (test/manifest.test.js ties them). Every value is checked here: a value out
// of its range takes the default, never a value outside the bounds.
// -----------------------------------------------------------------------------

import { HEATER_MINUTES, READ_INTERVAL } from './constants.js';

export const DEFAULT_CONFIG = Object.freeze({
  read_interval: READ_INTERVAL.default,
  allow_heater_on: false,
  heater_minutes: HEATER_MINUTES.default,
  allow_plug_on: false,
  allow_shutter_moves: false,
});

/** A whole number within [min, max] (a numeric text accepted), else undefined. */
export function integerIn(value, min, max) {
  if (typeof value === 'string') {
    if (!/^\s*-?\d+\s*$/.test(value)) return undefined;
    value = Number(value);
  }
  return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

/** true only for true or "true": anything else (missing, unreadable) keeps the command off. */
const flag = (value) => value === true || value === 'true';

/** The values the app uses: { readInterval (ms), allowHeaterOn, heaterMinutes, allowPlugOn, allowShutterMoves }. */
export function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const get = (key) => (Object.hasOwn(config, key) ? config[key] : undefined);
  const seconds =
    integerIn(get('read_interval'), READ_INTERVAL.min, READ_INTERVAL.max) ??
    DEFAULT_CONFIG.read_interval;
  return {
    readInterval: seconds * 1000,
    allowHeaterOn: flag(get('allow_heater_on')),
    heaterMinutes:
      integerIn(get('heater_minutes'), HEATER_MINUTES.min, HEATER_MINUTES.max) ??
      DEFAULT_CONFIG.heater_minutes,
    allowPlugOn: flag(get('allow_plug_on')),
    allowShutterMoves: flag(get('allow_shutter_moves')),
  };
}
