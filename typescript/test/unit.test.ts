// Tests of the client against a stand-in for `fetch`. No network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EdgeKV, EdgeKVError } from '../src/index.js';

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
}

type Answer = { status?: number; json?: unknown; bytes?: Uint8Array; headers?: Record<string, string> } | Error;

/** A client whose requests are answered from a list, in order, and recorded. */
function client(answers: Answer[], options: { retries?: number; controlUrl?: string } = {}) {
  const seen: Seen[] = [];
  const fake = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    seen.push({
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers: init?.headers as Record<string, string>,
      body: init?.body as string | Uint8Array | undefined,
    });
    const answer = answers.shift();
    if (!answer) throw new Error('the test did not expect this request');
    if (answer instanceof Error) throw answer;
    const body = answer.bytes ?? (answer.json === undefined ? undefined : JSON.stringify(answer.json));
    return new Response(body as BodyInit | undefined, { status: answer.status ?? 200, headers: answer.headers });
  };
  const kv = new EdgeKV({
    apiKey: 'ekv_test_key',
    url: 'https://api.test/',
    controlUrl: options.controlUrl,
    retries: options.retries ?? 0,
    fetch: fake as typeof fetch,
  });
  return { kv, seen };
}

const failure = (status: number, code: string, message = 'no') => ({ status, json: { error: { code, message } } });
const b64 = (text: string) => Buffer.from(text).toString('base64');

test('every request carries the key, and goes to the database by name', async () => {
  const { kv, seen } = client([{ json: { lsn: 3 } }]);
  assert.deepEqual(await kv.database('orders').put('a', 'one'), { lsn: 3 });
  assert.equal(seen[0]!.method, 'PUT');
  assert.equal(seen[0]!.url.href, 'https://api.test/v1/db/orders/kv/a');
  assert.equal(seen[0]!.headers.authorization, 'Bearer ekv_test_key');
  assert.deepEqual(seen[0]!.body, new TextEncoder().encode('one'));
});

test('keys are escaped in the path, with their slashes kept', async () => {
  const { kv, seen } = client([{ bytes: new Uint8Array([1]) }]);
  await kv.database('orders').get('users/42/display name?');
  assert.equal(seen[0]!.url.pathname, '/v1/db/orders/kv/users/42/display%20name%3F');
  await assert.rejects(kv.database('orders').get(''), { code: 'BAD_REQUEST' });
});

test('get returns bytes, text or JSON, and null for a key that is not there', async () => {
  const stored = new TextEncoder().encode('{"n":1}');
  const { kv } = client([{ bytes: stored }, { bytes: stored }, { bytes: stored }, failure(404, 'KEY_NOT_FOUND'), failure(404, 'KEY_NOT_FOUND')]);
  const db = kv.database('orders');
  assert.deepEqual(await db.get('k'), stored);
  assert.equal(await db.getText('k'), '{"n":1}');
  assert.deepEqual(await db.getJson('k'), { n: 1 });
  assert.equal(await db.get('absent'), null);
  assert.equal(await db.getJson('absent'), null);
});

test('a missing database is an error, not a missing key', async () => {
  const { kv } = client([failure(404, 'NOT_FOUND', 'database not found')]);
  await assert.rejects(kv.database('nope').get('k'), (error: EdgeKVError) => {
    assert.equal(error.code, 'NOT_FOUND');
    assert.equal(error.status, 404);
    assert.equal(error.message, 'database not found');
    return true;
  });
});

test('commit sends keys and values base64-encoded, and bytes pass through unchanged', async () => {
  const { kv, seen } = client([{ json: { lsn: 9 } }]);
  const result = await kv.database('orders').commit([
    { op: 'put', key: 'a', value: 'one' },
    { op: 'put', key: new Uint8Array([0, 255]), value: new Uint8Array([1, 2, 3]) },
    { op: 'delete', key: 'b' },
  ]);
  assert.deepEqual(result, { lsn: 9 });
  assert.equal(seen[0]!.url.pathname, '/v1/db/orders/commit');
  assert.deepEqual(JSON.parse(seen[0]!.body as string), {
    ops: [
      { op: 'put', key: b64('a'), value: b64('one') },
      { op: 'put', key: 'AP8=', value: 'AQID' },
      { op: 'delete', key: b64('b') },
    ],
  });
  await assert.rejects(kv.database('orders').commit([]), { code: 'BAD_REQUEST' });
});

test('scan walks every page and decodes what it returns', async () => {
  const { kv, seen } = client([
    { json: { items: [{ key: b64('user/1'), value: b64('ann') }, { key: b64('user/2'), value: b64('bo') }], next_page_token: 'dG9rZW4=' } },
    { json: { items: [{ key: b64('user/3'), value: b64('cy') }], next_page_token: null } },
  ]);
  const found: [string, string][] = [];
  for await (const entry of kv.database('orders').scan({ prefix: 'user/', pageSize: 2 })) {
    found.push([entry.key, new TextDecoder().decode(entry.value)]);
  }
  assert.deepEqual(found, [['user/1', 'ann'], ['user/2', 'bo'], ['user/3', 'cy']]);
  assert.equal(seen[0]!.url.search, '?prefix=user%2F&limit=2');
  assert.equal(seen[1]!.url.searchParams.get('page_token'), 'dG9rZW4=');
});

test('waitForChange long-polls the head and caps the wait at 30 seconds', async () => {
  const { kv, seen } = client([{ json: { generation: 0, lsn: 8 } }, { json: { generation: 0, lsn: 7 } }]);
  assert.deepEqual(await kv.database('orders').waitForChange(7, 500), { generation: 0, lsn: 8 });
  assert.equal(seen[0]!.url.search, '?wait_after=7&timeout_ms=500');
  await kv.database('orders').waitForChange(7, 999_999);
  assert.equal(seen[1]!.url.searchParams.get('timeout_ms'), '30000');
});

test('a request the service did not carry out is tried again, and then succeeds', async () => {
  const { kv, seen } = client([failure(429, 'RATE_LIMITED'), failure(409, 'LEASE_HELD'), { json: { lsn: 4 } }], { retries: 3 });
  assert.deepEqual(await kv.database('orders').put('a', 'x'), { lsn: 4 });
  assert.equal(seen.length, 3);
});

test('retries stop at the limit and report the last failure', async () => {
  const { kv, seen } = client([failure(429, 'RATE_LIMITED'), failure(429, 'RATE_LIMITED')], { retries: 1 });
  await assert.rejects(kv.database('orders').put('a', 'x'), { code: 'RATE_LIMITED', status: 429 });
  assert.equal(seen.length, 2);
});

test('failures that trying again cannot fix are reported at once', async () => {
  for (const [status, code] of [[401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [403, 'STORAGE_QUOTA_EXCEEDED'], [403, 'ACCOUNT_SUSPENDED'], [413, 'VALUE_TOO_LARGE']] as const) {
    const { kv, seen } = client([failure(status, code)], { retries: 3 });
    await assert.rejects(kv.database('orders').put('a', 'x'), { code });
    assert.equal(seen.length, 1, code);
  }
});

test('a failure to connect is retried; a timeout is not, because the write may have happened', async () => {
  const refused = client([new TypeError('fetch failed'), { json: { lsn: 1 } }], { retries: 2 });
  assert.deepEqual(await refused.kv.database('orders').put('a', 'x'), { lsn: 1 });

  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  const slow = client([timeout, { json: { lsn: 1 } }], { retries: 2 });
  await assert.rejects(slow.kv.database('orders').put('a', 'x'), { code: 'TIMEOUT', status: 0 });
  assert.equal(slow.seen.length, 1);
});

test('an answer that is not from the service still becomes an error with a status', async () => {
  const { kv } = client([{ status: 502, bytes: new TextEncoder().encode('<html>bad gateway</html>') }]);
  await assert.rejects(kv.database('orders').get('k'), { code: 'SERVICE_ERROR', status: 502 });
  // The code is also sent as a header, for answers with no readable body.
  const header = client([{ status: 503, headers: { 'x-edgekv-error': 'UNAVAILABLE' } }]);
  await assert.rejects(header.kv.database('orders').get('k'), { code: 'UNAVAILABLE' });
});

test('databases are managed at the control URL, in the names this SDK uses', async () => {
  const raw = {
    id: 'd1', region: 'us-west-2', status: 'active', status_reason: null, created_at: '2026-10-12T00:00:00Z',
    spec: { name: 'orders' },
  };
  const { kv, seen } = client(
    [
      { json: { items: [{ region: 'us-west-2' }] } },
      { status: 201, json: raw },
      { json: { items: [raw], next_page_token: 'next' } },
      { json: { items: [], next_page_token: null } },
      { json: { ...raw, usage: { stored_bytes: 1234 } } },
      { json: { items: [{ hour: '2026-10-12T01:00:00Z', stored_bytes: 5, ops_written: 2, bytes_served: 0 }] } },
      { status: 202, json: { id: 'd1', status: 'deleting' } },
    ],
    { controlUrl: 'https://cp.test' },
  );
  assert.deepEqual(await kv.regions(), ['us-west-2']);
  const created = await kv.databases.create({ name: 'orders', region: 'us-west-2' });
  assert.deepEqual(created, {
    id: 'd1', name: 'orders', region: 'us-west-2', status: 'active', statusReason: null, createdAt: '2026-10-12T00:00:00Z',
  });
  assert.deepEqual(JSON.parse(seen[1]!.body as string), { name: 'orders', region: 'us-west-2' });

  const all = [];
  for await (const database of kv.databases.list()) all.push(database.name);
  assert.deepEqual(all, ['orders']);
  assert.equal(seen[3]!.url.searchParams.get('page_token'), 'next');

  assert.equal((await kv.databases.get('d1')).storedBytes, 1234);
  assert.deepEqual(await kv.databases.usage('d1'), [{ hour: '2026-10-12T01:00:00Z', storedBytes: 5, opsWritten: 2, bytesServed: 0 }]);
  await kv.databases.delete('d1');
  assert.deepEqual([seen[6]!.method, seen[6]!.url.href], ['DELETE', 'https://cp.test/v1/databases/d1']);
  for (const request of seen) assert.equal(request.url.origin, 'https://cp.test');
});

test('mistakes in the options are caught before any request', async () => {
  assert.throws(() => new EdgeKV({ apiKey: 'not-a-key', url: 'https://api.test' }), { code: 'BAD_REQUEST' });
  assert.throws(() => new EdgeKV({ apiKey: 'ekv_k', url: '' }), { code: 'BAD_REQUEST' });
  const { kv, seen } = client([]);
  await assert.rejects(kv.regions(), /controlUrl/);
  await assert.rejects(kv.databases.create({ name: 'x1', region: 'us-west-2' }), /controlUrl/);
  assert.equal(seen.length, 0);
});
