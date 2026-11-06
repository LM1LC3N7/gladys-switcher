// -----------------------------------------------------------------------------
// The integration: Switcher devices found by the network scans of Gladys (the
// devices announce themselves in UDP broadcast, which only the core can hear),
// read and driven over their local TCP protocol, one session at a time per
// device. index.js only wires the SDK (src/handlers.js).
//
// Two clocks: `now` (wall clock) dates only what /data keeps (the time of the
// last read attempt, the stops, the water heater runs) and the clock field of
// the requests; `monotonic` paces the reads, the deadlines, the backoff, the
// identity freshness and the publication budget. One read of the clock per
// decision.
//
// Identity: the MAC address the device announces (src/devices.js). A device is
// trusted at its address only while a scan saw it there within 15 minutes
// (scans every 5 minutes, and from the Discovery tab and the Test button);
// otherwise it is not read and only stops are sent to it.
//
// Reads: one session per device every interval (30 s by default, 10 to 600),
// never sooner (the time of the attempt is kept in /data, written before each
// read; a restart waits for the rest of the interval).
// Failed reads wait 30 s, 1, 2, then 5 min, never less than the interval.
// The reads after a command (5 s, 20 s) are the only sooner ones.
//
// Stops (water heater off, plug off, Breeze off, shutter stop), the protective
// commands:
//   - never refused for an option, the identity, a read, a command or a read
//     in progress, a missing configuration (the devices and the stops are
//     kept in /data), nor before the first read or scan; never skipped as
//     "already off";
//   - they cancel the commands of the device still waiting, take its lane
//     first and cut the session in progress (a new connection opens only
//     once that socket is closed); they never wait for /data (the save runs
//     beside them);
//   - a stop that could not leave is tried again every 250 ms for 3 s, then
//     kept and tried again 10 s, 30 s later, then every minute, and first at
//     every read; only a write of the stop counts as a try: a stop never
//     sent is never given up (a shutter stop excepted, below);
//   - confirmed by a read started after its write that shows the device off;
//     until then each such read showing it on sends it again, 3 answered
//     writes at most (a write the device does not answer does not count: a
//     stop never answered is never given up); lifted by that confirmation or by a "switch on" from Gladys that
//     left; never by the time. Kept in /data until then;
//   - a shutter stop is a momentary command: kept in RAM only, tried while
//     the shutter can still be moving (3 minutes after the click), never
//     replayed after a restart (it would stop a movement started since).
// Other commands (each behind its option): water heater on (always with the
// device timer of the configured run, 1 to 150 minutes, and a run still on
// 2 minutes after its end is switched off by the module), plug on, shutter
// moves. Refused before the configuration is read, when the identity is not
// fresh, when /data cannot be written, while a stop of the device is being
// sent; they cut a read in progress (not a failure of the device); written
// within 3 s of the click or refused "nothing sent" (option, identity,
// deadline and cancellation checked again right before the write); confirmed
// only by a read started after the write showing the value, else "sent,
// without confirmation" and reads 5 s and 20 s later.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { FEATURES, HEATER_MINUTES, LIMITS, MINUTE, TCP_PORTS, TIMINGS } from './constants.js';
import { buildDevice, deviceIds, macOfExternalId, nameOf, PARAMS } from './devices.js';
import { BADGE, ERRORS, T, age, both, join, message } from './i18n.js';
import { Lane, LaneTimeout, PRIORITY } from './lane.js';
import { StatePublisher } from './publisher.js';
import {
  emptyMemory,
  fileStore,
  normalizeDevice,
  normalizeMemory,
  serializeMemory,
} from './store.js';
import { breezeOffCode } from './breeze/remotes.js';
import { seal } from './protocol/frame.js';
import {
  MODELS,
  SUPPORTED_KINDS,
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
} from './protocol/packets.js';
import {
  commandAnswered,
  crcOnly,
  parseBreeze,
  parseDatagram,
  parseLogin,
  parseShutter,
  parseState1,
  unicastIPv4,
} from './protocol/parse.js';
import { Session, SessionError } from './protocol/session.js';

const TIMEOUT = Symbol('timeout');

/** A promise bounded in time: TIMEOUT when it takes longer (its rejection is returned as is). */
function bounded(promise, ms, timers) {
  let timer;
  return Promise.race([
    promise.then(
      (value) => value,
      (err) => ({ [TIMEOUT]: false, err }),
    ),
    new Promise((resolve) => {
      timer = timers.setTimeout(() => resolve(TIMEOUT), ms);
    }),
  ]).finally(() => timers.clearTimeout(timer));
}

const kindOf = (known) => MODELS[known?.model]?.kind;

class Refusal extends Error {
  constructor(text) {
    super(message(text));
    this.name = 'Refusal';
  }
}

/** A command value: a finite number, never null, '' nor a boolean (they are not 0). */
function strictNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^\s*-?\d+(?:\.\d+)?\s*$/.test(value)) return Number(value);
  return undefined;
}

export class SwitcherApp {
  constructor({
    gladys,
    store = fileStore(),
    logger = createLogger({ name: 'switcher' }),
    now = () => Date.now(),
    monotonic = () => performance.now(),
    timers = globalThis,
    connect,
    ports = TCP_PORTS,
    allowLoopback = false,
  }) {
    this.gladys = gladys;
    this.store = store;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.connect = connect;
    this.ports = ports;
    this.allowLoopback = allowLoopback;
    this.publisher = new StatePublisher({ gladys, logger, monotonic, timers });

    this.config = undefined;
    this.configTries = 0;
    this.configTimer = undefined;
    this.configChain = Promise.resolve();
    /** 'loading' | 'ok' | 'unreadable' */
    this.memoryState = 'loading';
    this.loading = undefined;
    this.loadTimer = undefined;
    this.attemptAt = 0;
    this.dataWritable = true;
    /** mac -> known device { mac, id, key, model, name, ip, remote } */
    this.known = new Map();
    /** mac -> stop { mac, kind: 'off' | 'shutter', sent, sends, clickedAt, clickMono, sentMono, lastResendRead } */
    this.stops = new Map();
    /** mac -> water heater run { mac, minutes, startedAt (wall), startMono?, sentMono? } */
    this.runs = new Map();
    /** mac -> runtime state (src: newRuntime) */
    this.rt = new Map();
    /** Names of the models found that need the account token. */
    this.tokenModels = new Map();
    /** Switcher announcements refused for their CRC alone (last scan): source -> name. */
    this.crcRefused = new Map();
    this.scanning = undefined;
    this.scanTimer = undefined;
    this.scanState = 'none'; // 'none' | 'ok' | 'failed' | 'unavailable'
    this.lastScanOk = undefined; // monotonic start of the last scan that worked
    this.booted = false;
    this.stopped = false;
    this.lastStatus = undefined;
    this.lastTransports = new Map();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Every connection to Gladys (the first one boots). */
  async connected() {
    if (this.stopped) return;
    if (!this.booted) {
      this.booted = true;
      this.publisher.start();
      // /data first: the stops it keeps leave without the configuration.
      await this.loadMemory();
    }
    // Nothing published before a reconnection is taken as current.
    try {
      this.gladys.forgetPublishedStates?.();
    } catch {
      // never blocking
    }
    this.lastStatus = undefined;
    this.lastTransports.clear();
    this.adoptCreatedDevices();
    await this.readConfig();
    await this.publishDiscovered().catch((err) =>
      this.logger.warn(`Publishing the devices failed: ${err.message}`),
    );
    this.updateStatus();
    this.scheduleScan(0);
  }

  async stop() {
    this.stopped = true;
    this.publisher.stop();
    this.timers.clearTimeout(this.configTimer);
    this.timers.clearTimeout(this.scanTimer);
    this.timers.clearTimeout(this.loadTimer);
    for (const rt of this.rt.values()) {
      this.timers.clearTimeout(rt.readTimer);
      this.timers.clearTimeout(rt.stopTimer);
      for (const t of rt.followTimers) this.timers.clearTimeout(t);
      rt.holder?.abort();
      for (const entry of rt.commands) entry.cancelled = true;
    }
    if (this.memoryState === 'ok') {
      await bounded(this.saveMemory(), TIMINGS.storeSave, this.timers);
    }
  }

  // ---------------------------------------------------------------------------
  // Configuration (getConfig retried without end; saves applied one by one)
  // ---------------------------------------------------------------------------

  async readConfig() {
    this.timers.clearTimeout(this.configTimer);
    let raw;
    try {
      raw = await this.gladys.getConfig();
    } catch (err) {
      const delays = TIMINGS.configRetry;
      const wait = delays[Math.min(this.configTries, delays.length - 1)];
      this.configTries += 1;
      this.logger.warn(`Reading the configuration failed: ${err.message}`);
      this.configError = wait;
      this.updateStatus();
      if (!this.stopped) {
        this.configTimer = this.timers.setTimeout(() => this.readConfig(), wait);
      }
      return;
    }
    this.configTries = 0;
    this.configError = undefined;
    await this.configUpdated(raw);
  }

  configUpdated(raw) {
    const run = this.configChain.then(() => this.applyConfig(raw));
    this.configChain = run.catch(() => {});
    return run;
  }

  applyConfig(raw) {
    if (this.stopped) return;
    const before = this.config;
    this.config = normalizeConfig(raw);
    this.configError = undefined;
    if (!before || before.readInterval !== this.config.readInterval) {
      for (const mac of this.known.keys()) this.scheduleRead(mac);
    }
    this.updateStatus();
  }

  // ---------------------------------------------------------------------------
  // /data
  // ---------------------------------------------------------------------------

  /**
   * Reads /data: waited for at most `storeLoad`; one read at a time; a read
   * that fails or is slow is tried again every 10 s, and a slow one that
   * answers late is still taken (merged over what RAM holds meanwhile).
   */
  loadMemory() {
    this.timers.clearTimeout(this.loadTimer);
    if (this.memoryState === 'ok' || this.stopped) return Promise.resolve();
    if (!this.loading) {
      this.loading = this.store.load().then(
        (raw) => {
          this.loading = undefined;
          this.applyLoaded(raw);
          return true;
        },
        (err) => {
          this.loading = undefined;
          this.logger.warn(`Reading /data failed: ${err.message}`);
          return false;
        },
      );
    }
    return bounded(this.loading, TIMINGS.storeLoad, this.timers).then((read) => {
      if (read === true || this.memoryState === 'ok' || this.stopped) return;
      this.memoryState = 'unreadable';
      this.updateStatus();
      this.loadTimer = this.timers.setTimeout(() => this.loadMemory(), TIMINGS.storeRetry);
    });
  }

  applyLoaded(raw) {
    if (this.memoryState === 'ok' || this.stopped) return;
    const memory = raw ? normalizeMemory(raw, this.now()) : emptyMemory();
    this.mergeMemory(memory);
    this.memoryState = 'ok';
    this.timers.clearTimeout(this.loadTimer);
    this.updateStatus();
    // What RAM gathered while /data was unreadable is written now.
    this.saveLater();
    // The kept stops leave now (no configuration, read nor scan needed): the
    // ones never sent, and the ones sent but not confirmed within their 3 writes.
    for (const stop of this.stops.values()) {
      if (!stop.sent || stop.sends < LIMITS.stopSends) this.kickStop(stop.mac);
    }
  }

  /** What /data holds, added to what is in RAM: a click or a scan made meanwhile is never replaced. */
  mergeMemory(memory) {
    this.attemptAt = Math.max(this.attemptAt, memory.attemptAt);
    for (const device of memory.devices) {
      if (!this.known.has(device.mac) && this.known.size < LIMITS.devices) {
        this.known.set(device.mac, device);
        this.scheduleRead(device.mac);
      }
    }
    const mono = this.monotonic();
    for (const stop of memory.stops) {
      if (!this.stops.has(stop.mac)) {
        this.stops.set(stop.mac, {
          ...stop,
          kind: 'off',
          clickMono: mono,
          // Sent before the restart: a read after now may confirm it or send it again.
          sentMono: stop.sent ? mono : undefined,
        });
      }
    }
    for (const run of memory.runs) {
      if (!this.runs.has(run.mac)) {
        // Kept before a restart: every read from now on speaks about it.
        this.runs.set(run.mac, { ...run, startMono: undefined, sentMono: -Infinity });
      }
    }
  }

  snapshot() {
    return serializeMemory({
      attemptAt: this.attemptAt,
      devices: [...this.known.values()],
      // Shutter stops are momentary: never kept.
      stops: [...this.stops.values()].filter((s) => s.kind === 'off'),
      runs: [...this.runs.values()],
    });
  }

  /** Saves /data (never over a file that could not be read); resolves true when written. */
  async saveMemory() {
    if (this.memoryState !== 'ok') return false;
    try {
      await this.store.save(this.snapshot());
      this.setWritable(true);
      return true;
    } catch (err) {
      this.logger.warn(`Writing /data failed: ${err.message}`);
      this.setWritable(false);
      return false;
    }
  }

  /** A save nobody waits for (the stops never wait for /data). */
  saveLater() {
    this.saveMemory().catch(() => {});
  }

  /** A save waited for at most `storeSave`: true only when written in time. */
  async saveBounded() {
    const result = await bounded(this.saveMemory(), TIMINGS.storeSave, this.timers);
    if (result === TIMEOUT) {
      this.setWritable(false);
      return false;
    }
    return result === true;
  }

  setWritable(ok) {
    if (this.dataWritable !== ok) {
      this.dataWritable = ok;
      this.updateStatus();
    }
  }

  // ---------------------------------------------------------------------------
  // Devices: known, runtime, adoption from Gladys
  // ---------------------------------------------------------------------------

  runtime(mac) {
    let rt = this.rt.get(mac);
    if (!rt) {
      rt = {
        lane: new Lane({ timers: this.timers }),
        holder: undefined,
        seenAt: undefined, // monotonic time of the last scan that saw it at its address
        readTimer: undefined,
        stopTimer: undefined,
        stopTries: 0,
        stopInFlight: undefined,
        followTimers: new Set(),
        commands: new Set(),
        lastReadStart: undefined, // monotonic start of the last read attempt (periodic)
        appliedStart: -Infinity, // start of the newest read applied
        failures: 0,
        ok: undefined, // last read: true | false | undefined
        state: undefined, // last state read { power?, position?, ... }
        expect: undefined, // command waiting for its confirmation { check, sentMono }
        badge: undefined, // degraded badge text
      };
      this.rt.set(mac, rt);
    }
    return rt;
  }

  /** The devices the user created: what their params say is known (never replaces a scan). */
  adoptCreatedDevices() {
    for (const device of this.gladys.devices ?? []) this.adopt(device);
  }

  adopt(device) {
    const ref = macOfExternalId(this.gladys, device?.external_id);
    if (!ref || ref.key !== undefined) return undefined;
    const params = Object.fromEntries((device.params ?? []).map((p) => [p.name, p.value]));
    if (params[PARAMS.MAC] !== ref.mac) return this.known.get(ref.mac);
    const known = normalizeDevice({
      mac: ref.mac,
      id: params[PARAMS.ID],
      key: params[PARAMS.KEY],
      model: params[PARAMS.MODEL],
      ip: params[PARAMS.IP],
      remote: params[PARAMS.REMOTE],
    });
    if (known && !this.known.has(known.mac) && this.known.size < LIMITS.devices) {
      if (known.ip && !unicastIPv4(known.ip, { allowLoopback: this.allowLoopback })) {
        known.ip = undefined;
      }
      this.known.set(known.mac, known);
      this.scheduleRead(known.mac);
    }
    return this.known.get(ref.mac);
  }

  deviceCreated(device) {
    const known = this.adopt(device);
    if (known) this.scheduleRead(known.mac);
    this.publishBadges();
  }

  deviceDeleted(device) {
    const ref = macOfExternalId(this.gladys, device?.external_id);
    if (ref) this.publisher.forget(deviceIds(this.gladys, ref.mac).device);
  }

  /**
   * Whether the device may be read at its address: seen there by a scan
   * within 15 minutes, or no scan has worked since it was seen (a failing scan
   * is unknown, never "the device left").
   */
  identityReadable(mac, mono = this.monotonic()) {
    const rt = this.rt.get(mac);
    if (rt?.seenAt === undefined || this.known.get(mac)?.ip === undefined) return false;
    return (
      this.identityFresh(mac, mono) || this.lastScanOk === undefined || this.lastScanOk <= rt.seenAt
    );
  }

  identityFresh(mac, mono = this.monotonic()) {
    const rt = this.rt.get(mac);
    return (
      rt?.seenAt !== undefined &&
      mono - rt.seenAt <= TIMINGS.identityFor &&
      this.known.get(mac)?.ip !== undefined
    );
  }

  // ---------------------------------------------------------------------------
  // Scans (mediated by the core: UDP broadcast on the four Switcher ports)
  // ---------------------------------------------------------------------------

  scheduleScan(delay = TIMINGS.scanEvery) {
    this.timers.clearTimeout(this.scanTimer);
    if (this.stopped) return;
    this.scanTimer = this.timers.setTimeout(() => {
      this.scan({ publish: false }).catch(() => {});
    }, delay);
  }

  /** One scan at a time (a click during one waits for it). Resolves the MACs heard. */
  scan({ publish = true } = {}) {
    if (!this.scanning) {
      this.scanning = this.doScan()
        .finally(() => {
          this.scanning = undefined;
          this.scheduleScan();
        })
        .then(async (result) => {
          if (publish || result.changed) await this.publishDiscovered();
          return result;
        });
    } else if (publish) {
      return this.scanning.then(async (result) => {
        await this.publishDiscovered();
        return result;
      });
    }
    return this.scanning;
  }

  async doScan() {
    const started = this.monotonic();
    let results;
    try {
      results = await this.gladys.scanNetwork('udp-broadcast', {
        timeoutSeconds: TIMINGS.scanSeconds,
      });
      this.scanState = 'ok';
      this.lastScanOk = started;
    } catch (err) {
      this.scanState = err?.status === 403 || err?.status === 404 ? 'unavailable' : 'failed';
      this.logger.warn(`Network scan failed: ${err.message}`);
      this.updateStatus();
      return { heard: [], changed: false };
    }
    const latest = new Map();
    const crcRefused = new Map();
    for (const entry of Array.isArray(results) ? results.slice(0, LIMITS.datagrams) : []) {
      const b64 = entry?.payload_base64;
      if (typeof b64 !== 'string' || b64.length > 400) continue;
      const device = parseDatagram(Buffer.from(b64, 'base64'), entry.source_ip, {
        allowLoopback: this.allowLoopback,
      });
      if (device.error) {
        // A Switcher announcement refused for its CRC alone: named, to be reported.
        if (device.error === 'crc' && typeof entry.source_ip === 'string') {
          crcRefused.set(entry.source_ip, `${device.modelName} (${entry.source_ip.slice(0, 15)})`);
        }
        continue;
      }
      latest.set(device.mac, device);
    }
    this.crcRefused = new Map([...crcRefused].slice(0, 16));
    // One address, two MACs in one scan: neither is trusted there.
    const byIp = new Map();
    for (const d of latest.values()) byIp.set(d.ip, (byIp.get(d.ip) ?? 0) + 1);
    let changed = false;
    const heard = [];
    for (const d of latest.values()) {
      if (d.kind === 'token') {
        this.tokenModels.set(d.mac, `${d.name || d.modelName} (${d.modelName})`);
        continue;
      }
      if (!SUPPORTED_KINDS.includes(d.kind) || byIp.get(d.ip) !== 1) continue;
      const before = this.known.get(d.mac);
      if (!before && this.known.size >= LIMITS.devices) continue;
      const known = {
        mac: d.mac,
        id: d.id,
        key: d.family === 1 ? d.key : undefined,
        model: d.model,
        name: d.name || undefined,
        ip: d.ip,
        remote: d.kind === 'breeze' ? d.remote || undefined : undefined,
      };
      if (!before || JSON.stringify(before) !== JSON.stringify({ ...before, ...known })) {
        changed = true;
      }
      this.known.set(d.mac, { ...before, ...known });
      // Another device that had this address has moved.
      for (const other of this.known.values()) {
        if (other.mac !== d.mac && other.ip === d.ip) {
          other.ip = undefined;
          changed = true;
        }
      }
      const rt = this.runtime(d.mac);
      if (d.crcMismatch) rt.crcMismatch = true;
      const fresh = this.identityReadable(d.mac);
      rt.seenAt = started;
      heard.push(d.mac);
      if (!fresh) this.scheduleRead(d.mac);
      if (this.stops.has(d.mac) && !this.stops.get(d.mac).sent) this.kickStop(d.mac);
    }
    if (changed) this.saveLater();
    this.updateStatus();
    this.publishBadges();
    return { heard, changed };
  }

  async publishDiscovered() {
    const devices = [...this.known.values()]
      .filter((k) => SUPPORTED_KINDS.includes(kindOf(k)))
      .map((k) => buildDevice(this.gladys, k));
    await this.gladys.publishDiscoveredDevices(devices);
  }

  /** The Test button: a scan, and what it heard. */
  async testConnection() {
    const { heard } = await this.scan({ publish: true });
    if (this.scanState === 'unavailable') return message(T.scanUnavailable);
    if (this.scanState === 'failed') return message(T.scanFailed);
    const names = heard.map((mac) => nameOf(this.known.get(mac)));
    const tokens = [...this.tokenModels.values()];
    const refused = [...this.crcRefused.values()];
    if (heard.length === 0 && tokens.length === 0 && refused.length === 0) {
      return message(T.test.none);
    }
    let text = T.test.found(heard.length, names);
    if (tokens.length) text = join(text, T.tokenModels(tokens));
    if (refused.length) text = join(text, T.crcRefused(refused));
    return message(text);
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  portOf(known) {
    return this.ports[MODELS[known.model].family];
  }

  /** Opens a session for `holder` (aborted -> rejects 'aborted'), logs in, resolves { session, sessionId }. */
  async openSession(known, holder, deadline, { stop = false } = {}) {
    const left = deadline - this.monotonic();
    if (left <= 0) throw new SessionError('timeout');
    const session = new Session({ timers: this.timers, monotonic: this.monotonic });
    // Set before connecting: a stop can cut a connection still opening.
    holder.session = session;
    if (holder.aborted) session.abort();
    await session.start({
      ip: known.ip,
      port: this.portOf(known),
      timeoutMs: Math.min(TIMINGS.connect, left),
      connect: this.connect,
    });
    const family = MODELS[known.model].family;
    const ts = timestampHex(this.now());
    const request = family === 1 ? login1(known, ts) : login2(known, ts);
    const answer = await session.exchange(seal(request), {
      timeoutMs: Math.min(TIMINGS.answer, Math.max(1, deadline - this.monotonic())),
    });
    // A stop takes the session id whatever the CRC (a wrong id is ignored by
    // the device, and the stop stays kept); family 1 reads a CRC that differs.
    const sessionId = parseLogin(answer, { lenient: stop || family === 1 });
    if (!sessionId) throw new SessionError('protocol', { sent: true });
    this.noteCrc(known.mac, answer);
    return { session, sessionId, ts };
  }

  /** A frame read whose only defect is its CRC: said on the device and in the status. */
  noteCrc(mac, frame) {
    if (crcOnly(frame)) {
      const rt = this.runtime(mac);
      if (!rt.crcMismatch) {
        rt.crcMismatch = true;
        this.updateStatus();
        this.publishBadges();
      }
    }
  }

  /**
   * Ends a holder's session: the last request left for the kernel (unless the
   * holder was cut by a stop), destroyed, and waited until closed (bounded).
   */
  async endSession(holder) {
    const session = holder.session;
    if (!session) return;
    if (!holder.aborted) await bounded(session.flushed, TIMINGS.closeWait, this.timers);
    session.abort();
    await bounded(session.closed, TIMINGS.closeWait, this.timers);
  }

  newHolder(kind) {
    const holder = {
      kind,
      aborted: false,
      session: undefined,
      abort() {
        holder.aborted = true;
        holder.session?.abort();
      },
    };
    return holder;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Arms the next periodic read of a device: never sooner than the interval after the last attempt. */
  scheduleRead(mac, { delay } = {}) {
    if (this.stopped || !this.config) return;
    const rt = this.runtime(mac);
    this.timers.clearTimeout(rt.readTimer);
    const mono = this.monotonic();
    let wait = delay;
    if (wait === undefined) {
      const interval = this.config.readInterval;
      if (rt.lastReadStart !== undefined) {
        wait = Math.max(0, rt.lastReadStart + interval - mono);
      } else {
        // After a restart: the rest of the interval from the attempt kept in /data.
        wait = Math.max(0, Math.min(interval, this.attemptAt + interval - this.now()));
      }
    }
    rt.readTimer = this.timers.setTimeout(() => {
      this.read(mac, { periodic: true }).catch((err) =>
        this.logger.warn(`Reading ${mac} failed: ${err.message}`),
      );
    }, wait);
  }

  /**
   * Keeps the attempt time in /data before each periodic read (bounded wait;
   * reads of several devices due together share one write): a restart never
   * reads sooner than the interval.
   */
  async noteAttempt() {
    this.attemptAt = this.now();
    if (!this.attemptSaving) {
      this.attemptSaving = this.saveBounded().finally(() => {
        this.attemptSaving = undefined;
      });
    }
    await this.attemptSaving;
  }

  /**
   * Reads one device. `periodic` reads respect the interval and the backoff;
   * follow-up reads (after a command or a stop) do not. Resolves the state
   * read, or undefined.
   */
  async read(mac, { periodic = false, deadlineMs = TIMINGS.readBudget } = {}) {
    if (this.stopped) return undefined;
    const known = this.known.get(mac);
    const rt = this.runtime(mac);
    const mono = this.monotonic();
    // A stop never sent goes first (whatever the identity or the configuration).
    const stop = this.stops.get(mac);
    if (stop && !stop.sent) this.kickStop(mac);
    if (!known || !this.config) return undefined;
    // Read only a device created in Gladys, at an address a scan confirmed.
    const created = (this.gladys.devices ?? []).some(
      (d) => d.external_id === deviceIds(this.gladys, mac).device,
    );
    if (!created || !this.identityReadable(mac, mono) || !SUPPORTED_KINDS.includes(kindOf(known))) {
      if (periodic) this.scheduleRead(mac, { delay: this.config.readInterval });
      this.publishBadges();
      return undefined;
    }
    if (periodic) {
      rt.lastReadStart = mono;
      await this.noteAttempt();
    }
    const deadline = this.monotonic() + deadlineMs;
    let release;
    try {
      release = await rt.lane.acquire(PRIORITY.READ, { waitMs: deadlineMs });
    } catch (err) {
      if (!(err instanceof LaneTimeout)) throw err;
      if (periodic) this.scheduleRead(mac);
      return undefined;
    }
    const holder = this.newHolder('read');
    rt.holder = holder;
    // The start of THIS read: what it shows is newer than any write before it.
    const started = this.monotonic();
    let state;
    let failed = false;
    try {
      const { session, sessionId, ts } = await this.openSession(known, holder, deadline);
      const family = MODELS[known.model].family;
      const request =
        family === 1 ? getState1(known, sessionId, ts) : getState2(known, sessionId, ts);
      const answer = await session.exchange(seal(request), {
        timeoutMs: Math.min(TIMINGS.answer, Math.max(1, deadline - this.monotonic())),
      });
      const kind = kindOf(known);
      state =
        kind === 'shutter'
          ? parseShutter(answer)
          : kind === 'breeze'
            ? parseBreeze(answer)
            : parseState1(answer, { lenient: true });
      if (!state) failed = true;
      else this.noteCrc(mac, answer);
    } catch (err) {
      // A read cut by a stop is not a failure of the device.
      if (!(err instanceof SessionError) || err.kind !== 'aborted' || !holder.aborted) {
        failed = true;
      }
    } finally {
      rt.holder = undefined;
      await this.endSession(holder);
      release();
    }
    if (this.stopped) return undefined;
    if (state) {
      rt.failures = 0;
      rt.ok = true;
      this.applyState(mac, state, started);
    } else if (failed) {
      rt.failures += 1;
      rt.ok = false;
    }
    if (periodic) {
      const backoff = TIMINGS.backoff[Math.min(rt.failures, TIMINGS.backoff.length) - 1];
      const interval = this.config.readInterval;
      this.scheduleRead(mac, {
        delay: failed
          ? Math.max(interval, backoff)
          : Math.max(0, rt.lastReadStart + interval - this.monotonic()),
      });
    }
    this.updateStatus();
    this.publishBadges();
    return state;
  }

  /** A state read: published when newer than the one shown (by start time), then the stops, runs and commands. */
  applyState(mac, state, started) {
    const rt = this.runtime(mac);
    if (started < rt.appliedStart) return;
    rt.appliedStart = started;
    rt.state = state;
    const known = this.known.get(mac);
    const kind = kindOf(known);
    const ids = deviceIds(this.gladys, mac);
    const push = (key, value) => {
      if (value !== undefined && Number.isFinite(value)) {
        this.publisher.push(ids.feature(key), { state: value });
      }
    };
    if (kind === 'heater' || kind === 'plug') {
      push(FEATURES.POWER, state.power);
      push(FEATURES.CONSUMPTION, state.watts);
      if (kind === 'heater') push(FEATURES.REMAINING, state.power === 1 ? state.timeLeft : 0);
    } else if (kind === 'shutter') {
      push(FEATURES.POSITION, state.position);
    } else if (kind === 'breeze') {
      push(FEATURES.POWER, state.power);
      push(FEATURES.TEMPERATURE, state.temperature);
      push(FEATURES.TARGET, state.target);
      push(FEATURES.MODE, state.mode);
      if (
        state.remote &&
        known.remote !== state.remote &&
        /^[A-Za-z0-9_]{1,8}$/.test(state.remote)
      ) {
        known.remote = state.remote;
        this.saveLater();
      }
    }
    this.checkStop(mac, state, started);
    this.checkRun(mac, state, started);
    this.checkExpect(mac, state, started);
  }

  // ---------------------------------------------------------------------------
  // Stops
  // ---------------------------------------------------------------------------

  /** A stop clicked (or decided by the module): never refused. */
  async stopDevice(mac, { kind = 'off', badge } = {}) {
    const mono = this.monotonic();
    const rt = this.runtime(mac);
    const previous = this.stops.get(mac);
    const stop = {
      mac,
      kind,
      sent: false,
      sends: 0,
      clickedAt: this.now(),
      clickMono: mono,
      sentMono: undefined,
      lastResendRead: undefined,
      reason: badge,
    };
    if (previous && previous.kind === kind && rt.stopInFlight) {
      // The same stop is leaving right now: this click joins it.
      Object.assign(previous, { clickMono: mono, sends: 0, reason: badge ?? previous.reason });
    } else {
      this.stops.set(mac, stop);
    }
    // Nothing clicked before the stop leaves after it.
    for (const entry of rt.commands) entry.cancelled = true;
    if (kind === 'off') {
      this.runs.delete(mac);
      this.saveLater();
    }
    this.publishBadges();
    const result = await this.sendStop(mac, { budget: TIMINGS.stopFirstBudget });
    if (result !== 'written') {
      this.armStopRetry(mac);
      throw new Refusal(ERRORS.stopKept);
    }
  }

  /** A kept stop: sent now (nobody waits for it). */
  kickStop(mac) {
    if (this.stopped || !this.stops.has(mac)) return;
    this.sendStop(mac, { budget: TIMINGS.stopFirstBudget })
      .then((result) => {
        if (result !== 'written') this.armStopRetry(mac);
      })
      .catch((err) => this.logger.warn(`Stop of ${mac} failed: ${err.message}`));
  }

  armStopRetry(mac) {
    const rt = this.runtime(mac);
    this.timers.clearTimeout(rt.stopTimer);
    if (this.stopped || !this.stops.has(mac)) return;
    const delays = TIMINGS.stopRetries;
    const wait = delays[Math.min(rt.stopTries, delays.length - 1)];
    rt.stopTries += 1;
    rt.stopTimer = this.timers.setTimeout(() => this.kickStop(mac), wait);
  }

  /**
   * Sends the stop of a device: tries every 250 ms within `budget`, taking the
   * lane first and cutting the session in progress. Resolves 'written' (the
   * stop was handed to the socket), 'notSent', or 'none' (no stop to send).
   * One sending at a time per device: a second call joins the first.
   */
  sendStop(mac, { budget }) {
    const rt = this.runtime(mac);
    if (rt.stopInFlight) return rt.stopInFlight;
    rt.stopInFlight = this.doSendStop(mac, budget).finally(() => {
      rt.stopInFlight = undefined;
      this.updateStatus();
      this.publishBadges();
    });
    return rt.stopInFlight;
  }

  async doSendStop(mac, budget) {
    const rt = this.runtime(mac);
    const deadline = this.monotonic() + budget;
    for (;;) {
      const stop = this.stops.get(mac);
      if (!stop || this.stopped) return 'none';
      if (stop.kind === 'shutter' && this.monotonic() - stop.clickMono > TIMINGS.shutterStopFor) {
        // A shutter stop is momentary: past the travel of the shutter, nothing to stop.
        this.stops.delete(mac);
        return 'none';
      }
      const known = this.known.get(mac);
      if (known?.ip && known.id && deadline - this.monotonic() > 300) {
        const outcome = await this.tryStop(mac, known, stop, deadline);
        if (outcome === 'written') {
          rt.stopTries = 0;
          this.timers.clearTimeout(rt.stopTimer);
          this.followUp(mac);
          return 'written';
        }
      }
      if (this.monotonic() + TIMINGS.stopRetry >= deadline) return 'notSent';
      await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.stopRetry));
    }
  }

  async tryStop(mac, known, stop, deadline) {
    const rt = this.runtime(mac);
    // First in line, and the session in progress (a read, a command) is cut.
    const acquiring = rt.lane.acquire(PRIORITY.STOP);
    if (rt.holder && rt.holder.kind !== 'stop') rt.holder.abort();
    const release = await acquiring;
    const holder = this.newHolder('stop');
    rt.holder = holder;
    let written = false;
    try {
      const { session, sessionId, ts } = await this.openSession(known, holder, deadline, {
        stop: true,
      });
      const request = this.stopRequest(known, sessionId, ts);
      // Its answer is waited for within the budget (200 ms at least): the stop is written either way.
      const wait = Math.min(TIMINGS.answer, Math.max(200, deadline - this.monotonic()));
      await session
        .exchange(seal(request), {
          timeoutMs: wait,
          beforeSend: () => {
            written = true;
            stop.sent = true;
            stop.answered = false;
            stop.sentMono = this.monotonic();
          },
        })
        .then((answer) => {
          // Only an answered write counts among its 3 sends: a stop the device
          // never answers is never given up.
          if (commandAnswered(answer, { lenient: MODELS[known.model].family === 1 })) {
            stop.sends += 1;
            stop.answered = true;
            this.noteCrc(mac, answer);
          }
        })
        .catch((err) => {
          if (!written) throw err;
        });
    } catch (err) {
      this.logger.debug?.(`Stop of ${mac} not sent: ${err.message}`);
    }
    rt.holder = undefined;
    // The lane is released once the socket is closed (one connection at a
    // time); a stop written does not wait for that.
    const closing = this.endSession(holder).finally(release);
    if (!written) await closing;
    else if (stop.kind === 'off') this.saveLater();
    return written ? 'written' : 'notSent';
  }

  stopRequest(known, sessionId, ts) {
    const kind = kindOf(known);
    if (kind === 'shutter') return runnerStop(known, sessionId, ts);
    if (kind === 'breeze') {
      const code = breezeOffCode(known.remote);
      if (!code) throw new Refusal(ERRORS.breezeRemote);
      return breezeCommand(known, sessionId, ts, code);
    }
    return switchOff(known, sessionId, ts);
  }

  /** A state read: confirms the stop, or sends it again (once per read started after its last write). */
  checkStop(mac, state, started) {
    const stop = this.stops.get(mac);
    if (!stop) return;
    if (!stop.sent) {
      this.kickStop(mac);
      return;
    }
    if (stop.sentMono === undefined || started <= stop.sentMono) return;
    const applied = stop.kind === 'shutter' ? state.direction === 'stop' : state.power === 0;
    if (applied) {
      this.stops.delete(mac);
      if (stop.kind === 'off') this.saveLater();
      return;
    }
    if (stop.sends < LIMITS.stopSends && stop.lastResendRead !== started) {
      stop.lastResendRead = started;
      this.kickStop(mac);
    }
  }

  // ---------------------------------------------------------------------------
  // Water heater runs: the device timer ends them; the module checks it did
  // ---------------------------------------------------------------------------

  checkRun(mac, state, started) {
    const run = this.runs.get(mac);
    if (!run || state.power === undefined || kindOf(this.known.get(mac)) !== 'heater') return;
    // Only a read started after the switch-on left says something about this run.
    if (run.sentMono === undefined || started <= run.sentMono) return;
    if (state.power === 0) {
      this.runs.delete(mac);
      this.saveLater();
      return;
    }
    // Elapsed on the session clock (start on the wall clock, then monotonic).
    const elapsed =
      run.startMono !== undefined
        ? this.monotonic() - run.startMono
        : Math.max(0, this.now() - run.startedAt);
    // The "time on" field is trusted for this device only once a read during a
    // run showed it equal to the time elapsed (within 90 s, past 3 minutes):
    // the run is let go as "switched on again elsewhere" only on that proof;
    // otherwise the module switches it off at its end (the safe side).
    const rt = this.runtime(mac);
    const timeOn = Number.isFinite(state.timeOn) ? state.timeOn * 1000 : undefined;
    if (timeOn !== undefined && elapsed >= 180_000 && Math.abs(timeOn - elapsed) <= 90_000) {
      rt.timeOnValid = true;
    }
    if (rt.timeOnValid && timeOn !== undefined && timeOn < elapsed - 90_000) {
      this.runs.delete(mac);
      this.saveLater();
      return;
    }
    if (elapsed > run.minutes * MINUTE + TIMINGS.heaterGrace) {
      this.runs.delete(mac);
      this.stopDevice(mac, { kind: 'off', badge: BADGE.runEnded }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Commands (each behind its option)
  // ---------------------------------------------------------------------------

  async setValue(device, feature, value) {
    const ref = macOfExternalId(this.gladys, feature?.external_id);
    if (!ref || ref.key === undefined) throw new Refusal(ERRORS.unknownDevice);
    const known = this.known.get(ref.mac) ?? this.adopt(device);
    const kind = kindOf(known);
    if (!known || !SUPPORTED_KINDS.includes(kind)) throw new Refusal(ERRORS.unknownDevice);
    const v = strictNumber(value);
    const key = ref.key;
    if (key === FEATURES.POWER && (kind === 'heater' || kind === 'plug' || kind === 'breeze')) {
      if (v === 0) {
        if (kind === 'breeze' && !breezeOffCode(known.remote)) {
          throw new Refusal(ERRORS.breezeRemote);
        }
        return this.stopDevice(known.mac, { kind: 'off' });
      }
      if (v !== 1) throw new Refusal(ERRORS.badValue);
      if (kind === 'breeze') throw new Refusal(ERRORS.breezeOn);
      return this.command(known.mac, kind === 'heater' ? 'heaterOn' : 'plugOn');
    }
    if (kind === 'shutter' && key === FEATURES.STATE) {
      if (v === 0) return this.stopDevice(known.mac, { kind: 'shutter' });
      if (v === 1) return this.command(known.mac, 'position', 100);
      if (v === -1) return this.command(known.mac, 'position', 0);
      throw new Refusal(ERRORS.badValue);
    }
    if (kind === 'shutter' && key === FEATURES.POSITION) {
      if (!Number.isInteger(v) || v < 0 || v > 100) throw new Refusal(ERRORS.badValue);
      return this.command(known.mac, 'position', v);
    }
    throw new Refusal(ERRORS.readOnly);
  }

  optionFor(action) {
    if (!this.config) return false;
    if (action === 'heaterOn') return this.config.allowHeaterOn;
    if (action === 'plugOn') return this.config.allowPlugOn;
    return this.config.allowShutterMoves;
  }

  /** Why a command cannot be sent now (a text), or undefined. */
  refusalOf(mac, action, mono) {
    if (!this.config) return ERRORS.configUnread;
    if (!this.optionFor(action)) {
      return action === 'heaterOn'
        ? ERRORS.heaterOff
        : action === 'plugOn'
          ? ERRORS.plugOff
          : ERRORS.shutterOff;
    }
    if (!this.identityFresh(mac, mono)) return ERRORS.identity;
    if (this.memoryState !== 'ok' || !this.dataWritable) return ERRORS.dataUnwritable;
    if (this.runtime(mac).stopInFlight) return ERRORS.stopping;
    return undefined;
  }

  async command(mac, action, position) {
    const rt = this.runtime(mac);
    const clicked = this.monotonic();
    const deadline = clicked + TIMINGS.commandBy;
    const early = this.refusalOf(mac, action, clicked);
    if (early) throw new Refusal(early);
    const entry = { cancelled: false };
    rt.commands.add(entry);
    const minutes = this.config.heaterMinutes;
    let release;
    let run;
    let previousRun;
    let sent;
    try {
      if (action === 'heaterOn') {
        // The run is kept before the device is switched on (outside the lane:
        // a stop never waits for /data): the module ends it if the device does not.
        previousRun = this.runs.get(mac);
        run = { mac, minutes, startedAt: this.now(), startMono: this.monotonic() };
        this.runs.set(mac, run);
        if (!(await this.saveBounded())) throw new Refusal(ERRORS.dataUnwritable);
        if (entry.cancelled) throw new Refusal(ERRORS.cancelled);
        if (this.monotonic() >= deadline) throw new Refusal(ERRORS.notSent);
      }
      try {
        const acquiring = rt.lane.acquire(PRIORITY.COMMAND, {
          waitMs: Math.max(1, deadline - this.monotonic()),
        });
        // A read in progress gives way (it is not a failure of the device).
        if (rt.holder?.kind === 'read') rt.holder.abort();
        release = await acquiring;
      } catch (err) {
        if (err instanceof LaneTimeout) throw new Refusal(ERRORS.notSent);
        throw err;
      }
      if (entry.cancelled) throw new Refusal(ERRORS.cancelled);
      const before = rt.state;
      const lane = release;
      release = undefined; // released by sendCommand once its socket is closed
      sent = await this.sendCommand(mac, action, {
        position,
        minutes,
        deadline,
        ackBy: clicked + TIMINGS.ackBy,
        entry,
        release: lane,
      });
      if (!sent) throw new Refusal(entry.cancelled ? ERRORS.cancelled : ERRORS.notSent);
      rt.expect = this.expectation(action, { position, minutes, before, sentMono: sent.at });
      rt.badge = BADGE.commandUnconfirmed;
      if (run) {
        // The run starts when the request left.
        run.startedAt = this.now() - (this.monotonic() - sent.at);
        run.startMono = sent.at;
        run.sentMono = sent.at;
      }
    } catch (err) {
      // Nothing left: the run kept for this click is not a run.
      if (run && !sent && this.runs.get(mac) === run) {
        if (previousRun) this.runs.set(mac, previousRun);
        else this.runs.delete(mac);
        this.saveLater();
      }
      throw err;
    } finally {
      rt.commands.delete(entry);
      release?.();
    }
    // A confirmation read within the ack budget, else follow-ups.
    const left = clicked + TIMINGS.ackBy - this.monotonic();
    if (left > 800) {
      await this.read(mac, { deadlineMs: left - 100 }).catch(() => {});
    }
    if (rt.expect) this.followUp(mac);
    this.publishBadges();
  }

  /**
   * One command session: login, the request (option, cancellation, identity
   * and deadline checked again right before the write). Resolves { at } once
   * written, or undefined when nothing left.
   */
  async sendCommand(mac, action, { position, minutes, deadline, ackBy, entry, release }) {
    const rt = this.runtime(mac);
    const known = this.known.get(mac);
    const holder = this.newHolder('command');
    rt.holder = holder;
    let at;
    try {
      const { session, sessionId, ts } = await this.openSession(known, holder, deadline);
      const request =
        action === 'position'
          ? runnerPosition(known, sessionId, ts, position)
          : action === 'heaterOn'
            ? heaterOn(known, sessionId, ts, { minutes, maxMinutes: HEATER_MINUTES.max })
            : plugOn(known, sessionId, ts);
      await session
        .exchange(seal(request), {
          // The answer within the ack budget (200 ms at least).
          timeoutMs: Math.min(TIMINGS.answer, Math.max(200, ackBy - 500 - this.monotonic())),
          beforeSend: () => {
            const mono = this.monotonic();
            if (entry.cancelled || holder.aborted) throw new Refusal(ERRORS.cancelled);
            if (!this.optionFor(action)) throw new Refusal(ERRORS.notSent);
            if (!this.identityFresh(mac, mono) || mono >= deadline) {
              throw new Refusal(ERRORS.notSent);
            }
            at = mono;
            // The newest wish of the user leaves: it lifts the stop of the device.
            if (this.stops.delete(mac)) this.saveLater();
          },
        })
        .then((answer) => {
          const lenient = MODELS[known.model].family === 1;
          if (!commandAnswered(answer, { lenient })) {
            throw new SessionError('protocol', { sent: true });
          }
          this.noteCrc(mac, answer);
        });
    } catch (err) {
      if (at === undefined) {
        if (err instanceof Refusal) {
          if (entry.cancelled) return undefined;
          throw err;
        }
        return undefined;
      }
      // Written but not answered: sent, without confirmation.
    } finally {
      rt.holder = undefined;
      // The lane is released once the socket is closed; the ack does not wait for it.
      const closing = this.endSession(holder).finally(release);
      if (at === undefined) await closing;
    }
    return at === undefined ? undefined : { at };
  }

  expectation(action, { position, minutes, before, sentMono }) {
    if (action === 'position') {
      return {
        sentMono,
        before: before?.position,
        check: (s) => s.direction === 'stop' && Math.abs(s.position - position) <= 2,
        value: (s) => s.position,
      };
    }
    return {
      sentMono,
      before: before?.power,
      check:
        action === 'heaterOn'
          ? (s) => s.power === 1 && s.timeLeft > 0 && s.timeLeft <= minutes * 60 + 5
          : (s) => s.power === 1,
      value: (s) => s.power,
    };
  }

  checkExpect(mac, state, started) {
    const rt = this.runtime(mac);
    const expect = rt.expect;
    if (!expect || started <= expect.sentMono) return;
    const quick = started - expect.sentMono < TIMINGS.followUps[0] - 500;
    // Equal to the state before, right after: not applied yet (the follow-ups decide).
    if (expect.check(state) && !(quick && expect.value(state) === expect.before)) {
      rt.expect = undefined;
      rt.badge = undefined;
    }
  }

  /** Reads 5 s and 20 s after a write (the only reads sooner than the interval). */
  followUp(mac) {
    const rt = this.runtime(mac);
    for (const t of rt.followTimers) this.timers.clearTimeout(t);
    rt.followTimers.clear();
    for (const delay of TIMINGS.followUps) {
      const timer = this.timers.setTimeout(() => {
        rt.followTimers.delete(timer);
        this.read(mac).catch(() => {});
      }, delay);
      rt.followTimers.add(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // Status and badges
  // ---------------------------------------------------------------------------

  namesOf(macs) {
    return macs.map((mac) => (this.known.get(mac) ? nameOf(this.known.get(mac)) : mac));
  }

  statusText() {
    const parts = [];
    let connected = false;
    if (this.configError !== undefined) parts.push(T.configUnread(age(this.configError)));
    if (this.memoryState === 'unreadable') parts.push(T.dataUnreadable);
    else if (!this.dataWritable) parts.push(T.dataUnwritable);
    if (this.scanState === 'unavailable') parts.push(T.scanUnavailable);
    else if (this.scanState === 'failed') parts.push(T.scanFailed);
    const supported = [...this.known.values()].filter((k) => SUPPORTED_KINDS.includes(kindOf(k)));
    if (supported.length === 0) {
      if (this.scanState !== 'unavailable') parts.push(T.noDevice);
    } else {
      const mono = this.monotonic();
      const read = supported.filter((k) => this.rt.get(k.mac)?.ok === true);
      connected = read.length > 0;
      parts.push(T.summary(read.length, supported.length));
      const failing = supported.filter((k) => this.rt.get(k.mac)?.ok === false).map((k) => k.mac);
      if (failing.length) parts.push(T.failing(this.namesOf(failing)));
      const stale = supported
        .filter((k) => this.rt.get(k.mac)?.seenAt !== undefined && !this.identityFresh(k.mac, mono))
        .map((k) => k.mac);
      if (stale.length) parts.push(T.unconfirmed(this.namesOf(stale)));
    }
    const waiting = [];
    const unanswered = [];
    const sent = [];
    const contradicted = [];
    for (const stop of this.stops.values()) {
      if (!stop.sent) waiting.push(stop.mac);
      else if (stop.answered === false) unanswered.push(stop.mac);
      else if (stop.sends >= LIMITS.stopSends) contradicted.push(stop.mac);
      else sent.push(stop.mac);
    }
    if (waiting.length) parts.push(T.stopsWaiting(this.namesOf(waiting)));
    if (unanswered.length) parts.push(T.stopsUnanswered(this.namesOf(unanswered)));
    if (sent.length) parts.push(T.stopsUnconfirmed(this.namesOf(sent)));
    if (contradicted.length) parts.push(T.stopsContradicted(this.namesOf(contradicted)));
    if (this.tokenModels.size) parts.push(T.tokenModels([...this.tokenModels.values()]));
    if (this.crcRefused.size) parts.push(T.crcRefused([...this.crcRefused.values()]));
    const crc = [...this.rt].filter(([mac, rt]) => rt.crcMismatch && this.known.has(mac));
    if (crc.length) parts.push(T.crcDiffers(this.namesOf(crc.map(([mac]) => mac))));
    const text = parts.length ? join(...parts) : both('', '');
    const cut = (s) =>
      s.length > LIMITS.statusLength ? `${s.slice(0, LIMITS.statusLength - 1)}…` : s;
    return { connected, text: both(cut(text.en), cut(text.fr)) };
  }

  updateStatus() {
    if (this.stopped) return;
    const { connected, text } = this.statusText();
    const key = JSON.stringify([connected, text]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    Promise.resolve()
      .then(() => this.gladys.setConnectionStatus(connected, text))
      .catch((err) => {
        this.lastStatus = undefined;
        this.logger.warn(`Setting the status failed: ${err.message}`);
      });
  }

  badgeOf(mac) {
    const rt = this.rt.get(mac);
    const stop = this.stops.get(mac);
    if (stop) {
      if (!stop.sent)
        return { transport: 'unreachable', message: stop.reason ?? BADGE.stopWaiting };
      return {
        transport: DEVICE_TRANSPORTS?.LOCAL ?? 'local',
        degraded: true,
        message:
          stop.reason ??
          (stop.answered === false
            ? BADGE.stopUnanswered
            : stop.sends >= LIMITS.stopSends
              ? BADGE.stopContradicted
              : BADGE.stopSent),
      };
    }
    if (rt?.ok === false) return { transport: 'unreachable', message: BADGE.unreachable };
    if (rt?.seenAt !== undefined && !this.identityFresh(mac)) {
      return { transport: 'local', degraded: true, message: BADGE.unconfirmed };
    }
    if (rt?.badge) return { transport: 'local', degraded: true, message: rt.badge };
    if (rt?.crcMismatch) return { transport: 'local', degraded: true, message: BADGE.crc };
    return { transport: 'local' };
  }

  /** The transport badges of the devices created in Gladys, when they change. */
  publishBadges() {
    if (this.stopped) return;
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    const list = [];
    for (const mac of this.known.keys()) {
      const external_id = deviceIds(this.gladys, mac).device;
      if (!created.has(external_id)) continue;
      const badge = { external_id, ...this.badgeOf(mac) };
      const key = JSON.stringify(badge);
      if (this.lastTransports.get(external_id) === key) continue;
      this.lastTransports.set(external_id, key);
      list.push(badge);
    }
    if (list.length === 0) return;
    Promise.resolve()
      .then(() => this.gladys.publishTransports(list.slice(0, 100)))
      .catch((err) => {
        for (const b of list) this.lastTransports.delete(b.external_id);
        this.logger.warn(`Publishing the badges failed: ${err.message}`);
      });
  }
}
