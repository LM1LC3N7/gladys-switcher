// -----------------------------------------------------------------------------
// One TCP session to one device: a login, then one request at a time (never
// pipelined), each answer framed by the length it announces (at most 1 KB),
// read only while its own request waits for it: a byte that arrives with no
// request waiting breaks the session (it could be taken for the next answer).
// Every wait is bounded (connection, answer); `abort()` destroys the socket at
// once and `closed` resolves when it is closed (a new session to the device
// opens only then).
//
// Errors are SessionError { kind, sent }: `sent` is true once the bytes of the
// request were handed to the socket ("sent, no answer" is never "not sent").
// -----------------------------------------------------------------------------

import { createConnection } from 'node:net';
import { LIMITS } from '../constants.js';
import { announcedLength } from './frame.js';

export class SessionError extends Error {
  constructor(kind, { sent = false, cause } = {}) {
    super(kind);
    this.name = 'SessionError';
    /** 'connect' | 'timeout' | 'closed' | 'protocol' | 'aborted' | 'refused' */
    this.kind = kind;
    this.sent = sent;
    if (cause) this.cause = cause;
  }
}

export class Session {
  constructor({ timers, monotonic }) {
    this.timers = timers;
    this.monotonic = monotonic;
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
    this.waiter = undefined;
    this.broken = undefined;
    /** Monotonic time of the last byte received (or of the connection). */
    this.lastByteAt = monotonic();
    /** True once a request (any) was handed to the socket. */
    this.wrote = false;
    /** Resolves once the last request written left for the kernel. */
    this.flushed = Promise.resolve();
    this.closed = new Promise((resolve) => {
      this.markClosed = resolve;
    });
  }

  /**
   * Opens the connection; rejects SessionError('connect') within `timeoutMs`
   * ('aborted' when `abort()` came first). `connect` may be replaced by the
   * tests (same contract as net.createConnection).
   */
  start({ ip, port, timeoutMs, connect = createConnection }) {
    return new Promise((resolve, reject) => {
      if (this.broken) {
        this.markClosed();
        reject(new SessionError(this.broken.kind));
        return;
      }
      let settled = false;
      this.rejectStart = (kind) => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        reject(new SessionError(kind));
      };
      const timer = this.timers.setTimeout(() => {
        if (settled) return;
        settled = true;
        this.abort('connect');
        reject(new SessionError('connect'));
      }, timeoutMs);
      let socket;
      try {
        socket = connect({ host: ip, port });
      } catch (err) {
        this.timers.clearTimeout(timer);
        this.markClosed();
        reject(new SessionError('connect', { cause: err }));
        return;
      }
      this.socket = socket;
      socket.setNoDelay?.(true);
      socket.on('connect', () => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        this.lastByteAt = this.monotonic();
        resolve(this);
      });
      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('error', (err) => {
        if (!settled) {
          settled = true;
          this.timers.clearTimeout(timer);
          reject(new SessionError('connect', { cause: err }));
        }
        this.fail(new SessionError('closed', { cause: err }));
      });
      socket.on('close', () => {
        this.timers.clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new SessionError('connect'));
        }
        this.fail(new SessionError('closed'));
        this.markClosed();
      });
    });
  }

  onData(chunk) {
    this.lastByteAt = this.monotonic();
    if (!this.waiter) {
      // Nothing asked: never kept for the next request.
      this.fail(new SessionError('protocol'));
      this.abort('protocol');
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const length = announcedLength(this.buffer);
    if (this.buffer.length >= 2 && (this.buffer[0] !== 0xfe || this.buffer[1] !== 0xf0)) {
      this.failAndClose('protocol');
      return;
    }
    if (length !== undefined && (length < 12 || length > LIMITS.frame)) {
      this.failAndClose('protocol');
      return;
    }
    if (this.buffer.length > LIMITS.frame) {
      this.failAndClose('protocol');
      return;
    }
    if (length !== undefined && this.buffer.length >= length) {
      if (this.buffer.length > length) {
        // One request, one answer: anything more is not ours to read.
        this.failAndClose('protocol');
        return;
      }
      const frame = this.buffer;
      this.buffer = Buffer.alloc(0);
      const waiter = this.waiter;
      this.waiter = undefined;
      this.timers.clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
  }

  failAndClose(kind) {
    this.fail(new SessionError(kind, { sent: true }));
    this.abort(kind);
  }

  fail(err) {
    if (!this.broken) this.broken = err;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      this.timers.clearTimeout(waiter.timer);
      waiter.reject(new SessionError(err.kind, { sent: true, cause: err.cause }));
    }
  }

  /**
   * Writes one request and resolves its answer (a whole frame). `beforeSend()`
   * runs synchronously right before the write: throwing there sends nothing.
   * The answer waits `timeoutMs` at most.
   */
  exchange(bytes, { timeoutMs, beforeSend } = {}) {
    if (this.broken || !this.socket || this.socket.destroyed) {
      return Promise.reject(new SessionError(this.broken?.kind ?? 'closed'));
    }
    if (this.waiter) {
      return Promise.reject(new SessionError('protocol'));
    }
    try {
      beforeSend?.();
    } catch (err) {
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      this.waiter = {
        resolve,
        reject,
        timer: this.timers.setTimeout(() => {
          if (this.waiter?.resolve !== resolve) return;
          this.waiter = undefined;
          reject(new SessionError('timeout', { sent: true }));
        }, timeoutMs),
      };
      this.buffer = Buffer.alloc(0);
      this.wrote = true;
      // Resolved once the bytes left for the kernel: a session is never
      // destroyed over a request still in its buffer (src/app.js waits for it).
      this.flushed = new Promise((done) => this.socket.write(bytes, () => done()));
    });
  }

  /** Destroys the socket now (idempotent); `closed` resolves once it is closed. */
  abort(kind = 'aborted') {
    this.fail(new SessionError(kind));
    this.rejectStart?.(kind);
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    } else if (!this.socket) {
      this.markClosed();
    }
  }
}
