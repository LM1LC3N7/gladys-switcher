// -----------------------------------------------------------------------------
// Reading what the devices send, ported from aioswitcher 6.4.0 (Apache-2.0,
// `bridge.py` DatagramParser, `api/messages.py` StateMessageParser). Pure,
// linear, bounded: a frame is checked whole (start, length, CRC) before any
// field is read, every field is read at a fixed offset, and a value outside
// what the protocol defines is "unknown" (undefined), never 0.
// -----------------------------------------------------------------------------

import { frameError } from './frame.js';
import { MODELS } from './packets.js';

/** Sizes of the announcements of the supported models (and of the token ones, to name them). */
const DATAGRAM_SIZES = new Set([159, 165, 168, 171, 203, 207]);

const hex = (bytes, from, to) => bytes.subarray(from, to).toString('hex');

/** Printable ASCII of a zero-padded field, trimmed; '' when anything else is in it. */
function text(bytes, from, to) {
  const field = bytes.subarray(from, to);
  const end = field.indexOf(0);
  const raw = field.subarray(0, end === -1 ? field.length : end);
  for (let i = end === -1 ? field.length : end; i < field.length; i += 1) {
    if (field[i] !== 0) return '';
  }
  for (const byte of raw) {
    if (byte < 0x20 || byte > 0x7e) return '';
  }
  return raw.toString('latin1').trim();
}

const ipOf = (bytes, at) => [...bytes.subarray(at, at + 4)].join('.');
const macOf = (bytes, at) => hex(bytes, at, at + 6);

/** A MAC that can name a device: 12 hex digits, not all 0 nor all f, not multicast. */
export const validMac = (mac) =>
  typeof mac === 'string' &&
  /^[0-9a-f]{12}$/.test(mac) &&
  mac !== '000000000000' &&
  mac !== 'ffffffffffff' &&
  (parseInt(mac.slice(0, 2), 16) & 1) === 0;

/** An IPv4 unicast host address (no 0.x, no loopback unless allowed, no multicast, no broadcast). */
export function unicastIPv4(ip, { allowLoopback = false } = {}) {
  if (typeof ip !== 'string') return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255) || m.slice(1).some((x) => x.length > 1 && x.startsWith('0'))) {
    return false;
  }
  if (o[0] === 0 || o[0] >= 224) return false;
  if (o[0] === 127) return allowLoopback;
  if (o[0] === 169 && o[1] === 254) return false;
  return o[3] !== 255 && o[3] !== 0;
}

/**
 * An announcement (UDP broadcast) -> { model, kind, family, name, id, key, mac,
 * ip, remote? } or { error }. The address inside must be the source address
 * of the datagram (`sourceIp`), the model known, the MAC usable.
 */
export function parseDatagram(bytes, sourceIp, options = {}) {
  if (!Buffer.isBuffer(bytes) || !DATAGRAM_SIZES.has(bytes.length)) {
    return { error: 'size' };
  }
  const bad = frameError(bytes, { min: 159, max: 207 });
  if (bad) return { error: bad };
  const model = hex(bytes, 74, 76);
  const info = MODELS[model];
  if (!info) return { error: 'model' };
  const family2 = info.family === 2;
  const ip = family2 ? ipOf(bytes, 77) : ipOf(bytes, 76);
  const mac = family2 ? macOf(bytes, 81) : macOf(bytes, 80);
  if (!validMac(mac)) return { error: 'mac' };
  if (!unicastIPv4(ip, options) || ip !== sourceIp) return { error: 'address' };
  const device = {
    model,
    kind: info.kind,
    family: info.family,
    modelName: info.name,
    name: text(bytes, 42, 74),
    id: hex(bytes, 18, 21),
    key: hex(bytes, 40, 41),
    mac,
    ip,
  };
  if (info.kind === 'breeze') {
    if (bytes.length !== 168) return { error: 'size' };
    device.remote = text(bytes, 143, 151);
  } else if (info.kind === 'shutter' && bytes.length !== 159) {
    return { error: 'size' };
  } else if (info.family === 1 && bytes.length !== 165) {
    return { error: 'size' };
  }
  return device;
}

/** Session id of a login answer (bytes 8..11), or undefined when the frame is not sound. */
export function parseLogin(bytes) {
  if (frameError(bytes, { min: 16, max: 1024 })) return undefined;
  return hex(bytes, 8, 12);
}

const u16 = (bytes, at) => bytes.readUInt16LE(at);
const u32 = (bytes, at) => bytes.readUInt32LE(at);

/** On/off byte: 1 on, 0 off, anything else unknown. */
const onOff = (byte) => (byte === 1 ? 1 : byte === 0 ? 0 : undefined);

/** State of a family 1 device (water heater, plug). */
export function parseState1(bytes) {
  if (frameError(bytes, { min: 105, max: 1024 })) return undefined;
  const power = onOff(bytes[75]);
  if (power === undefined) return undefined;
  return {
    power,
    watts: u16(bytes, 77),
    timeLeft: u32(bytes, 89),
    timeOn: u32(bytes, 93),
    autoOff: u32(bytes, 97),
  };
}

/** Breeze modes (protocol byte) -> AC_MODE of Gladys. */
const BREEZE_MODES = { 1: 0, 2: 3, 3: 4, 4: 1, 5: 2 };

/** State of a Breeze. */
export function parseBreeze(bytes) {
  if (frameError(bytes, { min: 96, max: 1024 })) return undefined;
  const power = onOff(bytes[78]);
  if (power === undefined) return undefined;
  const raw = u16(bytes, 76);
  const tenths = raw >= 0x8000 ? raw - 0x10000 : raw;
  const target = bytes[80];
  return {
    power,
    // A room reading outside -40..80 °C is not a measure.
    temperature: tenths >= -400 && tenths <= 800 ? tenths / 10 : undefined,
    mode: BREEZE_MODES[bytes[79]],
    target: target >= 10 && target <= 40 ? target : undefined,
    remote: text(bytes, 84, 92),
  };
}

/** Shutter directions (bytes 78..79). */
const DIRECTIONS = { '0000': 'stop', '0100': 'up', '0001': 'down' };

/** State of a Runner / Runner Mini (its one shutter). */
export function parseShutter(bytes) {
  if (frameError(bytes, { min: 84, max: 1024 })) return undefined;
  const position = bytes[76];
  const direction = DIRECTIONS[hex(bytes, 78, 80)];
  if (position > 100 || direction === undefined) return undefined;
  return { position, direction };
}

/** An answer to a command: a sound frame (the reference reads nothing more from it). */
export const commandAnswered = (bytes) => frameError(bytes, { min: 12, max: 1024 }) === undefined;
