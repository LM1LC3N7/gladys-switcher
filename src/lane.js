// -----------------------------------------------------------------------------
// The lane of one device: one session at a time to it (a new connection only
// once the previous one is closed), served by priority (stops, then commands,
// then reads), in order of arrival within a priority. A waiter gives up at its
// deadline (it never got the lane: nothing was sent).
// -----------------------------------------------------------------------------

export const PRIORITY = { STOP: 0, COMMAND: 1, READ: 2 };

export class LaneTimeout extends Error {
  constructor() {
    super('lane wait over');
    this.name = 'LaneTimeout';
  }
}

export class Lane {
  constructor({ timers = globalThis } = {}) {
    this.timers = timers;
    this.queues = [[], [], []];
    this.held = false;
    /** The priority of the holder, while held. */
    this.holder = undefined;
  }

  waiting(priority) {
    return this.queues[priority].length;
  }

  /** Resolves a release function; rejects LaneTimeout after `waitMs` (when given). */
  acquire(priority, { waitMs } = {}) {
    return new Promise((resolve, reject) => {
      const waiter = { priority, resolve, reject, timer: undefined };
      if (waitMs !== undefined) {
        if (!(waitMs > 0) && this.held) {
          reject(new LaneTimeout());
          return;
        }
        if (this.held) {
          waiter.timer = this.timers.setTimeout(() => {
            const queue = this.queues[priority];
            const at = queue.indexOf(waiter);
            if (at >= 0) {
              queue.splice(at, 1);
              reject(new LaneTimeout());
            }
          }, waitMs);
        }
      }
      this.queues[priority].push(waiter);
      this.next();
    });
  }

  next() {
    if (this.held) {
      return;
    }
    for (const queue of this.queues) {
      const waiter = queue.shift();
      if (waiter) {
        this.timers.clearTimeout(waiter.timer);
        this.held = true;
        this.holder = waiter.priority;
        let released = false;
        waiter.resolve(() => {
          if (released) return;
          released = true;
          this.held = false;
          this.holder = undefined;
          this.next();
        });
        return;
      }
    }
  }
}
