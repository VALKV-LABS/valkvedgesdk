// Tests of the client against a running service. They create a database,
// use it and delete it.
//
//   EDGEKV_URL          the data API, e.g. https://api.example.com
//   EDGEKV_CONTROL_URL  where databases are managed, e.g. https://cp.example.com
//   EDGEKV_API_KEY      a key that may manage databases
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { EdgeKV, EdgeKVError, type DatabaseInfo } from '../src/index.js';

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the integration tests`);
  return value;
};

const kv = new EdgeKV({ apiKey: env('EDGEKV_API_KEY'), url: env('EDGEKV_URL'), controlUrl: env('EDGEKV_CONTROL_URL') });
const name = `sdk-ts-${Date.now()}`;
let info: DatabaseInfo;
const db = kv.database(name);
const text = (bytes: Uint8Array | null) => (bytes === null ? null : new TextDecoder().decode(bytes));

/** Retries until `attempt` stops throwing `code`, for things the service applies within seconds. */
async function eventually<T>(code: string, attempt: () => Promise<T>, seconds = 30): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof EdgeKVError) || error.code !== code || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

before(async () => {
  const regions = await kv.regions();
  assert.ok(regions.length > 0, 'the service offers at least one region');
  info = await kv.databases.create({ name, region: regions[0]! });
  assert.equal(info.name, name);
  assert.equal(info.status, 'active');
  // A new database is usable on the data API a moment after it is created.
  await eventually('NOT_FOUND', () => db.put('warm-up', 'x'));
  await db.delete('warm-up');
});

after(async () => {
  if (info) await kv.databases.delete(info.id).catch(() => {});
});

test('the new database is listed and can be read back', async () => {
  const names = [];
  for await (const database of kv.databases.list()) names.push(database.name);
  assert.ok(names.includes(name));
  const read = await kv.databases.get(info.id);
  assert.equal(read.id, info.id);
  assert.equal(typeof read.storedBytes, 'number');
  assert.ok(Array.isArray(await kv.databases.usage(info.id)));
});

test('a name that is taken, or not a valid name, is refused with its own code', async () => {
  await assert.rejects(kv.databases.create({ name, region: info.region }), { code: 'NAME_CONFLICT' });
  await assert.rejects(kv.databases.create({ name: 'Not Valid', region: info.region }), { code: 'INVALID_NAME' });
  await assert.rejects(kv.databases.create({ name: 'fine-name', region: 'nowhere-1' }), { code: 'REGION_UNAVAILABLE' });
});

test('put, get and delete, as bytes, text and JSON', async () => {
  const first = await db.put('greeting', 'hello');
  assert.ok(first.lsn > 0);
  assert.equal(await db.getText('greeting'), 'hello');

  const bytes = new Uint8Array([0, 1, 2, 254, 255]);
  const second = await db.put('blob', bytes);
  assert.ok(second.lsn > first.lsn, 'later writes have higher positions');
  assert.deepEqual(await db.get('blob'), bytes);

  await db.putJson('settings', { theme: 'dark', sizes: [1, 2] });
  assert.deepEqual(await db.getJson('settings'), { theme: 'dark', sizes: [1, 2] });

  await db.delete('greeting');
  assert.equal(await db.get('greeting'), null);
  // Deleting what is not there is fine.
  await db.delete('never-existed');
});

test('keys with slashes, spaces and non-ASCII characters round-trip', async () => {
  for (const key of ['users/42/name', 'with space', 'query?and#hash', 'naïve/日本語', 'percent%20literal']) {
    await db.put(key, `value of ${key}`);
    assert.equal(await db.getText(key), `value of ${key}`, key);
  }
});

test('a commit is all or nothing, and reaches keys that are not text', async () => {
  const binaryKey = new Uint8Array([0xff, 0x00, 0x01]);
  await db.put('batch/old', 'to be removed');
  await db.commit([
    { op: 'put', key: 'batch/a', value: '1' },
    { op: 'put', key: 'batch/b', value: '2' },
    { op: 'delete', key: 'batch/old' },
    { op: 'put', key: binaryKey, value: 'binary key' },
  ]);
  assert.equal(await db.getText('batch/a'), '1');
  assert.equal(await db.getText('batch/b'), '2');
  assert.equal(await db.get('batch/old'), null);
  // The binary key is there too: it comes back from a scan with its bytes.
  const found = [];
  for await (const entry of db.scan()) {
    if (entry.keyBytes.length === 3 && entry.keyBytes[0] === 0xff) found.push(text(entry.value));
  }
  assert.deepEqual(found, ['binary key']);
});

test('scan returns a prefix in key order, across pages', async () => {
  const operations = [];
  for (let i = 0; i < 25; i += 1) {
    operations.push({ op: 'put' as const, key: `scan/${String(i).padStart(2, '0')}`, value: `v${i}` });
  }
  await db.commit(operations);
  await db.put('scanother/x', 'outside the prefix');

  const keys = [];
  for await (const entry of db.scan({ prefix: 'scan/', pageSize: 10 })) keys.push(entry.key);
  assert.equal(keys.length, 25);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(keys[0], 'scan/00');

  const page = await db.scanPage({ prefix: 'scan/', pageSize: 10 });
  assert.equal(page.items.length, 10);
  assert.equal(typeof page.nextPageToken, 'string');
  assert.equal(text(page.items[3]!.value), 'v3');
  await assert.rejects(db.scanPage({ pageSize: 1000 }), { code: 'BAD_REQUEST' });
});

test('waitForChange returns when another writer writes, and on its timeout otherwise', async () => {
  const { lsn } = await db.head();
  const started = Date.now();
  const idle = await db.waitForChange(lsn, 600);
  assert.equal(idle.lsn, lsn);
  assert.ok(Date.now() - started >= 500, 'it waited');

  const waiting = db.waitForChange(lsn, 20_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const written = await db.put('wake', 'up');
  const woke = await waiting;
  assert.equal(woke.lsn, written.lsn);
});

test('a database that does not exist, and a key that is wrong, are told apart', async () => {
  await assert.rejects(kv.database('no-such-database').get('k'), { code: 'NOT_FOUND', status: 404 });
  const stranger = new EdgeKV({ apiKey: 'ekv_this-key-was-never-issued-000000', url: env('EDGEKV_URL'), controlUrl: env('EDGEKV_CONTROL_URL') });
  await assert.rejects(stranger.database(name).get('k'), { code: 'UNAUTHENTICATED', status: 401 });
  await assert.rejects(stranger.regions(), { code: 'UNAUTHENTICATED' });
});

test('a deleted database stops being served', async () => {
  const doomed = await kv.databases.create({ name: `${name}-gone`, region: info.region });
  const gone = kv.database(doomed.name);
  await eventually('NOT_FOUND', () => gone.put('k', 'v'));
  await kv.databases.delete(doomed.id);
  // The data API stops serving it within seconds.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const result = await gone.get('k').then(
      () => 'served',
      (error: EdgeKVError) => error.code,
    );
    if (result === 'NOT_FOUND') break;
    assert.ok(Date.now() < deadline, `still ${result} 30 s after the delete`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
});
