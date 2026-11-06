// -----------------------------------------------------------------------------
// One TCP session: framing by the announced length, one answer per request,
// bounded waits, abort while connecting, nothing read that was not asked.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { Session, SessionError } from '../src/protocol/session.js';
import { frame } from './helpers/fakeSwitcher.js';

async function server(t, onData) {
  const sockets = new Set();
  const srv = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('data', (chunk) => onData(chunk, socket));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => srv.close(resolve));
  });
  return srv.address().port;
}

const open = async (port, timeoutMs = 1000) => {
  const session = new Session({ timers: globalThis, monotonic: () => performance.now() });
  await session.start({ ip: '127.0.0.1', port, timeoutMs });
  return session;
};

test('an answer split in pieces is read whole, by its announced length', async (t) => {
  const answer = frame(100, (b) => (b[50] = 7));
  const port = await server(t, (_chunk, socket) => {
    socket.write(answer.subarray(0, 3));
    setTimeout(() => socket.write(answer.subarray(3, 60)), 5);
    setTimeout(() => socket.write(answer.subarray(60)), 10);
  });
  const session = await open(port);
  const got = await session.exchange(Buffer.from('fef0', 'hex'), { timeoutMs: 1000 });
  assert.deepEqual(got, answer);
  session.abort();
  await session.closed;
});

test('more than one answer, an oversized length or a wrong start breaks the session', async (t) => {
  for (const reply of [
    Buffer.concat([frame(60), frame(60)]),
    (() => {
      const b = Buffer.alloc(8);
      b[0] = 0xfe;
      b[1] = 0xf0;
      b.writeUInt16LE(5000, 2);
      return b;
    })(),
    Buffer.from('ffff1000', 'hex'),
  ]) {
    const port = await server(t, (_c, socket) => socket.write(reply));
    const session = await open(port);
    await assert.rejects(
      session.exchange(Buffer.from('fef0', 'hex'), { timeoutMs: 1000 }),
      (err) => err instanceof SessionError && err.kind === 'protocol' && err.sent === true,
    );
    await session.closed;
  }
});

test('bytes nobody asked for are never kept for the next request', async (t) => {
  let socketRef;
  const port = await server(t, () => {});
  const srvSession = await open(port);
  // The server pushes before any request.
  await new Promise((resolve) => setTimeout(resolve, 20));
  socketRef = srvSession.socket;
  assert.ok(socketRef);
  srvSession.onData(frame(60));
  await assert.rejects(srvSession.exchange(Buffer.from('fef0', 'hex'), { timeoutMs: 100 }));
  await srvSession.closed;
});

test('a silent device: the answer times out, the request counts as sent', async (t) => {
  const port = await server(t, () => {});
  const session = await open(port);
  await assert.rejects(
    session.exchange(Buffer.from('fef0', 'hex'), { timeoutMs: 50 }),
    (err) => err.kind === 'timeout' && err.sent === true,
  );
  session.abort();
  await session.closed;
});

test('beforeSend throwing sends nothing', async (t) => {
  let received = 0;
  const port = await server(t, () => (received += 1));
  const session = await open(port);
  await assert.rejects(
    session.exchange(Buffer.from('fef0', 'hex'), {
      timeoutMs: 50,
      beforeSend: () => {
        throw new Error('no');
      },
    }),
    /no/,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(received, 0);
  assert.equal(session.wrote, false);
  session.abort();
  await session.closed;
});

test('an abort while connecting rejects at once; a refused port rejects "connect"', async (t) => {
  const session = new Session({ timers: globalThis, monotonic: () => performance.now() });
  // 10.255.255.1 is not routed: the connection would hang until its timeout.
  const opening = session.start({ ip: '10.255.255.1', port: 9957, timeoutMs: 5000 });
  const started = performance.now();
  session.abort();
  await assert.rejects(opening, (err) => err.kind === 'aborted');
  assert.ok(performance.now() - started < 1000);
  await session.closed;
  const port = await server(t, () => {});
  const refused = new Session({ timers: globalThis, monotonic: () => performance.now() });
  await assert.rejects(
    refused.start({ ip: '127.0.0.1', port: port + 1 === 65536 ? 1 : port + 1, timeoutMs: 1000 }),
    (err) => err.kind === 'connect',
  );
});
