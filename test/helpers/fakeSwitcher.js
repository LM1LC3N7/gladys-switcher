// -----------------------------------------------------------------------------
// A fake Switcher device on a real loopback TCP socket (127.0.0.x), built from
// the packet formats and the answer offsets of aioswitcher 6.4.0 and the
// captures of its tests (test/fixtures/captures.js): it checks every request
// (start, length, CRC, login key or device id, session id), answers with
// sound frames, and keeps a state the commands change. Its announcement (the
// UDP broadcast the core captures) is built here too.
//
// Knobs (changeable live): latencyMs, silent (reads, never answers), mute
// (a set of request types never answered), noTimer (ignores the timer of a
// switch-on), refuse
// (closes every connection at once), ignore (answers the commands without
// applying them), applyDelayMs (applies them later), garbage (answers a
// frame with a wrong CRC).
// -----------------------------------------------------------------------------

import { createServer } from 'node:net';
import { crc16, frameError, seal } from '../../src/protocol/frame.js';
import { MODELS } from '../../src/protocol/packets.js';
import { breezeOffCode } from '../../src/breeze/remotes.js';

const kindOf = (model) => MODELS[model].kind;

/** A frame of `size` bytes, its fields written by `fill(buffer)`, then length and CRC set. */
export function frame(size, fill) {
  const b = Buffer.alloc(size - 4);
  b[0] = 0xfe;
  b[1] = 0xf0;
  fill?.(b);
  return seal(b.toString('hex'));
}

/** Re-signs a frame (length and CRC) after its fields were edited. */
export function resign(bytes) {
  return seal(bytes.subarray(0, bytes.length - 4).toString('hex'));
}

/** The announcement of a device, as the core relays it: { source_ip, source_port, payload_base64 }. */
export function announcement(device, { sourceIp = device.ip, edit } = {}) {
  const kind = kindOf(device.model);
  const family = MODELS[device.model].family;
  const size = kind === 'breeze' ? 168 : kind === 'shutter' ? 159 : family === 1 ? 165 : 203;
  const bytes = frame(size, (b) => {
    Buffer.from(device.id, 'hex').copy(b, 18);
    b[40] = parseInt(device.key ?? '00', 16);
    Buffer.from(device.name ?? '', 'latin1').copy(b, 42, 0, 32);
    Buffer.from(device.model, 'hex').copy(b, 74);
    const ip = Buffer.from(device.ip.split('.').map(Number));
    const mac = Buffer.from(device.mac, 'hex');
    if (family === 1) {
      ip.copy(b, 76);
      mac.copy(b, 80);
    } else {
      ip.copy(b, 77);
      mac.copy(b, 81);
    }
    if (kind === 'breeze') Buffer.from(device.remote ?? '', 'latin1').copy(b, 143, 0, 8);
    edit?.(b);
  });
  return {
    source_ip: sourceIp,
    source_port: family === 1 ? 20002 : 20003,
    payload_base64: bytes.toString('base64'),
  };
}

let nextMac = 1;
let nextHost = 2;

/**
 * Starts a fake device. `model`: '0317' (V4 water heater), '01a8' (plug),
 * '0c01' (Runner), '0e01' (Breeze). `port`: the port of its family (the
 * tests use one port per family, one loopback address per device).
 */
export async function fakeSwitcher({
  model = '0317',
  port = 0,
  ip = `127.0.0.${nextHost++}`,
  mac = `0a00000000${(nextMac++).toString(16).padStart(2, '0')}`,
  id = Buffer.from([0xa1, 0xb2, nextMac & 0xff]).toString('hex'),
  key = '18',
  name = undefined,
  remote = 'ELEC7022',
  clock = () => performance.now(),
  ...knobs
} = {}) {
  const kind = kindOf(model);
  const family = MODELS[model].family;
  const sockets = new Set();
  const dev = {
    model,
    kind,
    family,
    ip,
    mac,
    id,
    key,
    name: name ?? `Switcher ${kind} ${mac.slice(-4)}`,
    remote,
    port: 0,
    latencyMs: 0,
    silent: false,
    refuse: false,
    ignore: false,
    applyDelayMs: 0,
    garbage: false,
    mute: new Set(), // request types never answered (acted on all the same)
    noTimer: false, // the device ignores the timer of a switch-on
    timeOnZero: false, // the device always reads 0 as its time on
    onRequest: undefined, // (type) => void, called as each request is handled (before its answer)
    offCode: breezeOffCode(remote),
    ...knobs,
    // State
    power: 0,
    watts: 0,
    timerEnd: undefined, // clock() ms when the device timer ends
    onSince: undefined,
    position: 50,
    direction: 'stop',
    temperature: 24.5,
    mode: 4,
    target: 22,
    // Records
    connections: 0,
    open: 0,
    peak: 0,
    requests: [], // { type, at (clock), conn, ...fields }
    rejected: [], // frames refused (bad CRC, bad key or id)
    processed: new Map(), // client port -> frames handled (the tests wait for them)
    pendingReplies: 0, // answers scheduled, not written yet
    sessions: new Map(), // connection -> session id
    announcement: (options) => announcement(dev, options),
    count: (type) => dev.requests.filter((r) => r.type === type).length,
    last: (type) => dev.requests.filter((r) => r.type === type).at(-1),
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };

  const timeLeft = () =>
    dev.power === 1 && dev.timerEnd !== undefined
      ? Math.max(0, Math.round((dev.timerEnd - clock()) / 1000))
      : 0;
  const tick = () => {
    if (dev.power === 1 && dev.timerEnd !== undefined && clock() >= dev.timerEnd) {
      dev.power = 0;
      dev.watts = 0;
      dev.timerEnd = undefined;
    }
  };

  const apply = (fn) => {
    if (dev.ignore) return;
    if (dev.applyDelayMs > 0) setTimeout(fn, dev.applyDelayMs);
    else fn();
  };

  const answers = {
    login: (session) =>
      frame(48, (b) => {
        Buffer.from(session, 'hex').copy(b, 8);
      }),
    state1: () =>
      frame(112, (b) => {
        tick();
        b[75] = dev.power;
        b.writeUInt16LE(dev.power ? dev.watts : 0, 77);
        b.writeUInt32LE(timeLeft(), 89);
        b.writeUInt32LE(
          !dev.timeOnZero && dev.power === 1 && dev.onSince !== undefined
            ? Math.max(0, Math.round((clock() - dev.onSince) / 1000))
            : 0,
          93,
        );
        b.writeUInt32LE(3 * 3600, 97);
      }),
    breeze: () =>
      frame(109, (b) => {
        b.writeInt16LE(Math.round(dev.temperature * 10), 76);
        b[78] = dev.power;
        b[79] = { 0: 1, 3: 2, 4: 3, 1: 4, 2: 5 }[dev.mode];
        b[80] = dev.target;
        b[81] = 0x21;
        Buffer.from(dev.remote, 'latin1').copy(b, 84, 0, 8);
      }),
    shutter: () =>
      frame(100, (b) => {
        b[76] = dev.position;
        Buffer.from({ stop: '0000', up: '0100', down: '0001' }[dev.direction], 'hex').copy(b, 78);
      }),
    ok: () => frame(56, () => {}),
  };

  /** One whole request -> its answer (a Buffer) or undefined. */
  function handle(req, conn) {
    const bad = frameError(req, { min: 12, max: 1024 });
    if (bad) {
      dev.rejected.push({ reason: bad, at: clock() });
      return undefined;
    }
    const at = clock();
    const head = req.subarray(4, 8).toString('hex');
    const session = req.subarray(8, 12).toString('hex');
    const idAt = req.subarray(40, 43).toString('hex');
    const own = conn.session;
    const record = (type, extra = {}) => {
      dev.requests.push({ type, at, conn: conn.id, ...extra });
      dev.onRequest?.(type);
    };
    if (head === '0232a100') {
      if (family !== 1 || req[40] !== parseInt(dev.key, 16)) {
        dev.rejected.push({ reason: 'key', at });
        return undefined;
      }
      conn.session = Buffer.from([0x01, 0x02, 0x03, conn.id & 0xff]).toString('hex');
      record('login');
      return answers.login(conn.session);
    }
    if (head === '0305a600') {
      if (family !== 2 || idAt !== dev.id) {
        dev.rejected.push({ reason: 'id', at });
        return undefined;
      }
      conn.session = Buffer.from([0x05, 0x06, 0x07, conn.id & 0xff]).toString('hex');
      record('login');
      return answers.login(conn.session);
    }
    if (!own || session !== own || idAt !== dev.id) {
      dev.rejected.push({ reason: 'session', at });
      return undefined;
    }
    if (head === '02320103' || head === '03050103') {
      record('state');
      return kind === 'breeze'
        ? answers.breeze()
        : kind === 'shutter'
          ? answers.shutter()
          : answers.state1();
    }
    if (head === '02320102' && family === 1) {
      const on = req[83] & 0x0f;
      const timer = req.readUInt32LE(85);
      record(on ? 'on' : 'off', { timer });
      apply(() => {
        if (on) {
          if (dev.power === 0) dev.onSince = clock();
          dev.power = 1;
          dev.watts = kind === 'heater' ? 2400 : 120;
          dev.timerEnd = timer > 0 && !dev.noTimer ? clock() + timer * 1000 : undefined;
        } else {
          dev.power = 0;
          dev.watts = 0;
          dev.timerEnd = undefined;
          dev.onSince = undefined;
        }
      });
      return answers.ok();
    }
    if (head === '03050102' && kind === 'shutter') {
      const code = req.subarray(79, 81).toString('hex');
      if (code === '3702') {
        record('stop');
        apply(() => (dev.direction = 'stop'));
        return answers.ok();
      }
      if (code === '3701') {
        const position = req[83];
        record('position', { position });
        apply(() => {
          dev.direction =
            position > dev.position ? 'up' : position < dev.position ? 'down' : 'stop';
          dev.target = position;
          if (dev.instantMoves !== false) {
            dev.position = position;
            dev.direction = 'stop';
          }
        });
        return answers.ok();
      }
    }
    if (head === '03050102' && kind === 'breeze') {
      const length = req.readUInt16LE(81);
      const command = req.subarray(83, 83 + length);
      const code = command.subarray(4).toString('latin1');
      record('ir', { code });
      apply(() => {
        if (code === dev.offCode) dev.power = 0;
      });
      return answers.ok();
    }
    dev.rejected.push({ reason: 'unknown', at });
    return undefined;
  }

  const server = createServer((socket) => {
    socket.on('error', () => {});
    dev.connections += 1;
    if (dev.refuse) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    dev.open += 1;
    dev.peak = Math.max(dev.peak, dev.open);
    const conn = { id: dev.connections, session: undefined };
    socket.on('close', () => {
      sockets.delete(socket);
      dev.open -= 1;
    });
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt16LE(2);
        if (length < 12 || length > 1024) {
          socket.destroy();
          return;
        }
        if (buffer.length < length) break;
        const req = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        const before = dev.requests.length;
        const out = handle(req, conn);
        dev.processed.set(socket.remotePort, (dev.processed.get(socket.remotePort) ?? 0) + 1);
        const type = dev.requests.length > before ? dev.requests.at(-1).type : undefined;
        if (!out || dev.silent || dev.mute.has(type)) continue;
        const reply = dev.garbage
          ? Buffer.concat([out.subarray(0, -4), Buffer.from('00000000', 'hex')])
          : out;
        dev.pendingReplies += 1;
        setTimeout(() => {
          dev.pendingReplies -= 1;
          if (!socket.destroyed) socket.write(reply);
        }, dev.latencyMs);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, ip, () => resolve());
  });
  dev.port = server.address().port;
  return dev;
}

/** CRC check used by the tests on what the app writes. */
export const crcOf = (bytes) => crc16(bytes.subarray(0, bytes.length - 4));
