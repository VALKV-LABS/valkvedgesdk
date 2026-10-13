/**
 * ValkvEdgeKV client for TypeScript and JavaScript.
 *
 * Talks to the service over HTTPS with an API key. It keeps no local copy:
 * every read and write is a request. (The Rust library is the one that keeps
 * a local replica and works offline.)
 *
 * Needs a runtime with `fetch`: Node 18 or later, Deno, Bun, or a browser.
 */

/** A value to store: bytes, or text, which is stored as UTF-8. */
export type Value = Uint8Array | string;

export interface EdgeKVOptions {
  /** An API key from the portal: `ekv_…`. */
  apiKey: string;
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
}

export interface Entry {
  key: string;
  /** The key as stored, for keys that are not valid UTF-8 text. */
  keyBytes: Uint8Array;
  value: Uint8Array;
}

export type Operation = { op: 'put'; key: Value; value: Value } | { op: 'delete'; key: Value };

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

interface RequestOptions {
  body?: BodyInit;
  json?: unknown;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
}

/** Sends requests to one base URL: adds the key, the timeout and the retries, and turns failures into `EdgeKVError`. */
class Transport {
  constructor(
    private readonly base: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly retries: number,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async send(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const url = new URL(this.base.replace(/\/+$/, '') + path);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}` };
    let body = options.body;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.json);
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.once(method, url, headers, body, options.timeoutMs ?? this.timeoutMs);
      } catch (error) {
        if (!(error instanceof EdgeKVError) || !error.retryable || attempt >= this.retries) throw error;
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
    try {
      const parsed = (await response.json()) as { error?: { code?: string; message?: string } };
      code = parsed.error?.code ?? code;
      message = parsed.error?.message ?? '';
    } catch {
      // Not the service's error shape: a gateway or proxy answered.
    }
    throw new EdgeKVError(code || 'SERVICE_ERROR', message || `the service answered ${response.status}`, response.status);
  }
}

/** One database's contents. Get one from `EdgeKV.database(name)`. */
export class Database {
  /** @internal */
  constructor(
    private readonly transport: Transport,
    /** The database's name within the account. */
    readonly name: string,
  ) {}

  private path(rest: string): string {
    return `/v1/db/${encodeURIComponent(this.name)}${rest}`;
  }

  /** The value stored under `key`, or `null` if there is none. */
  async get(key: string): Promise<Uint8Array | null> {
    try {
      const response = await this.transport.send('GET', this.path(`/kv/${keyPath(key)}`));
      return new Uint8Array(await response.arrayBuffer());
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

  /** Stores a value. Returns once the service has made it durable. */
  async put(key: string, value: Value): Promise<WriteResult> {
    const response = await this.transport.send('PUT', this.path(`/kv/${keyPath(key)}`), { body: toBytes(value) as BodyInit });
    return (await response.json()) as WriteResult;
  }

  /** Stores a value as JSON text. */
  putJson(key: string, value: unknown): Promise<WriteResult> {
    return this.put(key, JSON.stringify(value));
  }

  /** Removes a key. Removing a key that is not there is not an error. */
  async delete(key: string): Promise<WriteResult> {
    const response = await this.transport.send('DELETE', this.path(`/kv/${keyPath(key)}`));
    return (await response.json()) as WriteResult;
  }

  /**
   * Several puts and deletes as one write: all of them happen or none does.
   * Keys here may be bytes, so this also reaches keys that are not text.
   */
  async commit(operations: Operation[]): Promise<WriteResult> {
    if (operations.length === 0) throw new EdgeKVError('BAD_REQUEST', 'a commit needs at least one operation', 0);
    const ops = operations.map((operation) =>
      operation.op === 'put'
        ? { op: 'put', key: toBase64(toBytes(operation.key)), value: toBase64(toBytes(operation.value)) }
        : { op: 'delete', key: toBase64(toBytes(operation.key)) },
    );
    const response = await this.transport.send('POST', this.path('/commit'), { json: { ops } });
    return (await response.json()) as WriteResult;
  }

  /** One page of entries in key order. Most callers want `scan`. */
  async scanPage(options: ScanOptions & { pageToken?: string } = {}): Promise<Page<Entry>> {
    const response = await this.transport.send('GET', this.path('/kv'), {
      query: { prefix: options.prefix, limit: options.pageSize, page_token: options.pageToken },
    });
    const page = (await response.json()) as { items: { key: string; value: string }[]; next_page_token: string | null };
    return {
      items: page.items.map((item) => {
        const keyBytes = fromBase64(item.key);
        return { key: decoder.decode(keyBytes), keyBytes, value: fromBase64(item.value) };
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

  constructor(options: EdgeKVOptions) {
    if (!options.apiKey?.startsWith('ekv_')) {
      throw new EdgeKVError('BAD_REQUEST', 'apiKey must be an API key from the portal: ekv_…', 0);
    }
    if (!options.url) throw new EdgeKVError('BAD_REQUEST', 'url is required: where the data API is', 0);
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) throw new EdgeKVError('BAD_REQUEST', 'this runtime has no fetch; pass one in options.fetch', 0);
    const timeoutMs = options.timeoutMs ?? 15_000;
    const retries = options.retries ?? 3;
    const make = (base: string) => new Transport(base, options.apiKey, timeoutMs, retries, fetchImpl.bind(globalThis));
    this.data = make(options.url);
    this.control = options.controlUrl ? make(options.controlUrl) : undefined;
    this.databases = new Databases(() => this.requireControl());
  }

  private requireControl(): Transport {
    if (!this.control) {
      throw new EdgeKVError('BAD_REQUEST', 'managing databases needs controlUrl in the options', 0);
    }
    return this.control;
  }

  /** A database by name. Makes no request: a wrong name shows up as `NOT_FOUND` on first use. */
  database(name: string): Database {
    return new Database(this.data, name);
  }

  /** Regions a database can be created in. */
  async regions(): Promise<string[]> {
    const response = await this.requireControl().send('GET', '/v1/regions');
    return ((await response.json()) as { items: { region: string }[] }).items.map((item) => item.region);
  }
}
