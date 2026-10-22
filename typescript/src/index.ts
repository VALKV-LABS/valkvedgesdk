/**
 * ValkvEdgeKV client for TypeScript and JavaScript.
 *
 * `EdgeKV` talks to the service over HTTPS with an API key, or with access
 * tokens your backend mints. It keeps no local copy: every read and write is
 * a request. It needs a runtime with `fetch`:
 * Node 18 or later, Deno, Bun, or a browser.
 *
 * `LocalEdgeKV` keeps a copy on this machine, read without the network and
 * written offline. It runs the valkvedge library, compiled for each platform
 * and installed with this package. See `local.ts`.
 */

import { ValueCipher } from './crypto.js';

export { ENCRYPTION_OVERHEAD } from './crypto.js';

/** A value to store: bytes, or text, which is stored as UTF-8. */
export type Value = Uint8Array | string;

/**
 * Gets an access token for one database, usually by asking your backend,
 * which mints it with `Database.createToken`. Called the first time a
 * database is used, again about a minute before the token expires, and
 * whenever the service refuses it.
 */
export type TokenSource = (database: string) => Promise<string> | string;

export interface EdgeKVOptions {
  /** An API key from the portal: `ekv_…`. For your servers. Give this or `tokens`. */
  apiKey?: string;
  /**
   * For apps on your users' devices, which must not hold an API key: where
   * to get a token for each database. Give this or `apiKey`.
   */
  tokens?: TokenSource;
  /** Where the data API is, for example `https://api.example.com`. */
  url: string;
  /**
   * Where databases are managed, for example `https://cp.example.com`. Only
   * needed for `databases` and `regions`, and only works with a key that was
   * given the right to manage databases.
   */
  controlUrl?: string;
  /** How long one request may take, in milliseconds. Default 15 000. */
  timeoutMs?: number;
  /**
   * How many times a request is tried again when the service says it was not
   * done and can be repeated (see `RETRYABLE`). Default 3. 0 turns retries off.
   */
  retries?: number;
  /** A `fetch` to use instead of the global one. */
  fetch?: typeof fetch;
}

/**
 * Codes that mean "nothing happened, try again shortly": the key is over its
 * request rate, the database is moving between servers, or the service is
 * briefly unavailable. Puts, deletes and commits are safe to repeat: doing
 * one twice leaves the same data as doing it once.
 */
export const RETRYABLE: readonly string[] = ['RATE_LIMITED', 'LEASE_HELD', 'UNAVAILABLE'];

/** Any failure reported by the service, or in reaching it. */
export class EdgeKVError extends Error {
  constructor(
    /** A stable code, for example `NOT_FOUND` or `STORAGE_QUOTA_EXCEEDED`. `NETWORK` and `TIMEOUT` are raised by this client. */
    readonly code: string,
    message: string,
    /** The HTTP status, or 0 when no response arrived. */
    readonly status: number,
    /** For `CONDITION_FAILED`: the key whose condition did not hold, when known. */
    readonly key?: Uint8Array,
  ) {
    super(message);
    this.name = 'EdgeKVError';
  }

  /** True if the same request may succeed when tried again shortly. */
  get retryable(): boolean {
    return RETRYABLE.includes(this.code) || this.code === 'NETWORK';
  }
}

export interface WriteResult {
  /** Position of this write in the database's log. Later writes have higher numbers. */
  lsn: number;
  /** The version the key's new value has. Present for a put. */
  version?: string;
}

export interface CommitResult extends WriteResult {
  /** The version each operation gave its key, in order. */
  versions: string[];
}

/** A value and its version: pass the version back to write only if the value has not changed since. */
export interface Versioned {
  value: Uint8Array;
  version: string;
  /** When the value expires. Absent for a value that does not. */
  expiresAt?: Date;
}

export interface Entry {
  key: string;
  /** The key as stored, for keys that are not valid UTF-8 text. */
  keyBytes: Uint8Array;
  value: Uint8Array;
  /** The value's version, when the source reports it. */
  version?: string;
  /** When the value expires, when it does and the source reports it. */
  expiresAt?: Date;
}

/**
 * A lifetime for a value: `ttlSeconds` from now (1 second to 10 years), or
 * `expiresAt`. Give at most one. Once it has passed the key reads as not
 * there, and the service then deletes it. The time is stored beside the
 * value, not encrypted with it.
 */
export interface Expiry {
  ttlSeconds?: number;
  expiresAt?: Date | string;
}

export type Operation = ({ op: 'put'; key: Value; value: Value } & Expiry) | { op: 'delete'; key: Value };

/** A requirement for a commit: `key` is still at `version`, or has no value when `version` is `null`. */
export interface Condition {
  key: Value;
  version: string | null;
}

/** Makes a single-key write conditional. Give at most one. */
export interface WriteCondition {
  /** Only if the key is still at this version. */
  ifVersion?: string;
  /** Only if the key has no value: create, never overwrite. */
  ifAbsent?: boolean;
}

/** What a put can carry: a condition, and a lifetime. */
export interface PutOptions extends WriteCondition, Expiry {}

/** `expires_at` or `ttl_seconds` for the service, checked here first. */
function expiryFields(expiry: Expiry): { ttl_seconds?: number; expires_at?: string } {
  if (expiry.ttlSeconds !== undefined && expiry.expiresAt !== undefined) {
    throw new EdgeKVError('BAD_REQUEST', 'give ttlSeconds or expiresAt, not both', 0);
  }
  if (expiry.ttlSeconds !== undefined) return { ttl_seconds: expiry.ttlSeconds };
  if (expiry.expiresAt !== undefined) {
    const at = expiry.expiresAt instanceof Date ? expiry.expiresAt.toISOString() : expiry.expiresAt;
    return { expires_at: at };
  }
  return {};
}

/**
 * Computes a key's new value from its current one (`null` when it has none).
 * Return `null` to delete the key. It may run more than once.
 */
export type Change = (current: Uint8Array | null) => Value | null | Promise<Value | null>;

/** How many times `update` reads and tries again before giving up with `CONDITION_FAILED`. */
export const UPDATE_ATTEMPTS = 16;

export interface TokenOptions {
  /** `'read'` (the default) or `'write'`. A read-only key can mint only read tokens. */
  scope?: 'read' | 'write';
  /** How long the token works: 60 to 86 400 seconds. Default 3600. */
  ttlSeconds?: number;
  /** Your own name for the user, kept in the token. */
  subject?: string;
}

export interface Token {
  /** Send it as a key: `Authorization: Bearer <token>`, or give it to an app's `tokens` source. */
  token: string;
  scope: 'read' | 'write';
  expiresAt: string;
}

export interface ScanOptions {
  /** Only keys that start with this. */
  prefix?: string;
  /** Entries per request, 1 to 200. Default 50. */
  pageSize?: number;
}

export interface Page<T> {
  items: T[];
  /** Pass to the next call to continue, or `null` when there is nothing more. */
  nextPageToken: string | null;
}

export interface Head {
  generation: number;
  lsn: number;
}

/** A database as the service describes it. */
export interface DatabaseInfo {
  id: string;
  name: string;
  region: string;
  status: 'provisioning' | 'active' | 'degraded' | 'suspended' | 'deleting' | 'deleted' | 'error';
  statusReason: string | null;
  createdAt: string;
  /** Present when one database is read: its stored size in bytes. */
  storedBytes?: number;
}

export interface UsageHour {
  hour: string;
  storedBytes: number;
  opsWritten: number;
  bytesServed: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toBytes = (value: Value): Uint8Array => (typeof value === 'string' ? encoder.encode(value) : value);

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A key as a URL path: every segment escaped, slashes kept. */
function keyPath(key: string): string {
  if (key.length === 0) throw new EdgeKVError('BAD_REQUEST', 'a key must not be empty', 0);
  return key.split('/').map(encodeURIComponent).join('/');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function conditionHeaders(condition: WriteCondition): Record<string, string> {
  if (condition.ifVersion !== undefined && condition.ifAbsent) {
    throw new EdgeKVError('BAD_REQUEST', 'give ifVersion or ifAbsent, not both', 0);
  }
  if (condition.ifVersion !== undefined) return { 'if-match': condition.ifVersion };
  return condition.ifAbsent ? { 'if-none-match': '*' } : {};
}

interface RequestOptions {
  body?: BodyInit;
  json?: unknown;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** What requests are sent with: a fixed API key, or one database's access token. */
interface Credential {
  get(): Promise<string>;
  /** The service refused `token`. Returns true if a new one may be fetched and the request tried again. */
  refuse(token: string): boolean;
}

const apiKeyCredential = (apiKey: string): Credential => ({ get: async () => apiKey, refuse: () => false });

/**
 * When to stop using a token: a minute before its `exp`, or halfway through
 * its life if that is sooner. A token that does not say is used until refused.
 */
export function tokenRefreshAt(token: string, now = Date.now()): number {
  try {
    const part = token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const exp = (JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), '='))) as { exp?: unknown }).exp;
    if (typeof exp !== 'number') return Infinity;
    const expiresAt = exp * 1000;
    return Math.max(expiresAt - 60_000, now + (expiresAt - now) / 2);
  } catch {
    return Infinity;
  }
}

/** One database's access token, fetched from the application's source and kept until it is due for renewal. */
class TokenCredential implements Credential {
  private current?: { token: string; refreshAt: number };
  private pending?: Promise<string>;

  constructor(
    private readonly source: TokenSource,
    private readonly database: string,
  ) {}

  get(): Promise<string> {
    if (this.current && Date.now() < this.current.refreshAt) return Promise.resolve(this.current.token);
    this.pending ??= this.fetch().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  refuse(token: string): boolean {
    if (this.current?.token === token) this.current = undefined;
    return true;
  }

  private async fetch(): Promise<string> {
    let token: unknown;
    try {
      token = await this.source(this.database);
    } catch (error) {
      if (error instanceof EdgeKVError) throw error;
      // Retryable, like a service that is briefly unavailable.
      throw new EdgeKVError('UNAVAILABLE', `the token source failed: ${error instanceof Error ? error.message : error}`, 0);
    }
    if (typeof token !== 'string' || token.length === 0) {
      throw new EdgeKVError('BAD_REQUEST', `the token source returned no token for ${this.database}`, 0);
    }
    this.current = { token, refreshAt: tokenRefreshAt(token) };
    return token;
  }
}

/** Codes that mean the credential itself was refused. */
const REFUSED = ['TOKEN_EXPIRED', 'UNAUTHENTICATED'];

/** Sends requests to one base URL: adds the credential, the timeout and the retries, and turns failures into `EdgeKVError`. */
class Transport {
  constructor(
    private readonly base: string,
    private readonly credential: Credential,
    private readonly timeoutMs: number,
    private readonly retries: number,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /** The same service, with another credential. */
  with(credential: Credential): Transport {
    return new Transport(this.base, credential, this.timeoutMs, this.retries, this.fetchImpl);
  }

  async send(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const url = new URL(this.base.replace(/\/+$/, '') + path);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const headers: Record<string, string> = { ...options.headers };
    let body = options.body;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.json);
    }
    let renewed = false;
    for (let attempt = 0; ; attempt += 1) {
      let token: string | undefined;
      try {
        token = await this.credential.get();
        const sent = { ...headers, authorization: `Bearer ${token}` };
        return await this.once(method, url, sent, body, options.timeoutMs ?? this.timeoutMs);
      } catch (error) {
        if (!(error instanceof EdgeKVError)) throw error;
        // A refused token is renewed and the request tried once more, at once.
        if (REFUSED.includes(error.code) && token !== undefined && !renewed && this.credential.refuse(token)) {
          renewed = true;
          attempt -= 1;
          continue;
        }
        if (!error.retryable || attempt >= this.retries) throw error;
        // 100 ms, 200 ms, 400 ms, …, with jitter so many clients do not retry together.
        await sleep(100 * 2 ** attempt * (0.5 + Math.random()));
      }
    }
  }

  private async once(
    method: string,
    url: URL,
    headers: Record<string, string>,
    body: BodyInit | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      if (timedOut) {
        // Not retried: the service may have done the work.
        throw new EdgeKVError('TIMEOUT', `no answer within ${timeoutMs} ms; the request may or may not have been carried out`, 0);
      }
      throw new EdgeKVError('NETWORK', `could not reach ${url.origin}: ${error instanceof Error ? error.message : error}`, 0);
    }
    if (response.ok) return response;
    let code = response.headers.get('x-edgekv-error') ?? '';
    let message = '';
    let key: Uint8Array | undefined;
    try {
      const parsed = (await response.json()) as { error?: { code?: string; message?: string; key?: string } };
      code = parsed.error?.code ?? code;
      message = parsed.error?.message ?? '';
      if (typeof parsed.error?.key === 'string') key = fromBase64(parsed.error.key);
    } catch {
      // Not the service's error shape: a gateway or proxy answered.
    }
    throw new EdgeKVError(code || 'SERVICE_ERROR', message || `the service answered ${response.status}`, response.status, key);
  }
}

export interface DatabaseOptions {
  /**
   * 32 bytes, or 64 hexadecimal characters. Values are encrypted with it in
   * this process before they are sent, and decrypted when read: the service
   * stores only ciphertext. The format is the one `LocalEdgeKV` and the Rust
   * library use, so they read these values with the same key, and this reads
   * theirs. Keys (the names) are not encrypted. A lost key cannot be
   * recovered. Without it, values are sent as they are.
   *
   * Use one choice per database: a database is either encrypted, with one
   * key, or not. Reading a value written without the key, or with another
   * key, fails with `INVALID_ENCRYPTION_KEY`.
   */
  encryptionKey?: Uint8Array | string;
}

/** One database's contents. Get one from `EdgeKV.database(name)`. */
export class Database {
  /** @internal */
  constructor(
    private readonly transport: Transport,
    /** The database's name within the account. */
    readonly name: string,
    private readonly cipher?: ValueCipher,
  ) {}

  /** True if values are encrypted here before they are sent. */
  get encrypted(): boolean {
    return this.cipher !== undefined;
  }

  private path(rest: string): string {
    return `/v1/db/${encodeURIComponent(this.name)}${rest}`;
  }

  /** The value to send for `key`: encrypted when there is a key. */
  private sealed(key: Uint8Array, value: Uint8Array): Uint8Array {
    return this.cipher ? this.cipher.seal(key, value) : value;
  }

  /** The value as read for `key`: decrypted when there is a key. */
  private opened(key: Uint8Array, stored: Uint8Array): Uint8Array {
    if (!this.cipher) return stored;
    const value = this.cipher.open(key, stored);
    if (value === null) {
      throw new EdgeKVError(
        'INVALID_ENCRYPTION_KEY',
        `the value of ${decoder.decode(key)} could not be decrypted: another key encrypted it, or it was not encrypted`,
        0,
        key,
      );
    }
    return value;
  }

  /** The value stored under `key`, or `null` if there is none. */
  async get(key: string): Promise<Uint8Array | null> {
    return (await this.getVersioned(key))?.value ?? null;
  }

  /** The value stored under `key` and its version, or `null` if there is none. */
  async getVersioned(key: string): Promise<Versioned | null> {
    try {
      const response = await this.transport.send('GET', this.path(`/kv/${keyPath(key)}`));
      const stored = new Uint8Array(await response.arrayBuffer());
      const expires = response.headers.get('x-edgekv-expires');
      return {
        value: this.opened(toBytes(key), stored),
        version: response.headers.get('x-edgekv-version') ?? '',
        ...(expires ? { expiresAt: new Date(expires) } : {}),
      };
    } catch (error) {
      if (error instanceof EdgeKVError && error.code === 'KEY_NOT_FOUND') return null;
      throw error;
    }
  }

  /** The value as text, or `null`. */
  async getText(key: string): Promise<string | null> {
    const value = await this.get(key);
    return value === null ? null : decoder.decode(value);
  }

  /** The value parsed as JSON, or `null`. Throws if the stored value is not JSON. */
  async getJson<T = unknown>(key: string): Promise<T | null> {
    const text = await this.getText(key);
    return text === null ? null : (JSON.parse(text) as T);
  }

  /**
   * Stores a value. Returns once the service has made it durable. With a
   * condition that does not hold, writes nothing and fails with
   * `CONDITION_FAILED`. With `ttlSeconds` or `expiresAt`, the value expires.
   */
  async put(key: string, value: Value, options: PutOptions = {}): Promise<WriteResult> {
    const response = await this.transport.send('PUT', this.path(`/kv/${keyPath(key)}`), {
      query: expiryFields(options),
      body: this.sealed(toBytes(key), toBytes(value)) as BodyInit,
      headers: conditionHeaders(options),
    });
    return (await response.json()) as WriteResult;
  }

  /** Stores a value as JSON text. */
  putJson(key: string, value: unknown, options: PutOptions = {}): Promise<WriteResult> {
    return this.put(key, JSON.stringify(value), options);
  }

  /** Removes a key. Removing a key that is not there is not an error, unless `ifVersion` is given. */
  async delete(key: string, condition: Pick<WriteCondition, 'ifVersion'> = {}): Promise<WriteResult> {
    const response = await this.transport.send('DELETE', this.path(`/kv/${keyPath(key)}`), {
      headers: conditionHeaders(condition),
    });
    return (await response.json()) as WriteResult;
  }

  /**
   * Several puts and deletes as one write: all of them happen or none does.
   * Keys here may be bytes, so this also reaches keys that are not text.
   * With `conditions`, only if every one holds; otherwise nothing is written
   * and it fails with `CONDITION_FAILED`, naming the key in `error.key`.
   */
  async commit(operations: Operation[], options: { conditions?: Condition[] } = {}): Promise<CommitResult> {
    if (operations.length === 0) throw new EdgeKVError('BAD_REQUEST', 'a commit needs at least one operation', 0);
    const ops = operations.map((operation) => {
      const key = toBytes(operation.key);
      return operation.op === 'put'
        ? {
            op: 'put',
            key: toBase64(key),
            value: toBase64(this.sealed(key, toBytes(operation.value))),
            ...expiryFields(operation),
          }
        : { op: 'delete', key: toBase64(key) };
    });
    const conditions = options.conditions?.map((c) => ({ key: toBase64(toBytes(c.key)), version: c.version }));
    const response = await this.transport.send('POST', this.path('/commit'), {
      json: conditions?.length ? { ops, conditions } : { ops },
    });
    return (await response.json()) as CommitResult;
  }

  /**
   * Reads a key, computes its new value with `change`, and writes it back if
   * nobody else wrote the key in between, reading and trying again if they
   * did. Use it for counters, stock levels and anything else a plain put
   * would lose updates to. Returns `null` when nothing was written (there was
   * no value and `change` returned `null`).
   */
  async update(key: string, change: Change): Promise<WriteResult | null> {
    for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt += 1) {
      const current = await this.getVersioned(key);
      const next = await change(current?.value ?? null);
      try {
        if (next !== null) return await this.put(key, next, current ? { ifVersion: current.version } : { ifAbsent: true });
        if (current === null) return null;
        return await this.delete(key, { ifVersion: current.version });
      } catch (error) {
        if (!(error instanceof EdgeKVError) || error.code !== 'CONDITION_FAILED') throw error;
      }
    }
    throw new EdgeKVError('CONDITION_FAILED', `${key} kept changing: gave up after ${UPDATE_ATTEMPTS} attempts`, 412, toBytes(key));
  }

  /**
   * Mints an access token for this database, to give to an app on a user's
   * device instead of an API key. Call it on your backend, with an API key.
   */
  async createToken(options: TokenOptions = {}): Promise<Token> {
    const response = await this.transport.send('POST', this.path('/tokens'), {
      json: { scope: options.scope, ttl_seconds: options.ttlSeconds, subject: options.subject },
    });
    const body = (await response.json()) as { token: string; scope: Token['scope']; expires_at: string };
    return { token: body.token, scope: body.scope, expiresAt: body.expires_at };
  }

  /** One page of entries in key order. Most callers want `scan`. */
  async scanPage(options: ScanOptions & { pageToken?: string } = {}): Promise<Page<Entry>> {
    const response = await this.transport.send('GET', this.path('/kv'), {
      query: { prefix: options.prefix, limit: options.pageSize, page_token: options.pageToken },
    });
    const page = (await response.json()) as {
      items: { key: string; value: string; version?: string; expires_at?: string }[];
      next_page_token: string | null;
    };
    return {
      items: page.items.map((item) => {
        const keyBytes = fromBase64(item.key);
        const value = this.opened(keyBytes, fromBase64(item.value));
        const entry: Entry = { key: decoder.decode(keyBytes), keyBytes, value };
        if (item.version !== undefined) entry.version = item.version;
        if (item.expires_at !== undefined) entry.expiresAt = new Date(item.expires_at);
        return entry;
      }),
      nextPageToken: page.next_page_token,
    };
  }

  /** Every entry in key order, fetched a page at a time as the loop goes. */
  async *scan(options: ScanOptions = {}): AsyncGenerator<Entry, void, void> {
    let pageToken: string | undefined;
    do {
      const page = await this.scanPage({ ...options, pageToken });
      yield* page.items;
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken !== undefined);
  }

  /** Where the database's log ends now. */
  async head(): Promise<Head> {
    return (await (await this.transport.send('GET', this.path('/head'))).json()) as Head;
  }

  /**
   * Waits until something is written after `afterLsn`, or until `timeoutMs`
   * passes (at most 30 000, which is also the default). Returns the head
   * either way: compare its `lsn` with `afterLsn` to tell which happened.
   */
  async waitForChange(afterLsn: number, timeoutMs = 30_000): Promise<Head> {
    const wait = Math.min(Math.max(timeoutMs, 0), 30_000);
    const response = await this.transport.send('GET', this.path('/head'), {
      query: { wait_after: afterLsn, timeout_ms: wait },
      // The request itself must outlast the wait it asks for.
      timeoutMs: wait + 10_000,
    });
    return (await response.json()) as Head;
  }
}

interface RawDatabase {
  id: string;
  region: string;
  status: DatabaseInfo['status'];
  status_reason: string | null;
  created_at: string;
  spec: { name: string };
  usage?: { stored_bytes: number };
}

const toInfo = (raw: RawDatabase): DatabaseInfo => ({
  id: raw.id,
  name: raw.spec.name,
  region: raw.region,
  status: raw.status,
  statusReason: raw.status_reason,
  createdAt: raw.created_at,
  ...(raw.usage ? { storedBytes: raw.usage.stored_bytes } : {}),
});

/** Creating, listing and deleting databases. Needs a key that may manage databases. */
export class Databases {
  /** @internal */
  constructor(private readonly transport: () => Transport) {}

  /** One page of the account's databases, oldest first. Most callers want `list`. */
  async listPage(options: { pageSize?: number; pageToken?: string } = {}): Promise<Page<DatabaseInfo>> {
    const response = await this.transport().send('GET', '/v1/databases', {
      query: { limit: options.pageSize, page_token: options.pageToken },
    });
    const page = (await response.json()) as { items: RawDatabase[]; next_page_token: string | null };
    return { items: page.items.map(toInfo), nextPageToken: page.next_page_token };
  }

  /** Every database in the account. */
  async *list(): AsyncGenerator<DatabaseInfo, void, void> {
    let pageToken: string | undefined;
    do {
      const page = await this.listPage({ pageToken });
      yield* page.items;
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken !== undefined);
  }

  /**
   * Creates a database. The name is 2 to 48 characters: lowercase letters,
   * digits and `-`, starting with a letter. It cannot be changed later.
   */
  async create(options: { name: string; region: string }): Promise<DatabaseInfo> {
    const response = await this.transport().send('POST', '/v1/databases', { json: options });
    return toInfo((await response.json()) as RawDatabase);
  }

  /** One database, with its stored size. */
  async get(id: string): Promise<DatabaseInfo> {
    const response = await this.transport().send('GET', `/v1/databases/${encodeURIComponent(id)}`);
    return toInfo((await response.json()) as RawDatabase);
  }

  /**
   * Deletes a database and all its data. This cannot be undone. The call
   * returns at once; the data is removed in the background.
   */
  async delete(id: string): Promise<void> {
    await this.transport().send('DELETE', `/v1/databases/${encodeURIComponent(id)}`);
  }

  /** Hour-by-hour usage for the last seven days. */
  async usage(id: string): Promise<UsageHour[]> {
    const response = await this.transport().send('GET', `/v1/databases/${encodeURIComponent(id)}/usage`);
    const body = (await response.json()) as {
      items: { hour: string; stored_bytes: number; ops_written: number; bytes_served: number }[];
    };
    return body.items.map((item) => ({
      hour: item.hour,
      storedBytes: item.stored_bytes,
      opsWritten: item.ops_written,
      bytesServed: item.bytes_served,
    }));
  }
}

/** The client. Create one and keep it: it holds no connection and is cheap. */
export class EdgeKV {
  private readonly data: Transport;
  private readonly control?: Transport;
  /** Creating, listing and deleting databases. Needs `controlUrl` and a key that may manage databases. */
  readonly databases: Databases;

  private readonly tokens?: TokenSource;
  /** Each database's token, shared by every `Database` for it. */
  private readonly credentials = new Map<string, TokenCredential>();

  constructor(options: EdgeKVOptions) {
    if ((options.apiKey === undefined) === (options.tokens === undefined)) {
      throw new EdgeKVError('BAD_REQUEST', 'give apiKey (on a server) or tokens (in an app), not both and not neither', 0);
    }
    if (options.apiKey !== undefined && !options.apiKey.startsWith('ekv_')) {
      throw new EdgeKVError('BAD_REQUEST', 'apiKey must be an API key from the portal: ekv_…', 0);
    }
    if (options.tokens !== undefined && typeof options.tokens !== 'function') {
      throw new EdgeKVError('BAD_REQUEST', 'tokens must be a function that returns a token for a database name', 0);
    }
    if (!options.url) throw new EdgeKVError('BAD_REQUEST', 'url is required: where the data API is', 0);
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) throw new EdgeKVError('BAD_REQUEST', 'this runtime has no fetch; pass one in options.fetch', 0);
    const timeoutMs = options.timeoutMs ?? 15_000;
    const retries = options.retries ?? 3;
    // With tokens there is no account-wide credential: `database` gives each its own.
    const credential = apiKeyCredential(options.apiKey ?? '');
    const make = (base: string) => new Transport(base, credential, timeoutMs, retries, fetchImpl.bind(globalThis));
    this.tokens = options.tokens;
    this.data = make(options.url);
    this.control = options.controlUrl && options.apiKey !== undefined ? make(options.controlUrl) : undefined;
    this.databases = new Databases(() => this.requireControl());
  }

  private requireControl(): Transport {
    if (this.tokens) {
      throw new EdgeKVError('BAD_REQUEST', 'managing databases needs an API key; an access token works for one database only', 0);
    }
    if (!this.control) {
      throw new EdgeKVError('BAD_REQUEST', 'managing databases needs controlUrl in the options', 0);
    }
    return this.control;
  }

  /**
   * A database by name. Makes no request: a wrong name shows up as
   * `NOT_FOUND` on first use. With `encryptionKey`, values are encrypted
   * before they leave this process.
   */
  database(name: string, options: DatabaseOptions = {}): Database {
    let cipher: ValueCipher | undefined;
    if (options.encryptionKey !== undefined) {
      try {
        cipher = new ValueCipher(options.encryptionKey, name);
      } catch (error) {
        throw new EdgeKVError('BAD_REQUEST', (error as Error).message, 0);
      }
    }
    if (!this.tokens) return new Database(this.data, name, cipher);
    let credential = this.credentials.get(name);
    if (!credential) {
      credential = new TokenCredential(this.tokens, name);
      this.credentials.set(name, credential);
    }
    return new Database(this.data.with(credential), name, cipher);
  }

  /** Regions a database can be created in. */
  async regions(): Promise<string[]> {
    const response = await this.requireControl().send('GET', '/v1/regions');
    return ((await response.json()) as { items: { region: string }[] }).items.map((item) => item.region);
  }
}

export { LocalEdgeKV, LocalDatabase, LocalWatch } from './local.js';
export type {
  ChangeEvent,
  Durability,
  LocalOptions,
  LocalDatabaseOptions,
  LocalWriteResult,
  LocalScanOptions,
  LocalStatus,
  WriteEvent,
} from './local.js';
export { PLATFORMS } from './native.js';
