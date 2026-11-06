// -----------------------------------------------------------------------------
// /data: a plain file only, bounded, written atomically; read back repaired.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyMemory, fileStore, normalizeMemory, serializeMemory } from '../src/store.js';

async function dir(t) {
  const path = await mkdtemp(join(tmpdir(), 'switcher-store-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

const DEVICE = { mac: '0a0000000001', id: 'a1b2c3', model: '0317', key: '18', ip: '192.168.1.20' };

test('saved then loaded: the same memory, file readable by its owner only', async (t) => {
  const path = join(await dir(t), 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  const memory = {
    ...emptyMemory(),
    attemptAt: 1000,
    devices: [DEVICE],
    stops: [{ mac: DEVICE.mac, sent: true, sends: 2, clickedAt: 900 }],
    runs: [{ mac: DEVICE.mac, minutes: 60, startedAt: 800 }],
  };
  await store.save(serializeMemory(memory));
  const loaded = normalizeMemory(await store.load(), 5000);
  assert.deepEqual(serializeMemory(loaded), serializeMemory(memory));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('a FIFO or a huge file is refused, never read nor waited for', async (t) => {
  const base = await dir(t);
  const fifo = join(base, 'fifo.json');
  if (spawnSync('mkfifo', [fifo]).status === 0) {
    await assert.rejects(fileStore(fifo).load(), (err) => err.code === 'ESPECIAL');
  }
  const big = join(base, 'big.json');
  await writeFile(big, 'x'.repeat(70 * 1024));
  await assert.rejects(fileStore(big).load(), (err) => err.code === 'EFBIG');
  const bad = join(base, 'bad.json');
  await writeFile(bad, '{"not json');
  await assert.rejects(fileStore(bad).load());
  assert.equal(await readFile(bad, 'utf8'), '{"not json', 'never overwritten by a load');
});

test('read back repaired: odd entries dropped, future dates now, counts kept or 0', () => {
  const raw = JSON.parse(
    JSON.stringify({
      attemptAt: 9e15,
      devices: [
        DEVICE,
        DEVICE,
        { ...DEVICE, mac: '0b0000000001' },
        { ...DEVICE, mac: '0a0000000002', model: '9999' },
        { ...DEVICE, mac: '0a0000000003', id: 'zz' },
        { ...DEVICE, mac: '0a0000000004', ip: '1.2.3' },
        { ...DEVICE, mac: '0a0000000005', name: 'x\u0007' },
      ],
      stops: [
        { mac: DEVICE.mac, sent: 'yes', sends: 'many', clickedAt: 9e15 },
        { mac: DEVICE.mac, sent: true, sends: 1 },
        { mac: 'nope' },
      ],
      runs: [
        { mac: DEVICE.mac, minutes: 600, startedAt: 1 },
        { mac: '0a0000000004', minutes: 60, startedAt: 9e15 },
      ],
      __proto__: { polluted: true },
    }),
  );
  const m = normalizeMemory(raw, 5000);
  assert.equal(m.attemptAt, 5000);
  assert.deepEqual(
    m.devices.map((d) => d.mac),
    ['0a0000000001', '0a0000000004', '0a0000000005'],
  );
  assert.equal(m.devices[1].ip, undefined);
  assert.equal(m.devices[2].name, undefined);
  assert.deepEqual(m.stops, [{ mac: DEVICE.mac, sent: false, sends: 0, clickedAt: 5000 }]);
  assert.deepEqual(m.runs, [{ mac: '0a0000000004', minutes: 60, startedAt: 5000 }]);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(normalizeMemory(null, 1), emptyMemory());
  assert.deepEqual(normalizeMemory([1, 2], 1), emptyMemory());
});
