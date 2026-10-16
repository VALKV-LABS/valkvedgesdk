/**
 * The local mode: a copy of each database on this machine, kept by the
 * valkvedge library compiled for this platform.
 *
 * Reads come from local disk and never touch the network. With `url` and
 * `apiKey` (or `tokens`) the local copy follows a database in the service:
 * sync writes return once the service has stored them, buffered writes return
 * at once, work offline, and are pushed in the background. Without them the
 * databases exist only on this machine.
 *
 * Needs Node.js 18 or later, Bun or Deno, on a platform in `PLATFORMS`.
 */

import {
  EdgeKVError,
  UPDATE_ATTEMPTS,
  type Change,
  type Condition,
  type Entry,
  type Operation,
  type Page,
  type TokenSource,
  type Value,
  type Versioned,
  type WriteCondition,
} from './index.js';
import { loadNative, type NativeDb, type NativeKv, type NativeWatch } from './native.js';

/** `'sync'`: return once the write is stored durably. `'buffered'`: return once it is on local disk. */
export type Durability = 'sync' | 'buffered';

export interface LocalOptions {
  /** The directory the local copies are kept in. Created if missing. */
  path: string;
  /** Where the data API is. With `apiKey` or `tokens`, the local copies follow the service. */
  url?: string;
  /** An API key from the portal: `ekv_…`. For your servers. */
  apiKey?: string;
  /**
   * For apps on your users' devices, which must not hold an API key: where
   * to get an access token for each database. Called when a database first
   * reaches the service, about a minute before its token expires, and when
   * the service refuses it.
   */
  tokens?: TokenSource;
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
  /** The version each operation gave its key, in order. */
  versions: string[];
}

/**
 * A change reported by `watch`. `'changed'`: one key now has `value`
 * (`null`: none). `'reset'`: any key may have changed, for example after the
 * local copy was reloaded from the service; read again whatever you show.
 */
export type ChangeEvent =
  | { type: 'changed'; key: string; keyBytes: Uint8Array; value: Uint8Array | null }
  | { type: 'reset' };

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

function conditionsFor(key: Value, condition: WriteCondition): Condition[] | undefined {
  if (condition.ifVersion !== undefined && condition.ifAbsent) {
    throw new EdgeKVError('BAD_REQUEST', 'give ifVersion or ifAbsent, not both', 0);
  }
  if (condition.ifVersion !== undefined) return [{ key, version: condition.ifVersion }];
  return condition.ifAbsent ? [{ key, version: null }] : undefined;
}

/** A directory of local databases. Open one with `LocalEdgeKV.open` and keep it. */
export class LocalEdgeKV {
  private constructor(private readonly native: NativeKv) {}

  /** Opens the directory. Makes no request: the service is first reached when a database opens. */
  static async open(options: LocalOptions): Promise<LocalEdgeKV> {
    if (!options.path) throw new EdgeKVError('BAD_REQUEST', 'path is required: the directory for the local copies', 0);
    const { path, url, apiKey, tokens, maxOpenDatabases } = options;
    if (apiKey !== undefined && tokens !== undefined) {
      throw new EdgeKVError('BAD_REQUEST', 'give apiKey (on a server) or tokens (in an app), not both', 0);
    }
    if ((url === undefined) !== (apiKey === undefined && tokens === undefined)) {
      throw new EdgeKVError(
        'BAD_REQUEST',
        'url goes with apiKey or tokens: give them to follow the service, neither for local only',
        0,
      );
    }
    if (apiKey !== undefined && !apiKey.startsWith('ekv_')) {
      throw new EdgeKVError('BAD_REQUEST', 'apiKey must be an API key from the portal: ekv_…', 0);
    }
    if (tokens !== undefined && typeof tokens !== 'function') {
      throw new EdgeKVError('BAD_REQUEST', 'tokens must be a function that returns a token for a database name', 0);
    }
    const native = await loadNative();
    if (tokens !== undefined) {
      // The native side always awaits what the source returns, so hand it a promise.
      const source = async (database: string) => tokens(database);
      return new LocalEdgeKV(call(() => native.openKvWithTokens({ path, url, maxOpenDatabases }, source)));
    }
    return new LocalEdgeKV(await callAsync(() => native.openKv({ path, url, apiKey, maxOpenDatabases })));
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

  /** The value stored under `key` and its version, or `null` if there is none. Read from local disk. */
  async getVersioned(key: Value): Promise<Versioned | null> {
    const found = call(() => this.native.getVersioned(buf(key)));
    return found ? { value: bytes(found.value), version: found.version } : null;
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

  /**
   * Stores a value. With `ifVersion` or `ifAbsent`, only if the key is still
   * at that version or has no value; otherwise nothing is written and it
   * fails with `CONDITION_FAILED`. With a service, conditions need a sync
   * write.
   */
  async put(key: Value, value: Value, options: { durability?: Durability } & WriteCondition = {}): Promise<LocalWriteResult> {
    return this.commit([{ op: 'put', key, value }], { durability: options.durability, conditions: conditionsFor(key, options) });
  }

  /** Stores a value as JSON text. */
  putJson(key: Value, value: unknown, options: { durability?: Durability } & WriteCondition = {}): Promise<LocalWriteResult> {
    return this.put(key, JSON.stringify(value), options);
  }

  /** Removes a key. Removing a key that is not there is not an error, unless `ifVersion` is given. */
  async delete(key: Value, options: { durability?: Durability } & Pick<WriteCondition, 'ifVersion'> = {}): Promise<LocalWriteResult> {
    return this.commit([{ op: 'delete', key }], { durability: options.durability, conditions: conditionsFor(key, options) });
  }

  /**
   * Several puts and deletes as one write: all of them happen or none does.
   * With `conditions`, only if every one holds (with a service, as a sync
   * write only); otherwise nothing is written and it fails with
   * `CONDITION_FAILED`.
   */
  async commit(
    operations: Operation[],
    options: { durability?: Durability; conditions?: Condition[] } = {},
  ): Promise<LocalWriteResult> {
    if (operations.length === 0) throw new EdgeKVError('BAD_REQUEST', 'a commit needs at least one operation', 0);
    const ops = operations.map((operation) =>
      operation.op === 'put'
        ? { delete: false, key: buf(operation.key), value: buf(operation.value) }
        : { delete: true, key: buf(operation.key) },
    );
    // The native side takes a missing version, not `null`, for "no value".
    const conditions = options.conditions?.map((c) => ({ key: buf(c.key), version: c.version ?? undefined }));
    const result = await callAsync(() => this.native.commit(ops, options.durability, conditions));
    return { lsn: result.lsn ?? null, outboxSeq: result.outboxSeq ?? null, versions: result.versions };
  }

  /**
   * Reads a key, computes its new value with `change`, and writes it back
   * (a sync write) if nobody else wrote the key in between, catching up and
   * trying again if they did. Use it for counters, stock levels and anything
   * else a plain put would lose updates to. Returns `null` when nothing was
   * written (there was no value and `change` returned `null`).
   */
  async update(key: Value, change: Change): Promise<LocalWriteResult | null> {
    // A buffered write to the key not yet pushed would make every check fail until it is.
    if (this.status().outboxEntries > 0) await this.flush();
    for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt += 1) {
      const current = await this.getVersioned(key);
      const next = await change(current?.value ?? null);
      const condition = current ? { ifVersion: current.version } : { ifAbsent: true };
      try {
        if (next !== null) return await this.put(key, next, { durability: 'sync', ...condition });
        if (current === null) return null;
        return await this.delete(key, { durability: 'sync', ifVersion: current.version });
      } catch (error) {
        if (!(error instanceof EdgeKVError) || error.code !== 'CONDITION_FAILED') throw error;
      }
      // Someone else wrote the key: bring the local copy up to date before reading it again.
      await this.sync();
    }
    throw new EdgeKVError('CONDITION_FAILED', `the key kept changing: gave up after ${UPDATE_ATTEMPTS} attempts`, 0);
  }

  /**
   * Reports changes to keys under `prefix` (every key when it is empty) as
   * they reach the local copy: this process's writes, writes pulled from the
   * service, and buffered writes that lost. Iterate it with `for await`;
   * leaving the loop, or `close()`, ends it. An open watch keeps the process
   * running, so close it when you are done.
   */
  watch(prefix: Value = ''): LocalWatch {
    return new LocalWatch(call(() => this.native.watch(buf(prefix))));
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
   * Pushes buffered writes and pulls what other replicas wrote. Returns the
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

/** Changes under a prefix, from `LocalDatabase.watch`. Iterate it with `for await`. */
export class LocalWatch implements AsyncIterableIterator<ChangeEvent> {
  /** @internal */
  constructor(private readonly native: NativeWatch) {}

  /** The next change. Done once the watch is closed. */
  async next(): Promise<IteratorResult<ChangeEvent, undefined>> {
    const event = await callAsync(() => this.native.next());
    if (event === null) return { done: true, value: undefined };
    if (event.reset) return { done: false, value: { type: 'reset' } };
    const key = event.key!;
    const value = event.value ?? null;
    return {
      done: false,
      value: { type: 'changed', key: decoder.decode(key), keyBytes: bytes(key), value: value && bytes(value) },
    };
  }

  /** Called when a `for await` loop is left early: closes the watch. */
  async return(): Promise<IteratorResult<ChangeEvent, undefined>> {
    this.close();
    return { done: true, value: undefined };
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  /** Stops the watch and lets the process exit. A pending `next` finishes as done. */
  close(): void {
    this.native.close();
  }
}
