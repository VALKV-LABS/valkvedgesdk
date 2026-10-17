// The tools, called through a real MCP client over an in-memory transport,
// against a stand-in for the service. No network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EdgeKV } from '@valkvlabs/edgekv';
import { createServer, type Config } from '../src/server.js';
import { FakeService } from './fake-service.js';

const KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

async function connect(service: FakeService, settings: Partial<Config> = {}) {
  const config: Config = { apiKey: 'ekv_test', url: 'https://api.test', readOnly: false, allowDelete: false, ...settings };
  const kv = new EdgeKV({
    apiKey: config.apiKey,
    url: config.url,
    controlUrl: config.controlUrl,
    retries: 0,
    fetch: service.fetch as typeof fetch,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(kv, config).connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);

  /** Calls a tool: its JSON answer, or `{ error }` with the text of a tool error. */
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    return result.isError ? { error: text } : (JSON.parse(text) as Record<string, any>);
  };
  const tools = async () => (await client.listTools()).tools.map((tool) => tool.name).sort();
  return { client, call, tools };
}

test('the tools offered follow the settings', async () => {
  const service = new FakeService(['memory']);
  assert.deepEqual(await (await connect(service)).tools(), ['get', 'put', 'put_many', 'scan']);
  assert.deepEqual(await (await connect(service, { allowDelete: true, controlUrl: 'https://cp.test' })).tools(), [
    'create_database',
    'delete',
    'get',
    'list_databases',
    'put',
    'put_many',
    'scan',
  ]);
  assert.deepEqual(await (await connect(service, { readOnly: true, allowDelete: true, controlUrl: 'https://cp.test' })).tools(), [
    'get',
    'list_databases',
    'scan',
  ]);
  // Pinned to one database: no tools to manage databases, and no database argument.
  const pinned = await connect(service, { database: 'memory', controlUrl: 'https://cp.test' });
  assert.deepEqual(await pinned.tools(), ['get', 'put', 'put_many', 'scan']);
  const get = (await pinned.client.listTools()).tools.find((tool) => tool.name === 'get')!;
  assert.deepEqual(get.inputSchema.required, ['key']);
  const unpinned = (await (await connect(service)).client.listTools()).tools.find((tool) => tool.name === 'get')!;
  assert.deepEqual([...(unpinned.inputSchema.required ?? [])].sort(), ['database', 'key']);
});

test('the instructions say how to use it, and whether values are encrypted', async () => {
  const plain = await connect(new FakeService(), { database: 'memory' });
  assert.match(plain.client.getInstructions()!, /database "memory"/);
  assert.match(plain.client.getInstructions()!, /put_many/);
  assert.match(plain.client.getInstructions()!, /not encrypted/);
  const sealed = await connect(new FakeService(), { encryptionKey: KEY, readOnly: true });
  assert.match(sealed.client.getInstructions()!, /encrypted before they leave this machine/);
  assert.doesNotMatch(sealed.client.getInstructions()!, /put_many/);
});

test('put, then get, returns the value and its version; a missing key is found: false', async () => {
  const { call } = await connect(new FakeService(['memory']), { database: 'memory' });
  const written = await call('put', { key: 'facts/name', value: 'Ada' });
  assert.equal(written.key, 'facts/name');
  assert.ok(written.version);
  assert.deepEqual(await call('get', { key: 'facts/name' }), { key: 'facts/name', found: true, value: 'Ada', version: written.version });
  assert.deepEqual(await call('get', { key: 'facts/none' }), { key: 'facts/none', found: false });
});

test('a conditional put that lost a race is a tool error that says what to do', async () => {
  const { call } = await connect(new FakeService(['memory']), { database: 'memory' });
  const first = await call('put', { key: 'count', value: '1' });
  await call('put', { key: 'count', value: '2' });
  const lost = await call('put', { key: 'count', value: '3', if_version: first.version });
  assert.match(lost.error, /^CONDITION_FAILED: /);
  assert.match(lost.error, /get it again/);
  assert.match((await call('put', { key: 'count', value: '9', if_absent: true })).error, /^CONDITION_FAILED/);
  assert.equal((await call('get', { key: 'count' })).value, '2');
});

test('put_many is one write, and scan lists by prefix, page by page', async () => {
  const service = new FakeService(['memory']);
  const { call } = await connect(service, { database: 'memory' });
  const entries = ['a', 'b', 'c'].map((name) => ({ key: `facts/${name}`, value: name.toUpperCase() }));
  const written = await call('put_many', { entries: [...entries, { key: 'tasks/1', value: 'x' }] });
  assert.equal(written.written, 4);
  assert.equal(service.requests.filter((request) => request.startsWith('POST')).length, 1);

  const first = await call('scan', { prefix: 'facts/', limit: 2 });
  assert.deepEqual(first.entries.map((entry: { key: string; value: string }) => [entry.key, entry.value]), [
    ['facts/a', 'A'],
    ['facts/b', 'B'],
  ]);
  const second = await call('scan', { prefix: 'facts/', limit: 2, cursor: first.next_cursor });
  assert.deepEqual(second.entries.map((entry: { key: string }) => entry.key), ['facts/c']);
  assert.equal(second.next_cursor, null);
  const keysOnly = await call('scan', { prefix: 'tasks/', values: false });
  assert.deepEqual(Object.keys(keysOnly.entries[0]).sort(), ['key', 'version']);
});

test('a value that is not text comes back as base64', async () => {
  const service = new FakeService(['memory']);
  service.databases.get('memory')!.set('blob', { value: new Uint8Array([0xff, 0x00, 0xfe]), version: 'v1' });
  const { call } = await connect(service, { database: 'memory' });
  assert.deepEqual(await call('get', { key: 'blob' }), { key: 'blob', found: true, value_base64: '/wD+', version: 'v1' });
});

test('with an encryption key, the service only ever holds ciphertext', async () => {
  const service = new FakeService(['memory']);
  const { call } = await connect(service, { database: 'memory', encryptionKey: KEY });
  await call('put', { key: 'facts/diagnosis', value: 'private: asthma' });
  await call('put_many', { entries: [{ key: 'facts/a', value: 'private: one' }, { key: 'facts/b', value: 'private: two' }] });

  for (const stored of service.allValues()) {
    assert.ok(!Buffer.from(stored).toString('latin1').includes('private'), 'a value reached the service in clear');
  }
  assert.equal((await call('get', { key: 'facts/diagnosis' })).value, 'private: asthma');
  const listed = await call('scan', { prefix: 'facts/' });
  assert.deepEqual(listed.entries.map((entry: { value: string }) => entry.value), ['private: one', 'private: two', 'private: asthma']);

  // The same key on another server reads it; another key, or none, does not.
  const sameKey = await connect(service, { database: 'memory', encryptionKey: KEY.toUpperCase() });
  assert.equal((await sameKey.call('get', { key: 'facts/diagnosis' })).value, 'private: asthma');
  const otherKey = await connect(service, { database: 'memory', encryptionKey: 'ff'.repeat(32) });
  const refused = await otherKey.call('get', { key: 'facts/diagnosis' });
  assert.match(refused.error, /^INVALID_ENCRYPTION_KEY: /);
  assert.match(refused.error, /same key or never/);
  const noKey = await connect(service, { database: 'memory' });
  const raw = await noKey.call('get', { key: 'facts/diagnosis' });
  assert.ok(raw.value_base64 ?? raw.value);
  assert.notEqual(raw.value, 'private: asthma');
});

test('without an encryption key, values are stored as sent', async () => {
  const service = new FakeService(['memory']);
  const { call } = await connect(service, { database: 'memory' });
  await call('put', { key: 'note', value: 'hello' });
  assert.equal(Buffer.from(service.databases.get('memory')!.get('note')!.value).toString(), 'hello');
});

test('without a pinned database, each call names one, and a missing one says so', async () => {
  const service = new FakeService(['alice', 'bob']);
  const { call } = await connect(service);
  await call('put', { database: 'alice', key: 'k', value: 'from alice' });
  assert.deepEqual(await call('get', { database: 'bob', key: 'k' }), { key: 'k', found: false });
  assert.equal((await call('get', { database: 'alice', key: 'k' })).value, 'from alice');
  const missing = await call('get', { database: 'carol', key: 'k' });
  assert.match(missing.error, /^NOT_FOUND: /);
  assert.match(missing.error, /no database by that name/);
});

test('create_database uses the first region unless one is set, and an existing name is not an error', async () => {
  const service = new FakeService(['alice']);
  const { call } = await connect(service, { controlUrl: 'https://cp.test' });
  assert.deepEqual(await call('create_database', { name: 'bob' }), { name: 'bob', created: true, region: 'us-west-2', status: 'active' });
  assert.deepEqual(await call('create_database', { name: 'alice' }), { name: 'alice', created: false });
  const named = await connect(service, { controlUrl: 'https://cp.test', region: 'eu-west-1' });
  assert.equal((await named.call('create_database', { name: 'carol' })).region, 'eu-west-1');
  const listed = await call('list_databases');
  assert.deepEqual(listed.databases.map((db: { name: string }) => db.name), ['alice', 'bob', 'carol']);
});

test('delete removes a key when allowed', async () => {
  const service = new FakeService(['memory']);
  const { call } = await connect(service, { database: 'memory', allowDelete: true });
  await call('put', { key: 'old', value: 'x' });
  assert.equal((await call('delete', { key: 'old' })).deleted, true);
  assert.equal((await call('get', { key: 'old' })).found, false);
});

test('arguments are checked before anything is sent', async () => {
  const service = new FakeService(['memory']);
  const { client } = await connect(service, { controlUrl: 'https://cp.test' });
  const bad = await client.callTool({ name: 'create_database', arguments: { name: 'Not Valid' } });
  assert.equal(bad.isError, true);
  assert.equal(service.requests.length, 0);
});
