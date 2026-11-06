// -----------------------------------------------------------------------------
// Switcher devices -> Gladys devices (pure).
//
// Identifier rule (frozen: it fixes the external ids, never change it): the
// MAC address the device announces (UDP broadcast), 12 lower-case hex digits
// without separators: `ext:<selector>:switcher:<mac>`, features
// `ext:<selector>:switcher:<mac>:<key>`. A device whose MAC cannot be read is
// not published (no weaker fallback: an address or a name can move to
// another device).
//
// The params keep what talking to the device needs (its protocol id, login
// key, model, address, Breeze remote): a device created in Gladys can still be
// stopped when /data is lost.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FEATURES } from './constants.js';
import { MODELS } from './protocol/packets.js';
import { validMac } from './protocol/parse.js';
import { breezeOffCode } from './breeze/remotes.js';

export const DEVICE_TYPE = 'switcher';

export const PARAMS = Object.freeze({
  MAC: 'SWITCHER_MAC',
  ID: 'SWITCHER_ID',
  KEY: 'SWITCHER_KEY',
  MODEL: 'SWITCHER_MODEL',
  IP: 'IP_ADDRESS',
  REMOTE: 'SWITCHER_REMOTE',
});

export const deviceIds = (gladys, mac) => gladys.externalIds(DEVICE_TYPE, mac);

/** The MAC of one of our external ids (device or feature), else undefined. */
export function macOfExternalId(gladys, externalId) {
  const prefix = gladys.externalId(`${DEVICE_TYPE}:`);
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) return undefined;
  const [mac, key, extra] = externalId.slice(prefix.length).split(':');
  if (extra !== undefined || !validMac(mac)) return undefined;
  return { mac, key };
}

const LABELS = {
  [FEATURES.POWER]: { heater: 'Water heater', plug: 'Power', breeze: 'Air conditioner' },
  [FEATURES.CONSUMPTION]: 'Power consumption',
  [FEATURES.REMAINING]: 'Time left',
  [FEATURES.STATE]: 'Shutter',
  [FEATURES.POSITION]: 'Position',
  [FEATURES.TEMPERATURE]: 'Room temperature',
  [FEATURES.TARGET]: 'Target temperature',
  [FEATURES.MODE]: 'Mode',
};

function feature(ids, key, kind, spec) {
  const label = LABELS[key];
  return {
    name: typeof label === 'string' ? label : label[kind],
    external_id: ids.feature(key),
    read_only: true,
    has_feedback: false,
    keep_history: true,
    ...spec,
  };
}

/** Whether the module can switch this Breeze off (a remote with a plain "off" code). */
export const breezeCanStop = (known) => breezeOffCode(known.remote) !== undefined;

/** The features of a known device, by kind. */
export function featuresOf(ids, known) {
  const kind = MODELS[known.model]?.kind;
  if (kind === 'heater' || kind === 'plug') {
    const list = [
      feature(ids, FEATURES.POWER, kind, {
        category: kind === 'heater' ? C.WATER_HEATER : C.SWITCH,
        type: kind === 'heater' ? T.WATER_HEATER.BINARY : T.SWITCH.BINARY,
        min: 0,
        max: 1,
        read_only: false,
        has_feedback: true,
      }),
      feature(ids, FEATURES.CONSUMPTION, kind, {
        category: C.ENERGY_SENSOR,
        type: T.ENERGY_SENSOR.POWER,
        unit: U.WATT,
        min: 0,
        max: 10000,
      }),
    ];
    if (kind === 'heater') {
      list.push(
        feature(ids, FEATURES.REMAINING, kind, {
          category: C.DURATION,
          type: T.DURATION.INTEGER,
          unit: U.SECONDS,
          min: 0,
          max: 86400,
          keep_history: false,
        }),
      );
    }
    return list;
  }
  if (kind === 'shutter') {
    return [
      feature(ids, FEATURES.STATE, kind, {
        category: C.SHUTTER,
        type: T.SHUTTER.STATE,
        min: -1,
        max: 1,
        read_only: false,
        keep_history: false,
      }),
      feature(ids, FEATURES.POSITION, kind, {
        category: C.SHUTTER,
        type: T.SHUTTER.POSITION,
        min: 0,
        max: 100,
        read_only: false,
        has_feedback: true,
      }),
    ];
  }
  if (kind === 'breeze') {
    return [
      feature(ids, FEATURES.POWER, kind, {
        category: C.AIR_CONDITIONING,
        type: T.AIR_CONDITIONING.BINARY,
        min: 0,
        max: 1,
        // Switching off only, and only with a remote whose "off" code is known.
        read_only: !breezeCanStop(known),
        has_feedback: true,
      }),
      feature(ids, FEATURES.TEMPERATURE, kind, {
        category: C.TEMPERATURE_SENSOR,
        type: T.SENSOR.DECIMAL,
        unit: U.CELSIUS,
        min: -40,
        max: 80,
      }),
      feature(ids, FEATURES.TARGET, kind, {
        category: C.AIR_CONDITIONING,
        type: T.AIR_CONDITIONING.TARGET_TEMPERATURE,
        unit: U.CELSIUS,
        min: 10,
        max: 40,
      }),
      feature(ids, FEATURES.MODE, kind, {
        category: C.AIR_CONDITIONING,
        type: T.AIR_CONDITIONING.MODE,
        min: 0,
        max: 4,
        keep_history: false,
      }),
    ];
  }
  return [];
}

/** Printable name of a device: its own, else "<model> <end of MAC>". */
export const nameOf = (known) =>
  known.name || `${MODELS[known.model]?.name ?? 'Switcher'} ${known.mac.slice(-4).toUpperCase()}`;

/** The Gladys device of a known (supported) device. */
export function buildDevice(gladys, known) {
  const ids = deviceIds(gladys, known.mac);
  const params = [
    { name: PARAMS.MAC, value: known.mac },
    { name: PARAMS.ID, value: known.id },
    { name: PARAMS.MODEL, value: known.model },
  ];
  if (known.key) params.push({ name: PARAMS.KEY, value: known.key });
  if (known.ip) params.push({ name: PARAMS.IP, value: known.ip });
  if (known.remote) params.push({ name: PARAMS.REMOTE, value: known.remote });
  return {
    name: nameOf(known),
    external_id: ids.device,
    model: MODELS[known.model]?.name,
    should_poll: false,
    params,
    features: featuresOf(ids, known),
  };
}
