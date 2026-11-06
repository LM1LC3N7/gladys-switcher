// -----------------------------------------------------------------------------
// The protocol: frames, requests (byte for byte against the reference),
// announcements and answers (against the captures of the reference tests).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crc16, frameError, seal } from '../src/protocol/frame.js';
import {
  breezeCommand,
  getState1,
  getState2,
  heaterOn,
  login1,
  login2,
  plugOn,
  runnerPosition,
  runnerStop,
  switchOff,
  timestampHex,
} from '../src/protocol/packets.js';
import {
  commandAnswered,
  parseBreeze,
  parseDatagram,
  parseLogin,
  parseShutter,
  parseState1,
  unicastIPv4,
  validMac,
} from '../src/protocol/parse.js';
import { breezeOffCode } from '../src/breeze/remotes.js';
import * as C from './fixtures/captures.js';
import { frame, resign } from './helpers/fakeSwitcher.js';

const V = JSON.parse(readFileSync(new URL('./fixtures/requests.json', import.meta.url), 'utf8'));
const hex = (s) => Buffer.from(s, 'hex');
const heater = { id: V.id, key: V.key, model: '0317' };
const plug = { id: V.id, key: V.key, model: '01a8' };

test('the CRC is the one of the reference (crc_hqx seeded with 0x1021)', () => {
  assert.equal(crc16(Buffer.from('123456789'), 0), 0x31c3);
  for (const capture of [C.RUNNER_DATAGRAM, C.BREEZE_DATAGRAM, C.BREEZE_STATE, C.SHUTTER_STATE]) {
    assert.equal(frameError(hex(capture), { max: 1024 }), undefined);
  }
});

test('every request is the one aioswitcher sends, byte for byte', () => {
  const s = V.session;
  const ts = V.ts;
  assert.equal(seal(login1(heater, ts)).toString('hex'), V.login1);
  assert.equal(seal(login2(heater, ts)).toString('hex'), V.login2);
  assert.equal(seal(getState1(heater, s, ts)).toString('hex'), V.getState1);
  assert.equal(seal(getState2(heater, s, ts)).toString('hex'), V.getState2);
  assert.equal(seal(switchOff(heater, s, ts)).toString('hex'), V.off1);
  assert.equal(
    seal(heaterOn(heater, s, ts, { minutes: 90, maxMinutes: 150 })).toString('hex'),
    V.on1_90min,
  );
  assert.equal(seal(runnerStop(heater, s, ts)).toString('hex'), V.runnerStop);
  assert.equal(seal(runnerPosition(heater, s, ts, 42)).toString('hex'), V.runnerPosition42);
  assert.equal(
    seal(breezeCommand(heater, s, ts, breezeOffCode('ELEC7022'))).toString('hex'),
    V.breezeOffELEC7022,
  );
  // The infrared off code is the one of the reference test.
  assert.equal(
    `00000000${Buffer.from(breezeOffCode('ELEC7022'), 'ascii').toString('hex')}`,
    C.BREEZE_OFF_ELEC7022,
  );
  assert.equal(timestampHex(0x5cb38def * 1000), 'ef8db35c');
});

test('a water heater is switched on only with a timer of 1 to 150 minutes; a plug never with one', () => {
  const s = V.session;
  const ts = V.ts;
  for (const minutes of [0, -1, 151, 1.5, undefined, '60', NaN]) {
    assert.throws(() => heaterOn(heater, s, ts, { minutes, maxMinutes: 150 }), RangeError);
  }
  assert.throws(() => heaterOn(heater, s, ts, { minutes: 60, maxMinutes: 151 }), RangeError);
  assert.throws(() => heaterOn(heater, s, ts, { minutes: 60, maxMinutes: 30 }), RangeError);
  assert.throws(() => heaterOn(plug, s, ts, { minutes: 60, maxMinutes: 150 }), RangeError);
  assert.throws(() => plugOn(heater, s, ts), RangeError);
  const on = hex(heaterOn(heater, s, ts, { minutes: 150, maxMinutes: 150 }));
  assert.equal(on.readUInt32LE(on.length - 4), 150 * 60);
  const plugged = hex(plugOn(plug, s, ts));
  assert.equal(plugged.readUInt32LE(plugged.length - 4), 0);
  assert.equal(plugged[plugged.length - 6] & 0x0f, 1);
  const off = hex(switchOff(heater, s, ts));
  assert.equal(off.readUInt32LE(off.length - 4), 0);
  assert.equal(off[off.length - 6] & 0x0f, 0);
});

test('positions, ids, keys and sessions are checked before any request is built', () => {
  const ts = V.ts;
  for (const position of [-1, 101, 50.5, '50']) {
    assert.throws(() => runnerPosition(heater, V.session, ts, position), RangeError);
  }
  assert.throws(() => getState1({ id: 'a1b2' }, V.session, ts), RangeError);
  assert.throws(() => getState1({ id: 'A1B2C3' }, V.session, ts), RangeError);
  assert.throws(() => getState1(heater, '0102', ts), RangeError);
  assert.throws(() => login1({ key: '1' }, ts), RangeError);
  assert.throws(() => breezeCommand(heater, V.session, ts, 'a\nb'), RangeError);
  assert.throws(() => seal('fef0zz'), /malformed/);
  assert.throws(() => timestampHex(-5000), RangeError);
});

test('announcements: the captures of a Runner Mini and a Breeze', () => {
  const runner = parseDatagram(hex(C.RUNNER_DATAGRAM), '192.168.50.98');
  assert.deepEqual(
    { kind: runner.kind, model: runner.model, mac: runner.mac, id: runner.id, ip: runner.ip },
    { kind: 'shutter', model: '0c02', mac: '94b97e011e42', id: 'f2239a', ip: '192.168.50.98' },
  );
  assert.equal(runner.name, 'Switcher Run_1E42');
  const breeze = parseDatagram(hex(C.BREEZE_DATAGRAM), '192.168.50.77');
  assert.equal(breeze.kind, 'breeze');
  assert.equal(breeze.remote, 'ELEC7022');
  assert.equal(breeze.mac, 'bcff4d4a5679');
  // The Runner S12 needs the account token: named, never driven.
  const s12 = parseDatagram(hex(C.S12_DATAGRAM), parseDatagram(hex(C.S12_DATAGRAM), 'x').ip ?? 'x');
  assert.ok(s12.error || s12.kind === 'token');
});

test('announcements of the water heaters and plug (edited captures, signed again)', () => {
  const v4 = parseDatagram(resign(hex(C.V4_DATAGRAM_ON)), '192.168.1.33');
  assert.deepEqual(
    { kind: v4.kind, model: v4.model, mac: v4.mac, id: v4.id, key: v4.key, name: v4.name },
    {
      kind: 'heater',
      model: '0317',
      mac: '12a1a21abc1a',
      id: 'aaaaaa',
      key: '03',
      name: 'My Switcher Boiler',
    },
  );
  assert.equal(parseDatagram(resign(hex(C.PLUG_DATAGRAM_OFF)), '192.168.1.33').kind, 'plug');
  // As edited (CRC no longer matching), refused.
  assert.equal(parseDatagram(hex(C.V4_DATAGRAM_ON), '192.168.1.33').error, 'crc');
});

test('an announcement is refused when anything is off', () => {
  const good = resign(hex(C.V4_DATAGRAM_ON));
  assert.equal(parseDatagram(good, '192.168.1.34').error, 'address', 'another source');
  assert.equal(parseDatagram(good.subarray(0, 160), '192.168.1.33').error, 'size');
  const edit = (fn) => {
    const b = Buffer.from(good);
    fn(b);
    return resign(b);
  };
  assert.equal(
    parseDatagram(
      edit((b) => b.writeUInt16LE(0x9999, 74)),
      '192.168.1.33',
    ).error,
    'model',
  );
  assert.equal(
    parseDatagram(
      edit((b) => b.fill(0, 80, 86)),
      '192.168.1.33',
    ).error,
    'mac',
  );
  assert.equal(
    parseDatagram(
      edit((b) => b.fill(0xff, 80, 86)),
      '192.168.1.33',
    ).error,
    'mac',
  );
  assert.equal(
    parseDatagram(
      edit((b) => (b[80] = 0x01)),
      '192.168.1.33',
    ).error,
    'mac',
    'multicast',
  );
  for (const ip of ['255.255.255.255', '0.0.0.0', '224.0.0.1', '127.0.0.1', '192.168.1.255']) {
    const bytes = edit((b) => Buffer.from(ip.split('.').map(Number)).copy(b, 76));
    assert.equal(parseDatagram(bytes, ip).error, 'address', ip);
  }
  const wrongStart = Buffer.from(good);
  wrongStart[0] = 0xff;
  assert.equal(parseDatagram(wrongStart, '192.168.1.33').error, 'start');
  const lying = Buffer.from(good);
  lying.writeUInt16LE(150, 2);
  assert.equal(parseDatagram(lying, '192.168.1.33').error, 'length');
  // A Runner announced at the size of a water heater: refused.
  const runnerSized = edit((b) => {
    b.writeUInt16BE(0x0c01, 74);
    Buffer.from([192, 168, 1, 33]).copy(b, 77);
    Buffer.from('12a1a21abc1a', 'hex').copy(b, 81);
  });
  assert.equal(parseDatagram(runnerSized, '192.168.1.33').error, 'size');
});

test('answers: the captures of a Breeze and a Runner state, command answers', () => {
  const breeze = parseBreeze(hex(C.BREEZE_STATE));
  assert.deepEqual(breeze, {
    power: 0,
    temperature: 28.1,
    mode: 3,
    target: 24,
    remote: 'ELEC7022',
  });
  assert.deepEqual(parseShutter(hex(C.SHUTTER_STATE)), { position: 50, direction: 'stop' });
  assert.equal(commandAnswered(hex(C.STOP_SHUTTER_ANSWER)), true);
  assert.equal(commandAnswered(hex(C.BREEZE_CONTROL_ANSWER)), true);
  const broken = hex(C.SHUTTER_STATE);
  broken[broken.length - 4] ^= 1;
  assert.equal(parseShutter(broken), undefined, 'CRC');
});

test('a value outside what the protocol defines is unknown, never 0', () => {
  const state1 = (fill) => parseState1(frame(112, fill));
  assert.deepEqual(
    state1((b) => (b[75] = 1)),
    {
      power: 1,
      watts: 0,
      timeLeft: 0,
      timeOn: 0,
      autoOff: 0,
    },
  );
  assert.equal(
    state1((b) => (b[75] = 2)),
    undefined,
  );
  assert.equal(parseState1(frame(60, (b) => (b[75] = 1))), undefined, 'too short');
  const breeze = (fill) => parseBreeze(frame(109, fill));
  assert.equal(
    breeze((b) => (b[78] = 7)),
    undefined,
  );
  const odd = breeze((b) => {
    b[78] = 1;
    b.writeInt16LE(900, 76);
    b[79] = 9;
    b[80] = 99;
  });
  assert.deepEqual([odd.temperature, odd.mode, odd.target], [undefined, undefined, undefined]);
  assert.equal(breeze((b) => b.writeInt16LE(-55, 76)).temperature, -5.5);
  const shutter = (fill) => parseShutter(frame(100, fill));
  assert.equal(
    shutter((b) => (b[76] = 101)),
    undefined,
  );
  assert.equal(
    shutter((b) => b.writeUInt16BE(0x0101, 78)),
    undefined,
  );
  assert.equal(parseLogin(frame(48, (b) => b.writeUInt32BE(0x01020304, 8))), '01020304');
  assert.equal(parseLogin(Buffer.from('fef0', 'hex')), undefined);
});

test('addresses and MACs', () => {
  assert.equal(unicastIPv4('192.168.1.20'), true);
  for (const ip of ['192.168.1.0', '010.0.0.1', '1.2.3', '256.1.1.1', '169.254.1.1', '']) {
    assert.equal(unicastIPv4(ip), false, ip);
  }
  assert.equal(unicastIPv4('127.0.0.2'), false);
  assert.equal(unicastIPv4('127.0.0.2', { allowLoopback: true }), true);
  assert.equal(validMac('0a0000000001'), true);
  assert.equal(validMac('0b0000000001'), false);
  assert.equal(validMac('0A0000000001'), false);
});

test('Breeze remotes: only a plain off code; toggle remotes and odd ids have none', () => {
  assert.match(breezeOffCode('ELEC7022'), /^[\x20-\x7e]+\|[0-9A-F]+$/);
  assert.equal(breezeOffCode('ELEC7001'), undefined, 'toggle remote');
  assert.equal(breezeOffCode('MITS7004'), undefined, 'no off key');
  for (const id of ['__proto__', 'constructor', 'toString', '', 'ELEC70221', undefined, 5]) {
    assert.equal(breezeOffCode(id), undefined, String(id));
  }
});
