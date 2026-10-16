/**
 * Finds and loads the native library behind the local mode.
 *
 * The library is compiled ahead of time for each platform and published as
 * its own package, `@valkvlabs/edgekv-<platform>`. Each is an optional dependency
 * of `@valkvlabs/edgekv` that declares its `os`, `cpu` and `libc`, so the package
 * manager installs only the one for the machine it runs on.
 *
 * Set `EDGEKV_NATIVE_PATH` to a built `.node` file to load that instead, for
 * example while developing the bindings.
 */

import { EdgeKVError } from './index.js';

/** What the native library exposes. Its source is `native/src/lib.rs`. */
export interface NativeBinding {
  openKv(options: NativeOpenOptions): Promise<NativeKv>;
  /** `tokens` is called with a database name and must return a promise. */
  openKvWithTokens(options: NativeOpenOptions, tokens: (database: string) => Promise<string>): NativeKv;
}

export interface NativeOpenOptions {
  path: string;
  url?: string;
  apiKey?: string;
  maxOpenDatabases?: number;
}

export interface NativeKv {
  database(name: string, options?: { durability?: string; encryptionKey?: Buffer; ingest?: boolean }): Promise<NativeDb>;
  close(): Promise<void>;
}

export interface NativeDb {
  readonly name: string;
  get(key: Buffer): Buffer | null;
  getVersioned(key: Buffer): { value: Buffer; version: string } | null;
  fetch(key: Buffer): Promise<{ value: Buffer; version: string } | null>;
  fetchPage(
    prefix: Buffer,
    limit: number,
    pageToken?: string,
  ): Promise<{ entries: { key: Buffer; value: Buffer }[]; nextPageToken?: string | null }>;
  watch(prefix: Buffer): NativeWatch;
  scan(bounds: { prefix?: Buffer; start?: Buffer; end?: Buffer; after?: Buffer; limit?: number }): { key: Buffer; value: Buffer }[];
  commit(
    ops: { delete: boolean; key: Buffer; value?: Buffer }[],
    durability?: string,
    conditions?: { key: Buffer; version?: string }[],
  ): Promise<{ lsn?: number | null; outboxSeq?: number | null; versions: string[] }>;
  sync(): Promise<number>;
  flush(): Promise<number>;
  status(): { appliedLsn: number; generation: number; outboxEntries: number; outboxBytes: number; diskBytes: number };
  takeEvents(): { outboxSeq: number; key: Buffer; outcome: string }[];
}

export interface NativeWatch {
  /** The next change, or `null` once closed. */
  next(): Promise<{ reset: boolean; key?: Buffer | null; value?: Buffer | null } | null>;
  close(): void;
}

/** The platforms a native library is published for, by package suffix. */
export const PLATFORMS: readonly string[] = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64-gnu',
  'linux-arm64-musl',
  'linux-x64-gnu',
  'linux-x64-musl',
  'win32-x64-msvc',
];

/** The package suffix for this machine, or `null` when none is published. */
export function platformSuffix(platform: string, arch: string, musl: boolean): string | null {
  const suffix =
    platform === 'linux' ? `linux-${arch}-${musl ? 'musl' : 'gnu'}` : platform === 'win32' ? `win32-${arch}-msvc` : `${platform}-${arch}`;
  return PLATFORMS.includes(suffix) ? suffix : null;
}

function isMusl(): boolean {
  if (process.platform !== 'linux') return false;
  // glibc reports its version here; musl does not.
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return !report?.header?.glibcVersionRuntime;
}

let loading: Promise<NativeBinding> | undefined;

/** Loads the native library once. Fails with `UNSUPPORTED` where there is none. */
export function loadNative(): Promise<NativeBinding> {
  loading ??= load();
  return loading;
}

async function load(): Promise<NativeBinding> {
  if (typeof process === 'undefined' || !process.versions?.node) {
    throw new EdgeKVError('UNSUPPORTED', 'the local mode needs Node.js (or Bun or Deno); in a browser use EdgeKV', 0);
  }
  // Imported here, not at the top, so the remote client still loads in browsers.
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const override = process.env.EDGEKV_NATIVE_PATH;
  if (override) {
    const { resolve } = await import('node:path');
    return require(resolve(override)) as NativeBinding;
  }
  const suffix = platformSuffix(process.platform, process.arch, isMusl());
  if (suffix === null) {
    throw new EdgeKVError(
      'UNSUPPORTED',
      `the local mode has no build for ${process.platform}-${process.arch}; EdgeKV (no local copy) works everywhere`,
      0,
    );
  }
  const name = `@valkvlabs/edgekv-${suffix}`;
  try {
    return require(name) as NativeBinding;
  } catch (error) {
    throw new EdgeKVError(
      'UNSUPPORTED',
      `the local mode needs ${name}, which did not load (${error instanceof Error ? error.message : error}). ` +
        'It is installed with @valkvlabs/edgekv unless optional dependencies were left out: reinstall without --no-optional or --omit=optional',
      0,
    );
  }
}
