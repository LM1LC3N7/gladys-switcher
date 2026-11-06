// -----------------------------------------------------------------------------
// The frame of the Switcher protocol (ported from aioswitcher 6.4.0,
// Apache-2.0, `device/tools.py`): every message starts with fe f0, then its
// total length (2 bytes, little endian), and ends with 4 bytes: the CRC-CCITT
// (polynomial 0x1021, not reflected) of everything before it, started from
// 0x1021 as the reference does (`crc_hqx(packet, 0x1021)`), little endian,
// then the same CRC of those 2 bytes followed by 32 bytes "0".
//
// What the devices send back carries the same first 2 CRC bytes (checked on
// the unedited captures of the reference tests); the last 2 use a key that is
// not known here and are not checked. A frame whose start, length or CRC is
// wrong is refused, never read.
// -----------------------------------------------------------------------------

/** The initial value the protocol starts its CRC from. */
export const SEED = 0x1021;

const TABLE = (() => {
  const table = new Uint16Array(256);
  for (let n = 0; n < 256; n += 1) {
    let crc = n << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    table[n] = crc;
  }
  return table;
})();

/** CRC-CCITT, not reflected (Python's binascii.crc_hqx(data, init)). */
export function crc16(bytes, init = SEED) {
  let crc = init & 0xffff;
  for (const byte of bytes) {
    crc = ((crc << 8) & 0xffff) ^ TABLE[((crc >> 8) ^ byte) & 0xff];
  }
  return crc;
}

const KEY_PAD = Buffer.alloc(32, 0x30);

/** Sets the length (the 4 CRC bytes included) and signs: the bytes to write. */
export function seal(hex) {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex) || !hex.startsWith('fef0')) {
    throw new Error('malformed packet');
  }
  const body = Buffer.from(hex, 'hex');
  body.writeUInt16LE(body.length + 4, 2);
  const crc = crc16(body);
  const crcBytes = Buffer.alloc(2);
  crcBytes.writeUInt16LE(crc);
  const key = crc16(Buffer.concat([crcBytes, KEY_PAD]));
  const keyBytes = Buffer.alloc(2);
  keyBytes.writeUInt16LE(key);
  return Buffer.concat([body, crcBytes, keyBytes]);
}

/** The total length a frame announces, once its first 4 bytes are in; undefined before. */
export function announcedLength(bytes) {
  if (bytes.length < 4) return undefined;
  return bytes.readUInt16LE(2);
}

/**
 * Checks a whole frame: start, announced length equal to its size, CRC.
 * Returns a reason ('start' | 'length' | 'crc') or undefined when sound.
 */
export function frameError(bytes, { min = 12, max = 1024 } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes[0] !== 0xfe || bytes[1] !== 0xf0) {
    return 'start';
  }
  if (bytes.length < min || bytes.length > max || announcedLength(bytes) !== bytes.length) {
    return 'length';
  }
  const crc = crc16(bytes.subarray(0, bytes.length - 4));
  if (bytes.readUInt16LE(bytes.length - 4) !== crc) {
    return 'crc';
  }
  return undefined;
}
