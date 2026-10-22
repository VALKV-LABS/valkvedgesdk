// Tests of the local mode against the native library, on local disk only.
// Needs the library built for this machine: set EDGEKV_NATIVE_PATH to the
// .node file, or install the platform package. `make native-test` does both.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { EdgeKVError, LocalEdgeKV, type ChangeEvent } from '../src/index.js';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), 'edgekv-local-'));
  dirs.push(dir);
  return dir;
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof EdgeKVError, `expected an EdgeKVError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('puts, gets and deletes', async () => {
  const kv = await LocalEdgeKV.open({ path: fresh() });
  const db = await kv.database('orders');
  assert.equal(db.name, 'orders');

  assert.equal(await db.get('order/1'), null);
  await db.put('order/1', 'one');
  await db.putJson('order/2', { total: 42 });
  await db.put(new Uint8Array([0xff, 0x00]), new Uint8Array([1, 2, 3]));

  assert.equal(await db.getText('order/1'), 'one');
  assert.deepEqual(await db.getJson('order/2'), { total: 42 });
  assert.deepEqual(await db.get(new Uint8Array([0xff, 0x00])), new Uint8Array([1, 2, 3]));

  await db.delete('order/1');
  await db.delete('never-there');
  assert.equal(await db.get('order/1'), null);
  await kv.close();
});

test('a commit applies every operation', async () => {
  const kv = await LocalEdgeKV.open({ path: fresh() });
  const db = await kv.database('stock');
  await db.put('cart/77', 'x');
  await db.commit([
    { op: 'put', key: 'stock/widget', value: '9' },
    { op: 'put', key: 'order/3', value: 'widget' },
    { op: 'delete', key: 'cart/77' },
  ]);
  assert.equal(await db.getText('stock/widget'), '9');
  assert.equal(await db.getText('order/3'), 'widget');
  assert.equal(await db.get('cart/77'), null);
  await rejectsWith(db.commit([]), 'BAD_REQUEST');
  await kv.close();
});

test('scans in key order, a page at a time', async () => {
  const kv = await LocalEdgeKV.open({ path: fresh() });
  const db = await kv.database('scan');
  const keys = Array.from({ length: 25 }, (_, i) => `item/${String(i).padStart(2, '0')}`);
  await db.commit([...keys].reverse().map((key) => ({ op: 'put' as const, key, value: key.toUpperCase() })));
  await db.put('other/1', 'not in the prefix');

  const first = await db.scanPage({ prefix: 'item/', pageSize: 10 });
  assert.equal(first.items.length, 10);
  assert.equal(first.items[0]!.key, 'item/00');
  assert.ok(first.nextPageToken);

  const seen: string[] = [];
  for await (const entry of db.scan({ prefix: 'item/', pageSize: 7 })) {
    seen.push(entry.key);
    assert.equal(new TextDecoder().decode(entry.value), entry.key.toUpperCase());
  }
  assert.deepEqual(seen, keys);

  const all: string[] = [];
  for await (const entry of db.scan()) all.push(entry.key);
  assert.equal(all.length, 26);
  assert.equal(all.at(-1), 'other/1');
  await kv.close();
});

test('data is still there after reopening', async () => {
  const path = fresh();
  let kv = await LocalEdgeKV.open({ path });
  await (await kv.database('keep')).put('k', 'v', { durability: 'buffered' });
  await kv.close();

  kv = await LocalEdgeKV.open({ path });
  assert.equal(await (await kv.database('keep')).getText('k'), 'v');
  const status = (await kv.database('keep')).status();
  assert.ok(status.diskBytes > 0);
  await kv.close();
});

test('encrypted values need the key', async () => {
  const path = fresh();
  const key = crypto.getRandomValues(new Uint8Array(32));
  let kv = await LocalEdgeKV.open({ path });
  const db = await kv.database('vault', { encryptionKey: key });
  await db.put('secret', 'hello');
  assert.equal(await db.getText('secret'), 'hello');
  await rejectsWith(kv.database('vault', { encryptionKey: new Uint8Array(32) }), 'INVALID_ENCRYPTION_KEY');
  await kv.close();

  kv = await LocalEdgeKV.open({ path });
  await rejectsWith(kv.database('vault'), 'INVALID_ENCRYPTION_KEY');
  await kv.close();

  // A fresh directory handle: the library remembers the key of a failed open
  // for as long as the handle lives.
  kv = await LocalEdgeKV.open({ path });
  assert.equal(await (await kv.database('vault', { encryptionKey: key })).getText('secret'), 'hello');
  await kv.close();
});

test('a value with a lifetime reports when it expires, and reads as not there once it has', async () => {
  const kv = await LocalEdgeKV.open({ path: fresh() });
  const db = await kv.database('sessions');
  const before = Date.now();
  await db.put('session/1', 'alive', { ttlSeconds: 3600 });
  await db.putJson('session/2', { user: 7 }, { expiresAt: new Date(Date.now() + 60_000) });
  await db.commit([{ op: 'put', key: 'session/3', value: 'gone', expiresAt: new Date(Date.now() - 1000).toISOString() }]);
  await db.put('forever', 'kept');

  const one = await db.getVersioned('session/1');
  assert.equal(new TextDecoder().decode(one!.value), 'alive');
  const at = one!.expiresAt!.getTime();
  assert.ok(at >= before + 3_600_000 && at <= Date.now() + 3_600_000, `expires at ${one!.expiresAt!.toISOString()}`);
  assert.deepEqual(await db.getJson('session/2'), { user: 7 });
  assert.equal(await db.get('session/3'), null, 'already expired');
  assert.equal((await db.getVersioned('forever'))!.expiresAt, undefined);

  const scanned = [];
  for await (const entry of db.scan()) scanned.push([entry.key, entry.expiresAt !== undefined]);
  assert.deepEqual(scanned, [['forever', false], ['session/1', true], ['session/2', true]]);

  // Writing the key again replaces the expiry.
  await db.put('session/1', 'kept now');
  assert.equal((await db.getVersioned('session/1'))!.expiresAt, undefined);

  await rejectsWith(db.put('k', 'v', { ttlSeconds: 0 }), 'BAD_REQUEST');
  await rejectsWith(db.put('k', 'v', { ttlSeconds: 1.5 }), 'BAD_REQUEST');
  await rejectsWith(db.put('k', 'v', { ttlSeconds: 60, expiresAt: new Date() }), 'BAD_REQUEST');
  await rejectsWith(db.put('k', 'v', { expiresAt: 'tomorrow' }), 'BAD_REQUEST');
  await kv.close();
});

test('a new encrypted database gets a recovery key, and keys can be added and removed', async () => {
  const path = fresh();
  const key = crypto.getRandomValues(new Uint8Array(32));
  let kv = await LocalEdgeKV.open({ path });
  const db = await kv.database('vault', { encryptionKey: key });
  await db.put('secret', 'hello');
  const recovery = db.takeRecoveryKey();
  assert.match(recovery!, /^[0-9a-f]{64}$/);
  assert.equal(db.takeRecoveryKey(), null, 'given out once');
  const [first, second] = await db.keyIds();
  assert.equal((await db.keyIds()).length, 2);

  const added = crypto.getRandomValues(new Uint8Array(32));
  const addedId = await db.addKey(added);
  assert.equal(await db.addKey(added), addedId, 'adding a key again changes nothing');
  assert.deepEqual(await db.keyIds(), [first, second, addedId]);
  const spare = await db.addRecoveryKey();
  assert.match(spare, /^[0-9a-f]{64}$/);
  await rejectsWith(db.addKey(new Uint8Array(16)), 'BAD_REQUEST');
  await rejectsWith(db.removeKey('0000000000000000'), 'NOT_FOUND');
  await db.removeKey(first!);
  await kv.close();

  // A fresh directory handle for each open, as the library remembers a key.
  for (const opener of [recovery!, added, spare]) {
    kv = await LocalEdgeKV.open({ path });
    assert.equal(await (await kv.database('vault', { encryptionKey: opener })).getText('secret'), 'hello');
    await kv.close();
  }
  kv = await LocalEdgeKV.open({ path });
  await rejectsWith(kv.database('vault', { encryptionKey: key }), 'INVALID_ENCRYPTION_KEY');
  await kv.close();

  kv = await LocalEdgeKV.open({ path });
  const reopened = await kv.database('vault', { encryptionKey: added });
  assert.equal(reopened.takeRecoveryKey(), null, 'only the process that encrypted it has one');
  for (const id of await reopened.keyIds()) if (id !== addedId) await reopened.removeKey(id);
  await rejectsWith(reopened.removeKey(addedId), 'UNSUPPORTED');
  const plain = await kv.database('plain');
  assert.equal(plain.takeRecoveryKey(), null);
  await rejectsWith(plain.keyIds(), 'UNSUPPORTED');
  await kv.close();
});

test('a partial copy needs a service to follow', async () => {
  const kv = await LocalEdgeKV.open({ path: fresh() });
  await rejectsWith(kv.database('team', { prefixes: ['team/a/'] }), 'UNSUPPORTED');
  await kv.close();
});

test('databases in a namespace are separate', async () => {
  const kv = await LocalEdgeKV.open({ path: fresh() });
  await (await kv.database('acme/orders')).put('k', 'acme');
  await (await kv.database('orders')).put('k', 'plain');
  assert.equal(await (await kv.database('acme/orders')).getText('k'), 'acme');
  assert.equal(await (await kv.database('orders')).getText('k'), 'plain');
  await kv.close();
});

test('failures carry the library code', async () => {
  const kv = await LocalEdgeKV.open({ path: fresh() });
  await rejectsWith(kv.database('Not A Name'), 'INVALID_NAME');
  await rejectsWith(kv.database('orders', { encryptionKey: new Uint8Array(16) }), 'BAD_REQUEST');
  const db = await kv.database('limits');
  await rejectsWith(db.put('k'.repeat(2000), 'v'), 'KEY_TOO_LARGE');
  await rejectsWith(db.put('k', new Uint8Array(1024 * 1024 + 1)), 'VALUE_TOO_LARGE');
  await rejectsWith(LocalEdgeKV.open({ path: fresh(), url: 'https://api.test' }), 'BAD_REQUEST');
  await rejectsWith(LocalEdgeKV.open({ path: fresh(), url: 'https://api.test', apiKey: 'nope' }), 'BAD_REQUEST');
  await kv.close();
});

test('writes report versions, and a stale version or an existing key fails the write', async () => {
  const kv = await LocalEdgeKV.open({ path: fresh() });
  const db = await kv.database('shop');
  const first = await db.put('stock/1', '10');
  assert.equal(first.versions.length, 1);
  const read = await db.getVersioned('stock/1');
  assert.deepEqual(read, { value: new TextEncoder().encode('10'), version: first.versions[0] });
  assert.equal(await db.getVersioned('stock/none'), null);

  const second = await db.put('stock/1', '9', { ifVersion: read!.version });
  assert.notEqual(second.versions[0], read!.version);
  // Someone holding the first version now loses, and nothing is written.
  await rejectsWith(db.put('stock/1', '8', { ifVersion: read!.version }), 'CONDITION_FAILED');
  await rejectsWith(db.delete('stock/1', { ifVersion: read!.version }), 'CONDITION_FAILED');
  assert.equal(await db.getText('stock/1'), '9');

  await rejectsWith(db.put('stock/1', 'new', { ifAbsent: true }), 'CONDITION_FAILED');
  await db.put('stock/2', 'new', { ifAbsent: true });

  // A commit with a failed condition writes none of its operations.
  await rejectsWith(
    db.commit([{ op: 'put', key: 'order/1', value: 'x' }, { op: 'put', key: 'stock/1', value: '7' }], {
      conditions: [{ key: 'stock/1', version: read!.version }],
    }),
    'CONDITION_FAILED',
  );
  assert.equal(await db.get('order/1'), null);
  const ok = await db.commit([{ op: 'put', key: 'order/1', value: 'x' }, { op: 'delete', key: 'stock/2' }], {
    conditions: [{ key: 'stock/1', version: second.versions[0]! }, { key: 'order/1', version: null }],
  });
  assert.equal(ok.versions.length, 2);

  // Without a service the local copy is the database, so even a buffered write is checked.
  // (Following a service, a buffered write cannot carry a condition: UNSUPPORTED.)
  await rejectsWith(db.put('stock/1', '1', { durability: 'buffered', ifVersion: read!.version }), 'CONDITION_FAILED');
  await rejectsWith(db.put('stock/1', '1', { ifVersion: 'not a version' }), 'INVALID_ARGUMENT');
  await kv.close();
});

test('update loses no increments when many run at once', async () => {
  const kv = await LocalEdgeKV.open({ path: fresh() });
  const db = await kv.database('counters');
  const increment = (current: Uint8Array | null) => String(Number(current ? new TextDecoder().decode(current) : '0') + 1);
  await Promise.all(Array.from({ length: 10 }, () => db.update('hits', increment)));
  assert.equal(await db.getText('hits'), '10');
  // Null deletes; null on nothing writes nothing.
  assert.ok(await db.update('hits', () => null));
  assert.equal(await db.get('hits'), null);
  assert.equal(await db.update('hits', () => null), null);
  await kv.close();
});

test('watch reports changes under its prefix until it is closed', async () => {
  const kv = await LocalEdgeKV.open({ path: fresh() });
  const db = await kv.database('feed');
  const watch = db.watch('post/');
  const events: ChangeEvent[] = [];
  const done = (async () => {
    for await (const event of watch) {
      events.push(event);
      if (events.length === 3) break;
    }
  })();
  await db.put('post/1', 'hello');
  await db.put('other/1', 'not watched');
  await db.put('post/2', 'there', { durability: 'buffered' });
  await db.delete('post/1');
  await done;
  assert.deepEqual(
    events.map((e) => (e.type === 'changed' ? [e.key, e.value && new TextDecoder().decode(e.value)] : ['reset'])),
    [['post/1', 'hello'], ['post/2', 'there'], ['post/1', null]],
  );

  // close() ends a watch that is waiting.
  const idle = db.watch();
  const pending = idle.next();
  idle.close();
  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.deepEqual(await idle.next(), { done: true, value: undefined });
  await kv.close();
});

test('tokens replace the API key, and are asked for by database name', async () => {
  await rejectsWith(LocalEdgeKV.open({ path: fresh(), tokens: async () => 't' }), 'BAD_REQUEST');
  await rejectsWith(
    LocalEdgeKV.open({ path: fresh(), url: 'https://api.test', apiKey: 'ekv_k', tokens: async () => 't' }),
    'BAD_REQUEST',
  );
  // Nothing listens here, so opening fails, but only after asking for a token.
  const asked: string[] = [];
  const kv = await LocalEdgeKV.open({
    path: fresh(),
    url: 'http://127.0.0.1:9',
    tokens: (database) => {
      asked.push(database);
      return 'eyJ.e30.x';
    },
  });
  await assert.rejects(kv.database('notes-user-1'));
  assert.deepEqual([...new Set(asked)], ['notes-user-1']);
  await kv.close();
});

test('ingesting needs a service, downloads nothing, and buffers writes while it is away', async () => {
  const local = await LocalEdgeKV.open({ path: fresh() });
  await rejectsWith(local.database('readings', { ingest: true }), 'UNSUPPORTED');
  await local.close();

  // Nothing listens here: an ordinary open would try to download, but
  // opening to ingest makes no request at all.
  const kv = await LocalEdgeKV.open({ path: fresh(), url: 'http://127.0.0.1:9', apiKey: 'ekv_test' });
  const db = await kv.database('readings', { ingest: true });
  assert.equal(db.ingest, true);
  const written = await db.put('temp/1', '20.5');
  assert.equal(written.lsn, null, 'buffered by default');
  assert.equal(db.status().outboxEntries, 1);
  // Reads go to the service, which cannot be reached; watching is not offered.
  await rejectsWith(db.get('temp/1'), 'UNAVAILABLE');
  assert.throws(() => db.watch(), { code: 'UNSUPPORTED' });
  await kv.close();
});
