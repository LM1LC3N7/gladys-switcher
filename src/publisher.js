// -----------------------------------------------------------------------------
// What goes to Gladys, within its limit of 300 states per minute (a window on
// the monotonic clock, the places taken before the request leaves, so two
// flushes never pass it together): push() keeps the current value of a
// feature (the last one wins); unchanged values are skipped by
// publishChangedStates and sent again every 30 min. Whatever is left over
// (budget spent, Gladys unreachable) waits for the next flush, every second.
// -----------------------------------------------------------------------------

import { LIMITS, MINUTE, TIMINGS } from './constants.js';

export class StatePublisher {
  constructor({ gladys, logger, monotonic, timers = globalThis }) {
    this.gladys = gladys;
    this.logger = logger;
    this.monotonic = monotonic;
    this.timers = timers;
    /** featureId -> { state } */
    this.pending = new Map();
    this.window = [];
    this.timer = undefined;
    this.flushing = undefined;
  }

  start() {
    this.stop();
    this.timer = this.timers.setInterval(() => {
      this.flush().catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
    }, TIMINGS.flushInterval);
  }

  stop() {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  push(featureId, value) {
    this.pending.set(featureId, value);
  }

  /** Forgets what is pending for a deleted device and its features. */
  forget(deviceId) {
    for (const id of [...this.pending.keys()]) {
      if (id === deviceId || id.startsWith(`${deviceId}:`)) {
        this.pending.delete(id);
      }
    }
  }

  clear() {
    this.pending.clear();
  }

  flush() {
    if (!this.flushing) {
      this.flushing = this.send().finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  async send() {
    const mono = this.monotonic();
    this.window = this.window.filter((t) => mono - t < MINUTE);
    const room = Math.min(LIMITS.statesPerMinute - this.window.length, LIMITS.statesPerRequest);
    if (room <= 0 || this.pending.size === 0) {
      return;
    }
    const batch = [];
    for (const [featureId, value] of this.pending) {
      if (batch.length >= room) {
        break;
      }
      this.pending.delete(featureId);
      batch.push({ device_feature_external_id: featureId, ...value });
    }
    // The places are taken before the request: never more than 300 in a minute.
    for (let i = 0; i < batch.length; i += 1) {
      this.window.push(mono);
    }
    try {
      await this.gladys.publishChangedStates(batch, { heartbeat: TIMINGS.stateHeartbeat });
    } catch (err) {
      // Kept for the next round, unless a newer value arrived meanwhile.
      for (const { device_feature_external_id: id, ...value } of batch) {
        if (!this.pending.has(id)) {
          this.pending.set(id, value);
        }
      }
      throw err;
    }
  }
}
