import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromEnv } from '../src/config.js';

const minimal = { EDGEKV_API_KEY: 'ekv_abc', EDGEKV_URL: 'https://api.example.com' };

test('the minimal settings: a key and the data API', () => {
  assert.deepEqual(configFromEnv(minimal), {
    apiKey: 'ekv_abc',
    url: 'https://api.example.com',
    controlUrl: undefined,
    database: undefined,
    region: undefined,
    encryptionKey: undefined,
    readOnly: false,
    allowDelete: false,
  });
});

test('every setting', () => {
  const config = configFromEnv({
    ...minimal,
    EDGEKV_CONTROL_URL: 'https://cp.example.com',
    EDGEKV_DATABASE: 'mem-ada',
    EDGEKV_REGION: 'eu-west-1',
    EDGEKV_ENCRYPTION_KEY: 'AB'.repeat(32),
    EDGEKV_READ_ONLY: 'true',
    EDGEKV_ALLOW_DELETE: '1',
  });
  assert.equal(config.controlUrl, 'https://cp.example.com');
  assert.equal(config.database, 'mem-ada');
  assert.equal(config.region, 'eu-west-1');
  assert.equal(config.encryptionKey, 'AB'.repeat(32));
  assert.equal(config.readOnly, true);
  assert.equal(config.allowDelete, true);
  assert.equal(configFromEnv({ ...minimal, EDGEKV_READ_ONLY: '0', EDGEKV_ALLOW_DELETE: 'no' }).readOnly, false);
  assert.equal(configFromEnv({ ...minimal, EDGEKV_DATABASE: '  ' }).database, undefined, 'blank means unset');
});

test('every problem is reported at once', () => {
  assert.throws(
    () => configFromEnv({ EDGEKV_API_KEY: 'sk-123', EDGEKV_ENCRYPTION_KEY: 'short', EDGEKV_DATABASE: 'Bad Name' }),
    (error: Error) => {
      const lines = error.message.split('\n');
      assert.equal(lines.length, 4);
      assert.match(lines[0]!, /EDGEKV_API_KEY must be an API key/);
      assert.match(lines[1]!, /EDGEKV_URL is missing/);
      assert.match(lines[2]!, /openssl rand -hex 32/);
      assert.match(lines[3]!, /EDGEKV_DATABASE must be a database name/);
      return true;
    },
  );
  assert.throws(() => configFromEnv({}), /EDGEKV_API_KEY is missing/);
});
