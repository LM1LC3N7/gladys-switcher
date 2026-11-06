// -----------------------------------------------------------------------------
// Models and requests of the Switcher local protocol, ported from aioswitcher
// 6.4.0 (Apache-2.0, `device/__init__.py`, `api/packets.py`, `api/__init__.py`).
// Every builder returns the hex text of a request before `seal()` (length and
// CRC): the values are checked here, a value out of its range throws.
//
// Not supported in this version: the models that need the token of the
// Switcher account (Runner S11/S12, Lights, Heater): the token is turned into
// the login packet with a key taken from the vendor app, so using it means
// imitating the app (see TODO.md).
// -----------------------------------------------------------------------------

/** model code (2 bytes hex) -> { name, family (1|2), kind } */
export const MODELS = Object.freeze({
  '030f': { name: 'Switcher Mini', family: 1, kind: 'heater' },
  '030b': { name: 'Switcher Touch', family: 1, kind: 'heater' },
  '01a7': { name: 'Switcher V2 (esp)', family: 1, kind: 'heater' },
  '01a1': { name: 'Switcher V2 (qualcomm)', family: 1, kind: 'heater' },
  '0317': { name: 'Switcher V4', family: 1, kind: 'heater' },
  '01a8': { name: 'Switcher Power Plug', family: 1, kind: 'plug' },
  '0e01': { name: 'Switcher Breeze', family: 2, kind: 'breeze' },
  '0c01': { name: 'Switcher Runner', family: 2, kind: 'shutter' },
  '0c02': { name: 'Switcher Runner Mini', family: 2, kind: 'shutter' },
  // Token of the Switcher account needed: found, named, never driven.
  '0f01': { name: 'Switcher Runner S11', family: 2, kind: 'token' },
  '0f02': { name: 'Switcher Runner S12', family: 2, kind: 'token' },
  '0f04': { name: 'Switcher Light SL01', family: 2, kind: 'token' },
  '0f07': { name: 'Switcher Light SL01 Mini', family: 2, kind: 'token' },
  '0f05': { name: 'Switcher Light SL02', family: 2, kind: 'token' },
  '0f08': { name: 'Switcher Light SL02 Mini', family: 2, kind: 'token' },
  '0f06': { name: 'Switcher Light SL03', family: 2, kind: 'token' },
  '031f': { name: 'Switcher Heater', family: 2, kind: 'token' },
});

export const SUPPORTED_KINDS = Object.freeze(['heater', 'plug', 'shutter', 'breeze']);

const HEX = (bytes) => new RegExp(`^[0-9a-f]{${bytes * 2}}$`);
const ID = HEX(3);
const KEY = HEX(1);
const SESSION = HEX(4);
const PAD_72 = '0'.repeat(72);
const TAIL = '00000000000000000000f0fe';

/** The device clock field: the Unix time in seconds, 4 bytes little endian. */
export function timestampHex(nowMs) {
  const seconds = Math.round(nowMs / 1000);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 0xffffffff) {
    throw new RangeError('clock out of range');
  }
  const b = Buffer.alloc(4);
  b.writeUInt32LE(seconds);
  return b.toString('hex');
}

function check(value, pattern, what) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new RangeError(`bad ${what}`);
  }
  return value;
}

const header1 = (session, ts) =>
  `${check(session, SESSION, 'session')}340001000000000000000000${ts}${TAIL}`;
const header2 = (session, ts) =>
  `${check(session, SESSION, 'session')}390001000000000000000000${ts}${TAIL}`;

/** Login of a family 1 device (water heaters, plug): its 1-byte key. */
export const login1 = ({ key }, ts) =>
  `fef052000232a10000000000340001000000000000000000${ts}${TAIL}${check(key, KEY, 'key')}${PAD_72}00`;

/** Login of a family 2 device without a token (Breeze, Runner, Runner Mini): its id. */
export const login2 = ({ id }, ts) =>
  `fef030000305a60000000000ff03010000000000` + `00000000${ts}${TAIL}${check(id, ID, 'id')}00`;

/** State request, family 1. */
export const getState1 = ({ id }, session, ts) =>
  `fef0300002320103${header1(session, ts)}${check(id, ID, 'id')}00`;

/** State request, family 2. */
export const getState2 = ({ id }, session, ts) =>
  `fef0300003050103${header2(session, ts)}${check(id, ID, 'id')}00`;

const control1 = ({ id }, session, ts, command, timer) =>
  `fef05d0002320102${header1(session, ts)}${check(id, ID, 'id')}${PAD_72}` +
  `000106000${command}00${timer}`;

/** Off of a family 1 device (water heater, plug): never carries a timer. */
export const switchOff = (known, session, ts) => control1(known, session, ts, '0', '00000000');

/**
 * On of a water heater: always with the device timer (seconds, 4 bytes little
 * endian), 1 to `maxMinutes` minutes (150 at most): the device ends the run.
 */
export function heaterOn(known, session, ts, { minutes, maxMinutes }) {
  if (MODELS[known.model]?.kind !== 'heater') throw new RangeError('not a water heater');
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > maxMinutes || maxMinutes > 150) {
    throw new RangeError('run length out of bounds');
  }
  const b = Buffer.alloc(4);
  b.writeUInt32LE(minutes * 60);
  return control1(known, session, ts, '1', b.toString('hex'));
}

/** On of a plug (no timer: a plug is not a water heater). */
export function plugOn(known, session, ts) {
  if (MODELS[known.model]?.kind !== 'plug') throw new RangeError('not a plug');
  return control1(known, session, ts, '1', '00000000');
}

/** Stop of a Runner / Runner Mini. */
export const runnerStop = ({ id }, session, ts) =>
  `fef0590003050102${check(session, SESSION, 'session')}232301000000000000000000` +
  `${ts}${TAIL}${check(id, ID, 'id')}${PAD_72}370202000000`;

/** Position (0 closed .. 100 open) of a Runner / Runner Mini. */
export function runnerPosition({ id }, session, ts, position) {
  if (!Number.isInteger(position) || position < 0 || position > 100) {
    throw new RangeError('position out of bounds');
  }
  return (
    `fef0580003050102${check(session, SESSION, 'session')}290401000000000000000000` +
    `${ts}${TAIL}${check(id, ID, 'id')}${PAD_72}37010100${position.toString(16).padStart(2, '0')}`
  );
}

/** An infrared command of a Breeze: "<Para>|<HexCode>" of its remote, printable ASCII. */
export function breezeCommand({ id }, session, ts, code) {
  if (typeof code !== 'string' || !/^[\x20-\x7e]{1,1000}$/.test(code)) {
    throw new RangeError('bad infrared code');
  }
  const command = `00000000${Buffer.from(code, 'ascii').toString('hex')}`;
  const length = Buffer.alloc(2);
  length.writeUInt16LE(command.length / 2);
  return (
    `fef0000003050102${check(session, SESSION, 'session')}000001000000000000000000` +
    `${ts}${TAIL}${check(id, ID, 'id')}${PAD_72}3701${length.toString('hex')}${command}`
  );
}
