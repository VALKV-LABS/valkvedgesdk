// Tests of the client against a stand-in for `fetch`. No network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValueCipher, encryptionKeyBytes } from '../src/crypto.js';
import { ENCRYPTION_OVERHEAD, EdgeKV, EdgeKVError, UPDATE_ATTEMPTS, tokenRefreshAt, type TokenSource } from '../src/index.js';

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
}

type Answer = { status?: number; json?: unknown; bytes?: Uint8Array; headers?: Record<string, string> } | Error;

/** A client whose requests are answered from a list, in order, and recorded. */
function client(answers: Answer[], options: { retries?: number; controlUrl?: string; tokens?: TokenSource } = {}) {
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
    ...(options.tokens ? { tokens: options.tokens } : { apiKey: 'ekv_test_key' }),
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

test('the local mode picks the native package for the platform', async () => {
  const { platformSuffix } = await import('../src/native.js');
  assert.equal(platformSuffix('linux', 'x64', false), 'linux-x64-gnu');
  assert.equal(platformSuffix('linux', 'arm64', true), 'linux-arm64-musl');
  assert.equal(platformSuffix('darwin', 'arm64', false), 'darwin-arm64');
  assert.equal(platformSuffix('win32', 'x64', false), 'win32-x64-msvc');
  assert.equal(platformSuffix('win32', 'arm64', false), null);
  assert.equal(platformSuffix('freebsd', 'x64', false), null);
});

test('a write can require the version it read, or that the key has no value', async () => {
  const { kv, seen } = client([
    { json: { lsn: 5, version: 'v2' } },
    { json: { lsn: 6, version: 'v1' } },
    { json: { lsn: 7 } },
    { json: { lsn: 8 } },
    { json: { lsn: 9, versions: ['v3', 'v4'] } },
  ]);
  const db = kv.database('shop');
  assert.deepEqual(await db.put('stock/1', '9', { ifVersion: 'v1' }), { lsn: 5, version: 'v2' });
  assert.equal(seen[0]!.headers['if-match'], 'v1');
  await db.put('stock/2', '1', { ifAbsent: true });
  assert.equal(seen[1]!.headers['if-none-match'], '*');
  await db.delete('stock/2', { ifVersion: 'v1' });
  assert.deepEqual([seen[2]!.method, seen[2]!.headers['if-match']], ['DELETE', 'v1']);
  await db.put('stock/3', 'x');
  assert.equal(seen[3]!.headers['if-match'], undefined);
  assert.equal(seen[3]!.headers['if-none-match'], undefined);

  const result = await db.commit([{ op: 'put', key: 'a', value: '1' }, { op: 'delete', key: 'b' }], {
    conditions: [{ key: 'a', version: 'v2' }, { key: 'b', version: null }],
  });
  assert.deepEqual(result.versions, ['v3', 'v4']);
  assert.deepEqual(JSON.parse(seen[4]!.body as string).conditions, [{ key: b64('a'), version: 'v2' }, { key: b64('b'), version: null }]);

  await assert.rejects(db.put('k', 'v', { ifVersion: 'v1', ifAbsent: true }), { code: 'BAD_REQUEST' });
  assert.equal(seen.length, 5);
});

test('getVersioned returns the version the service sends with the value', async () => {
  const { kv } = client([{ bytes: new TextEncoder().encode('10'), headers: { 'x-edgekv-version': 'v7' } }, failure(404, 'KEY_NOT_FOUND')]);
  assert.deepEqual(await kv.database('shop').getVersioned('stock/1'), { value: new TextEncoder().encode('10'), version: 'v7' });
  assert.equal(await kv.database('shop').getVersioned('stock/2'), null);
});

test('a failed condition is reported with the key that did not hold, and is not retried', async () => {
  const { kv, seen } = client([{ status: 412, json: { error: { code: 'CONDITION_FAILED', message: 'changed', key: b64('stock/1') } } }], {
    retries: 3,
  });
  await assert.rejects(kv.database('shop').put('stock/1', '9', { ifVersion: 'v1' }), (error: EdgeKVError) => {
    assert.equal(error.code, 'CONDITION_FAILED');
    assert.equal(error.status, 412);
    assert.deepEqual(error.key, new TextEncoder().encode('stock/1'));
    return true;
  });
  assert.equal(seen.length, 1);
});

test('update reads, changes and writes back, reading again when someone else wrote first', async () => {
  const value = (text: string, version: string) => ({ bytes: new TextEncoder().encode(text), headers: { 'x-edgekv-version': version } });
  const conflict = failure(412, 'CONDITION_FAILED');
  const { kv, seen } = client([value('10', 'v1'), conflict, value('12', 'v2'), { json: { lsn: 3, version: 'v3' } }]);
  const seenValues: string[] = [];
  const result = await kv.database('shop').update('stock/1', (current) => {
    const text = new TextDecoder().decode(current!);
    seenValues.push(text);
    return String(Number(text) - 1);
  });
  assert.deepEqual(result, { lsn: 3, version: 'v3' });
  assert.deepEqual(seenValues, ['10', '12']);
  assert.deepEqual([seen[1]!.headers['if-match'], seen[3]!.headers['if-match']], ['v1', 'v2']);
  assert.deepEqual(seen[3]!.body, new TextEncoder().encode('11'));
});

test('update creates only if absent, deletes on null, and does nothing for null on nothing', async () => {
  const { kv, seen } = client([
    failure(404, 'KEY_NOT_FOUND'),
    { json: { lsn: 1, version: 'v1' } },
    { bytes: new Uint8Array([1]), headers: { 'x-edgekv-version': 'v1' } },
    { json: { lsn: 2 } },
    failure(404, 'KEY_NOT_FOUND'),
  ]);
  const db = kv.database('shop');
  await db.update('counter', (current) => (current === null ? '1' : null));
  assert.equal(seen[1]!.headers['if-none-match'], '*');
  await db.update('counter', () => null);
  assert.deepEqual([seen[3]!.method, seen[3]!.headers['if-match']], ['DELETE', 'v1']);
  assert.equal(await db.update('counter', () => null), null);
  assert.equal(seen.length, 5);
});

test('update gives up with CONDITION_FAILED when the key keeps changing', async () => {
  const answers: Answer[] = [];
  for (let i = 0; i < UPDATE_ATTEMPTS; i += 1) {
    answers.push({ bytes: new Uint8Array([i]), headers: { 'x-edgekv-version': `v${i}` } }, failure(412, 'CONDITION_FAILED'));
  }
  const { kv, seen } = client(answers);
  await assert.rejects(kv.database('shop').update('hot', () => 'x'), { code: 'CONDITION_FAILED' });
  assert.equal(seen.length, UPDATE_ATTEMPTS * 2);
});

/** A token that expires `seconds` from now, in the shape the service mints (only `exp` is read). */
function jwt(seconds: number, id = 'a'): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ exp: Math.floor(Date.now() / 1000) + seconds, jti: id })}.sig`;
}

test('with tokens, each database gets its own token from the source, fetched once', async () => {
  const issued = new Map<string, string>();
  const tokens: TokenSource = async (database) => {
    assert.ok(!issued.has(database), `asked twice for ${database}`);
    issued.set(database, jwt(3600, database));
    return issued.get(database)!;
  };
  const { kv, seen } = client([{ json: { lsn: 1 } }, { json: { lsn: 2 } }, { json: { lsn: 3 } }, { json: { lsn: 4 } }], { tokens });
  await Promise.all([kv.database('notes-1').put('a', '1'), kv.database('notes-1').put('b', '2')]);
  await kv.database('notes-1').put('c', '3');
  await kv.database('notes-2').put('a', '1');
  assert.deepEqual([...issued.keys()], ['notes-1', 'notes-2']);
  assert.equal(seen[0]!.headers.authorization, `Bearer ${issued.get('notes-1')}`);
  assert.equal(seen[2]!.headers.authorization, `Bearer ${issued.get('notes-1')}`);
  assert.equal(seen[3]!.headers.authorization, `Bearer ${issued.get('notes-2')}`);
});

test('a refused token is replaced and the request tried once more', async () => {
  const issued: string[] = [];
  const tokens: TokenSource = () => {
    issued.push(jwt(3600, `t${issued.length}`));
    return issued[issued.length - 1]!;
  };
  const { kv, seen } = client(
    [failure(401, 'TOKEN_EXPIRED'), { json: { lsn: 1 } }, failure(401, 'UNAUTHENTICATED'), failure(401, 'UNAUTHENTICATED')],
    { tokens },
  );
  const db = kv.database('notes');
  assert.deepEqual(await db.put('a', '1'), { lsn: 1 });
  assert.equal(seen[0]!.headers.authorization, `Bearer ${issued[0]}`);
  assert.equal(seen[1]!.headers.authorization, `Bearer ${issued[1]}`);
  // Refused again straight after a new token: reported, not retried forever.
  await assert.rejects(db.put('b', '2'), { code: 'UNAUTHENTICATED' });
  assert.equal(seen.length, 4);
});

test('a token close to expiry is renewed before it is used', async () => {
  const issued: string[] = [];
  const tokens: TokenSource = () => {
    // The first is already past its renewal time when it arrives.
    issued.push(jwt(issued.length === 0 ? -1 : 3600, `t${issued.length}`));
    return issued[issued.length - 1]!;
  };
  const { kv, seen } = client([{ json: { lsn: 1 } }, { json: { lsn: 2 } }], { tokens });
  await kv.database('notes').put('a', '1');
  await kv.database('notes').put('b', '2');
  assert.equal(issued.length, 2);
  assert.equal(seen[1]!.headers.authorization, `Bearer ${issued[1]}`);
});

test('a failing token source is reported as UNAVAILABLE', async () => {
  const { kv, seen } = client([], { tokens: async () => Promise.reject(new Error('backend down')) });
  await assert.rejects(kv.database('notes').get('a'), (error: EdgeKVError) => {
    assert.equal(error.code, 'UNAVAILABLE');
    assert.match(error.message, /backend down/);
    return true;
  });
  assert.equal(seen.length, 0);
});

test('tokenRefreshAt renews a minute early, or halfway for a short token, and never for a token without exp', () => {
  const now = 1_000_000_000_000;
  const at = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;
  assert.equal(tokenRefreshAt(at(now / 1000 + 3600), now), now + 3_540_000);
  assert.equal(tokenRefreshAt(at(now / 1000 + 60), now), now + 30_000);
  assert.equal(tokenRefreshAt('ekv_not_a_jwt', now), Infinity);
});

test('createToken asks the service for a token for one database', async () => {
  const { kv, seen } = client([{ status: 201, json: { token: 'eyJ.x.y', scope: 'write', expires_at: '2026-10-15T13:00:00Z' } }]);
  const token = await kv.database('notes-user-1').createToken({ scope: 'write', ttlSeconds: 600, subject: 'user-1' });
  assert.deepEqual(token, { token: 'eyJ.x.y', scope: 'write', expiresAt: '2026-10-15T13:00:00Z' });
  assert.equal(seen[0]!.url.pathname, '/v1/db/notes-user-1/tokens');
  assert.deepEqual(JSON.parse(seen[0]!.body as string), { scope: 'write', ttl_seconds: 600, subject: 'user-1' });
});

test('an API key or tokens, never both, and tokens cannot manage databases', async () => {
  const tokens = () => 'eyJ.x.y';
  assert.throws(() => new EdgeKV({ url: 'https://api.test' }), { code: 'BAD_REQUEST' });
  assert.throws(() => new EdgeKV({ apiKey: 'ekv_k', tokens, url: 'https://api.test' }), { code: 'BAD_REQUEST' });
  const { kv, seen } = client([], { tokens, controlUrl: 'https://cp.test' });
  await assert.rejects(kv.regions(), /API key/);
  assert.equal(seen.length, 0);
});

// --- Encryption -------------------------------------------------------------

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i);
const KEY_HEX = Buffer.from(KEY).toString('hex');
const OTHER_KEY = new Uint8Array(32).fill(9);
const bytes = (text: string) => new TextEncoder().encode(text);

/**
 * The format shared with the valkvedge library and the Python client: the
 * same vector is checked in each of them.
 */
const VECTOR = {
  database: 'agent-memory',
  key: 'facts/name',
  value: 'Ada Lovelace',
  nonce: Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i),
  sealed: 'a0a1a2a3a4a5a6a7a8a9aaab4dcf197f0189b4c8cc6e9071b3f75750df0d5894317f0dd9e2ece8f5',
};

test('values are sealed in the library format, bound to their database and key', () => {
  const cipher = new ValueCipher(KEY, VECTOR.database);
  const sealed = cipher.seal(bytes(VECTOR.key), bytes(VECTOR.value), VECTOR.nonce);
  assert.equal(Buffer.from(sealed).toString('hex'), VECTOR.sealed);
  assert.equal(sealed.length, VECTOR.value.length + ENCRYPTION_OVERHEAD);
  assert.deepEqual(cipher.open(bytes(VECTOR.key), sealed), bytes(VECTOR.value));

  assert.equal(cipher.open(bytes('facts/other'), sealed), null, 'moved to another key');
  assert.equal(new ValueCipher(KEY, 'other-db').open(bytes(VECTOR.key), sealed), null, 'moved to another database');
  assert.equal(new ValueCipher(OTHER_KEY, VECTOR.database).open(bytes(VECTOR.key), sealed), null, 'another key');
  const tampered = sealed.slice();
  tampered[tampered.length - 1]! ^= 1;
  assert.equal(cipher.open(bytes(VECTOR.key), tampered), null, 'tampered');
  assert.equal(cipher.open(bytes(VECTOR.key), bytes('short')), null, 'too short to be sealed');

  // A fresh nonce each time: the same value never seals the same way twice.
  assert.notDeepEqual(cipher.seal(bytes('k'), bytes('v')), cipher.seal(bytes('k'), bytes('v')));
});

test('an encryption key is 32 bytes or 64 hexadecimal characters', () => {
  const { kv } = client([]);
  assert.deepEqual(encryptionKeyBytes(KEY_HEX), KEY);
  assert.deepEqual(encryptionKeyBytes(KEY_HEX.toUpperCase()), KEY);
  assert.equal(kv.database('a', { encryptionKey: KEY_HEX }).encrypted, true);
  assert.equal(kv.database('a').encrypted, false);
  for (const wrong of [new Uint8Array(16), 'abc', KEY_HEX.slice(2), `${KEY_HEX.slice(2)}zz`]) {
    assert.throws(() => kv.database('a', { encryptionKey: wrong }), { code: 'BAD_REQUEST' });
  }
});

test('with a key, put sends ciphertext and get returns the value', async () => {
  const { kv, seen } = client([{ json: { lsn: 1 } }]);
  const db = kv.database(VECTOR.database, { encryptionKey: KEY });
  await db.put(VECTOR.key, VECTOR.value);
  const sent = seen[0]!.body as Uint8Array;
  assert.equal(sent.length, VECTOR.value.length + ENCRYPTION_OVERHEAD);
  assert.ok(!Buffer.from(sent).includes(Buffer.from(VECTOR.value)), 'the value is not sent in clear');

  const { kv: reader } = client([{ bytes: sent }, { bytes: Buffer.from(VECTOR.sealed, 'hex') }]);
  const same = reader.database(VECTOR.database, { encryptionKey: KEY_HEX });
  assert.equal(await same.getText(VECTOR.key), VECTOR.value);
  assert.equal(await same.getText(VECTOR.key), VECTOR.value, 'a value sealed by another client opens');
});

test('with the wrong key, or a value that was not encrypted, reads fail with INVALID_ENCRYPTION_KEY', async () => {
  const sealed = Buffer.from(VECTOR.sealed, 'hex');
  const { kv } = client([{ bytes: sealed }, { bytes: bytes('plain text') }, { bytes: sealed }]);
  const wrongKey = kv.database(VECTOR.database, { encryptionKey: OTHER_KEY });
  await assert.rejects(wrongKey.get(VECTOR.key), (error: EdgeKVError) => {
    assert.equal(error.code, 'INVALID_ENCRYPTION_KEY');
    assert.deepEqual(error.key, bytes(VECTOR.key));
    return true;
  });
  await assert.rejects(kv.database(VECTOR.database, { encryptionKey: KEY }).get(VECTOR.key), { code: 'INVALID_ENCRYPTION_KEY' });
  // Without a key, the stored bytes come back as they are.
  assert.deepEqual(await kv.database(VECTOR.database).get(VECTOR.key), new Uint8Array(sealed));
});

test('with a key, commits seal each value under its own key, and scans open them', async () => {
  const { kv, seen } = client([{ json: { lsn: 2 } }]);
  const db = kv.database('memory', { encryptionKey: KEY });
  await db.commit([
    { op: 'put', key: 'facts/a', value: 'one' },
    { op: 'put', key: 'facts/b', value: 'two' },
    { op: 'delete', key: 'facts/c' },
  ]);
  const ops = (JSON.parse(seen[0]!.body as string) as { ops: { op: string; key: string; value?: string }[] }).ops;
  assert.deepEqual(ops[2], { op: 'delete', key: b64('facts/c') });

  const items = [
    { key: ops[0]!.key, value: ops[0]!.value!, version: 'v1' },
    { key: ops[1]!.key, value: ops[1]!.value!, version: 'v2' },
  ];
  const { kv: reader } = client([{ json: { items, next_page_token: null } }, { json: { items: [{ ...items[0]!, key: b64('facts/b') }], next_page_token: null } }]);
  const listed = [];
  for await (const entry of reader.database('memory', { encryptionKey: KEY }).scan({ prefix: 'facts/' })) {
    listed.push([entry.key, new TextDecoder().decode(entry.value), entry.version]);
  }
  assert.deepEqual(listed, [
    ['facts/a', 'one', 'v1'],
    ['facts/b', 'two', 'v2'],
  ]);
  // A value moved under another key does not open.
  await assert.rejects(reader.database('memory', { encryptionKey: KEY }).scanPage(), { code: 'INVALID_ENCRYPTION_KEY' });
});

test('update reads, decrypts, and writes back sealed under the version it read', async () => {
  const cipher = new ValueCipher(KEY, 'counters');
  const { kv, seen } = client([
    { bytes: cipher.seal(bytes('hits'), bytes('41')), headers: { 'x-edgekv-version': 'v7' } },
    { json: { lsn: 8 } },
  ]);
  await kv.database('counters', { encryptionKey: KEY }).update('hits', (current) => String(Number(new TextDecoder().decode(current!)) + 1));
  assert.equal(seen[1]!.headers['if-match'], 'v7');
  assert.deepEqual(cipher.open(bytes('hits'), seen[1]!.body as Uint8Array), bytes('42'));
});
