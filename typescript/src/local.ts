/**
 * The local mode: a copy of each database on this machine, kept by the
 * valkvedge library compiled for this platform.
 *
 * Reads come from local disk and never touch the network. With `url` and
 * `apiKey` the local copy follows a database in the service: sync writes
 * return once the service has stored them, buffered writes return at once,
 * work offline, and are pushed in the background. Without them the databases
 * exist only on this machine.
 *
 * Needs Node.js 18 or later, Bun or Deno, on a platform in `PLATFORMS`.
 */

import { EdgeKVError, type Entry, type Operation, type Page, type Value } from './index.js';
import { loadNative, type NativeDb, type NativeKv } from './native.js';

/** `'sync'`: return once the write is stored durably. `'buffered'`: return once it is on local disk. */
export type Durability = 'sync' | 'buffered';

export interface LocalOptions {
  /** The directory the local copies are kept in. Created if missing. */
  path: string;
  /** Where the data API is. With `apiKey`, the local copies follow the service. */
  url?: string;
  /** An API key from the portal: `ekv_…`. */
  apiKey?: string;
  /** Most databases kept open at once; idle ones reopen on next use. Default 200. */
  maxOpenDatabases?: number;
}

export interface LocalDatabaseOptions {
  /** Used by writes that do not name one. Default `'sync'`. */
  durability?: Durability;
  /**
   * 32 bytes. Values are encrypted with it on this machine, before they are
   * written to disk or sent anywhere: the service only ever holds ciphertext.
   * Keys (the names) are not encrypted. A lost key cannot be recovered.
   */
  encryptionKey?: Uint8Array;
}

export interface LocalWriteResult {
  /** Position of the write in the log, once it reached it. `null` for a buffered write. */
  lsn: number | null;
  /** The write's place in the outbox, for a buffered write. */
  outboxSeq: number | null;
}

export interface LocalScanOptions {
  /** Only keys that start with this. */
  prefix?: Value;
  /** Entries per page, 1 to 1000. Default 200. */
  pageSize?: number;
}

export interface LocalStatus {
  /** Last log position applied to the local copy. */
  appliedLsn: number;
  generation: number;
  /** Buffered batches not yet confirmed by the service. */
  outboxEntries: number;
  outboxBytes: number;
  diskBytes: number;
}

/** A buffered write that did not take effect. */
export interface WriteEvent {
  outboxSeq: number;
  key: string;
  keyBytes: Uint8Array;
  /** `SUPERSEDED`: a newer write to the key won. `CLOCK_SKEW` or `STALE_WRITE`: refused. */
  outcome: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A Node `Buffer` over the same memory: no copy. */
function buf(value: Value): Buffer {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const bytes = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

/** The native library reports `[CODE] message`; anything else is a bug. */
function rethrow(error: unknown): never {
  if (error instanceof EdgeKVError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const match = /^\[([A-Z_]+)\] ([\s\S]*)$/.exec(message);
  throw match ? new EdgeKVError(match[1]!, match[2]!, 0) : new EdgeKVError('INTERNAL', message, 0);
}

function call<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    rethrow(error);
  }
}

async function callAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    rethrow(error);
  }
}

/** A directory of local databases. Open one with `LocalEdgeKV.open` and keep it. */
export class LocalEdgeKV {
  private constructor(private readonly native: NativeKv) {}

  /** Opens the directory. Makes no request: the service is first reached when a database opens. */
  static async open(options: LocalOptions): Promise<LocalEdgeKV> {
    if (!options.path) throw new EdgeKVError('BAD_REQUEST', 'path is required: the directory for the local copies', 0);
    if ((options.url === undefined) !== (options.apiKey === undefined)) {
      throw new EdgeKVError('BAD_REQUEST', 'url and apiKey go together: both to follow the service, neither for local only', 0);
    }
    if (options.apiKey !== undefined && !options.apiKey.startsWith('ekv_')) {
      throw new EdgeKVError('BAD_REQUEST', 'apiKey must be an API key from the portal: ekv_…', 0);
    }
    const native = await loadNative();
    return new LocalEdgeKV(
      await callAsync(() =>
        native.openKv({ path: options.path, url: options.url, apiKey: options.apiKey, maxOpenDatabases: options.maxOpenDatabases }),
      ),
    );
  }

  /**
   * Opens a database: `name`, or `namespace/name` for a database local to
   * this machine. A local copy already on disk opens without the network; a
   * database that follows the service and has no local copy downloads one.
   */
  async database(name: string, options: LocalDatabaseOptions = {}): Promise<LocalDatabase> {
    const { durability, encryptionKey } = options;
    if (encryptionKey !== undefined && encryptionKey.byteLength !== 32) {
      throw new EdgeKVError('BAD_REQUEST', `encryptionKey must be 32 bytes, not ${encryptionKey.byteLength}`, 0);
    }
    const db = await callAsync(() =>
      this.native.database(name, { durability, encryptionKey: encryptionKey && buf(encryptionKey) }),
    );
    return new LocalDatabase(db);
  }

  /**
   * Closes every database not in use. Call before the process exits.
   * Buffered writes not yet pushed stay on disk and are pushed next time.
   */
  close(): Promise<void> {
    return callAsync(() => this.native.close());
  }
}

/** One database's local copy. Get one from `LocalEdgeKV.database(name)`. */
export class LocalDatabase {
  /** @internal */
  constructor(private readonly native: NativeDb) {}

  /** The database's name. */
  get name(): string {
    return this.native.name;
  }

  /** The value stored under `key`, or `null` if there is none. Read from local disk. */
  async get(key: Value): Promise<Uint8Array | null> {
    const value = call(() => this.native.get(buf(key)));
    return value === null || value === undefined ? null : bytes(value);
  }

  /** The value as text, or `null`. */
  async getText(key: Value): Promise<string | null> {
    const value = await this.get(key);
    return value === null ? null : decoder.decode(value);
  }

  /** The value parsed as JSON, or `null`. Throws if the stored value is not JSON. */
  async getJson<T = unknown>(key: Value): Promise<T | null> {
    const text = await this.getText(key);
    return text === null ? null : (JSON.parse(text) as T);
  }

  /** Stores a value. */
  put(key: Value, value: Value, options: { durability?: Durability } = {}): Promise<LocalWriteResult> {
    return this.commit([{ op: 'put', key, value }], options);
  }

  /** Stores a value as JSON text. */
  putJson(key: Value, value: unknown, options: { durability?: Durability } = {}): Promise<LocalWriteResult> {
    return this.put(key, JSON.stringify(value), options);
  }

  /** Removes a key. Removing a key that is not there is not an error. */
  delete(key: Value, options: { durability?: Durability } = {}): Promise<LocalWriteResult> {
    return this.commit([{ op: 'delete', key }], options);
  }

  /** Several puts and deletes as one write: all of them happen or none does. */
  async commit(operations: Operation[], options: { durability?: Durability } = {}): Promise<LocalWriteResult> {
    if (operations.length === 0) throw new EdgeKVError('BAD_REQUEST', 'a commit needs at least one operation', 0);
    const ops = operations.map((operation) =>
      operation.op === 'put'
        ? { delete: false, key: buf(operation.key), value: buf(operation.value) }
        : { delete: true, key: buf(operation.key) },
    );
    const result = await callAsync(() => this.native.commit(ops, options.durability));
    return { lsn: result.lsn ?? null, outboxSeq: result.outboxSeq ?? null };
  }

  /** One page of entries in key order. Most callers want `scan`. */
  async scanPage(options: LocalScanOptions & { pageToken?: string } = {}): Promise<Page<Entry>> {
    const limit = options.pageSize ?? 200;
    const page = call(() =>
      this.native.scan({
        prefix: options.prefix === undefined ? undefined : buf(options.prefix),
        after: options.pageToken === undefined ? undefined : Buffer.from(options.pageToken, 'base64url'),
        limit,
      }),
    );
    const last = page.length === limit ? page[page.length - 1] : undefined;
    return {
      items: page.map((entry) => ({ key: decoder.decode(entry.key), keyBytes: bytes(entry.key), value: bytes(entry.value) })),
      nextPageToken: last ? last.key.toString('base64url') : null,
    };
  }

  /** Every entry in key order, read from local disk a page at a time. */
  async *scan(options: LocalScanOptions = {}): AsyncGenerator<Entry, void, void> {
    let pageToken: string | undefined;
    do {
      const page = await this.scanPage({ ...options, pageToken });
      yield* page.items;
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken !== undefined);
  }

  /**
   * Pushes buffered writes and pulls what other devices wrote. Returns the
   * local copy's log position. This also happens in the background, about
   * once a second; call it when you need it now.
   */
  sync(): Promise<number> {
    return callAsync(() => this.native.sync());
  }

  /** Pushes buffered writes now. Returns how many batches were settled. */
  flush(): Promise<number> {
    return callAsync(() => this.native.flush());
  }

  /** The local copy: log position, outbox depth, disk use. */
  status(): LocalStatus {
    return call(() => this.native.status());
  }

  /**
   * Returns and clears the buffered writes that did not take effect since the
   * last call: a newer write to the same key won, or the write was refused.
   */
  takeEvents(): WriteEvent[] {
    return call(() => this.native.takeEvents()).map((event) => ({
      outboxSeq: event.outboxSeq,
      key: decoder.decode(event.key),
      keyBytes: bytes(event.key),
      outcome: event.outcome,
    }));
  }
}
