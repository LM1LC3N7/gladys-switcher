// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in one small JSON file readable by the container user only
// (0600), written through a temporary file, fsync and rename:
//   - the devices found by the scans (MAC, protocol id, login key, model,
//     name, address, Breeze remote): a stop kept here leaves after a restart
//     before the configuration of Gladys is read and before any scan;
//   - the time of the last read attempt (a restart never reads sooner);
//   - the stops to apply (water heater, plug, Breeze off), sent or not yet,
//     until a read shows them applied;
//   - the water heater runs the module started (start time, length): a run
//     the device does not end by itself is stopped by the module.
// Nothing secret: the protocol has no password (the ids and keys are
// broadcast by the devices on the network).
//
// Bounded: the file is opened without following a link and without waiting
// (a FIFO or another special file is refused, never read), 64 KB at most;
// a save never waits more than `queueWait` for the one before it. The app
// also bounds every load and save (src/app.js): a /data that does not answer
// is unreadable or not written, never a wait.
// -----------------------------------------------------------------------------

import * as fsPromises from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { LIMITS, TIMINGS } from './constants.js';
import { MODELS } from './protocol/packets.js';
import { unicastIPv4, validMac } from './protocol/parse.js';

export const STATE_FILE = '/data/switcher-state.json';
export const FORMAT = 1;
const MAX_BYTES = 64 * 1024;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

export function fileStore(
  path = STATE_FILE,
  { fs = fsPromises, timers = globalThis, queueWait = TIMINGS.storeQueue } = {},
) {
  let previous = Promise.resolve();
  let count = 0;
  let placed = 0;
  let sharedBusy = false;
  return {
    /** null when there is no file; throws when it cannot be read, is not a plain file or does not parse. */
    async load() {
      let handle;
      try {
        handle = await fs.open(path, fsConstants.O_RDONLY | NOFOLLOW | NONBLOCK);
      } catch (err) {
        if (err?.code === 'ENOENT') {
          return null;
        }
        throw err;
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          throw Object.assign(new Error('not a plain file'), { code: 'ESPECIAL' });
        }
        if (stat.size > MAX_BYTES) {
          throw Object.assign(new Error('state file too large'), { code: 'EFBIG' });
        }
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_BYTES) {
          throw Object.assign(new Error('state file too large'), { code: 'EFBIG' });
        }
        return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      } finally {
        await handle.close().catch(() => {});
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const seq = ++count;
      const before = previous;
      const write = (async () => {
        let timer;
        await Promise.race([
          before,
          new Promise((resolve) => {
            timer = timers.setTimeout(resolve, queueWait);
          }),
        ]);
        timers.clearTimeout(timer);
        const shared = !sharedBusy;
        if (shared) sharedBusy = true;
        const temporary = shared ? `${path}.tmp` : `${path}.tmp-${seq}`;
        try {
          const file = await fs.open(
            temporary,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW | NONBLOCK,
            0o600,
          );
          try {
            const stat = await file.stat();
            if (!stat.isFile()) {
              throw Object.assign(new Error('not a plain file'), { code: 'ESPECIAL' });
            }
            await file.writeFile(text, 'utf8');
            await file.sync();
          } finally {
            await file.close().catch(() => {});
          }
          if (seq < placed) {
            // A newer state is in place (this write hung meanwhile): never put back over it.
            await fs.unlink(temporary).catch(() => {});
            return;
          }
          await fs.rename(temporary, path);
          placed = Math.max(placed, seq);
        } finally {
          if (shared) sharedBusy = false;
        }
      })();
      previous = write.catch(() => {});
      return write;
    },
  };
}

/** The same in memory (tests): `fail` makes the saves throw, `unreadable` the loads, `hang` both wait forever. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : structuredClone(initial),
    saves: 0,
    loads: 0,
    fail: false,
    unreadable: false,
    hang: false,
    async load() {
      this.loads += 1;
      if (this.hang) return new Promise(() => {});
      if (this.unreadable) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return this.data === null ? null : structuredClone(this.data);
    },
    async save(data) {
      if (this.hang) return new Promise(() => {});
      if (this.fail) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;
const str = (value, pattern) =>
  typeof value === 'string' && pattern.test(value) ? value : undefined;

const MAC = /^[0-9a-f]{12}$/;
const ID = /^[0-9a-f]{6}$/;
const KEY = /^[0-9a-f]{2}$/;
const MODEL = /^[0-9a-f]{4}$/;
const NAME = /^[\x20-\x7e]{1,32}$/;
const REMOTE = /^[A-Za-z0-9_]{1,8}$/;
const IP = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export const emptyMemory = () => ({
  format: FORMAT,
  attemptAt: 0,
  devices: [],
  stops: [],
  runs: [],
});

/** A known device read back, or undefined when a field it needs is not sound. */
export function normalizeDevice(raw) {
  const mac = str(own(raw, 'mac'), MAC);
  const id = str(own(raw, 'id'), ID);
  const model = str(own(raw, 'model'), MODEL);
  if (!mac || !id || !model || !validMac(mac) || !MODELS[model]) return undefined;
  const ip = str(own(raw, 'ip'), IP);
  return {
    mac,
    id,
    model,
    key: str(own(raw, 'key'), KEY),
    name: str(own(raw, 'name'), NAME),
    ip: ip && unicastIPv4(ip, { allowLoopback: true }) ? ip : undefined,
    remote: str(own(raw, 'remote'), REMOTE),
  };
}

/**
 * The file read back, repaired: only known keys of the expected shape (never
 * an inherited or `__proto__` key). A date in the future (a clock set back, a
 * hand-edited file) counts as now.
 */
export function normalizeMemory(raw, now) {
  const memory = emptyMemory();
  const attemptAt = own(raw, 'attemptAt');
  memory.attemptAt = Number.isFinite(attemptAt) && attemptAt > 0 ? Math.min(attemptAt, now) : 0;
  const seen = new Set();
  const devices = own(raw, 'devices');
  for (const entry of Array.isArray(devices) ? devices.slice(0, LIMITS.devices) : []) {
    const device = normalizeDevice(entry);
    if (device && !seen.has(device.mac)) {
      seen.add(device.mac);
      memory.devices.push(device);
    }
  }
  const stops = own(raw, 'stops');
  const stopped = new Set();
  for (const entry of Array.isArray(stops) ? stops.slice(0, LIMITS.devices) : []) {
    const mac = str(own(entry, 'mac'), MAC);
    if (!mac || stopped.has(mac)) continue;
    stopped.add(mac);
    const sends = own(entry, 'sends');
    const clickedAt = own(entry, 'clickedAt');
    memory.stops.push({
      mac,
      sent: own(entry, 'sent') === true,
      // An unreadable count is 0: the stop keeps its sends.
      sends: Number.isInteger(sends) && sends >= 0 ? Math.min(sends, 99) : 0,
      clickedAt: Number.isFinite(clickedAt) && clickedAt > 0 ? Math.min(clickedAt, now) : now,
    });
  }
  const runs = own(raw, 'runs');
  const running = new Set();
  for (const entry of Array.isArray(runs) ? runs.slice(0, LIMITS.devices) : []) {
    const mac = str(own(entry, 'mac'), MAC);
    const minutes = own(entry, 'minutes');
    const startedAt = own(entry, 'startedAt');
    if (!mac || running.has(mac) || !Number.isInteger(minutes) || minutes < 1 || minutes > 150) {
      continue;
    }
    running.add(mac);
    memory.runs.push({
      mac,
      minutes,
      // A start in the future counts as now: never a longer run.
      startedAt: Number.isFinite(startedAt) && startedAt > 0 ? Math.min(startedAt, now) : now,
    });
  }
  return memory;
}

/** The persisted form (plain objects of validated keys only). */
export function serializeMemory(memory) {
  return {
    format: FORMAT,
    attemptAt: memory.attemptAt,
    devices: memory.devices.slice(0, LIMITS.devices).map((d) => ({
      mac: d.mac,
      id: d.id,
      model: d.model,
      ...(d.key ? { key: d.key } : {}),
      ...(d.name ? { name: d.name } : {}),
      ...(d.ip ? { ip: d.ip } : {}),
      ...(d.remote ? { remote: d.remote } : {}),
    })),
    stops: memory.stops.slice(0, LIMITS.devices).map((s) => ({
      mac: s.mac,
      sent: s.sent === true,
      sends: s.sends,
      clickedAt: s.clickedAt,
    })),
    runs: memory.runs.slice(0, LIMITS.devices).map((r) => ({
      mac: r.mac,
      minutes: r.minutes,
      startedAt: r.startedAt,
    })),
  };
}
