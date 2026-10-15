/**
 * Finds and loads the native library behind the local mode.
 *
 * The library is compiled ahead of time for each platform and published as
 * its own package, `@valkv/edgekv-<platform>`. Each is an optional dependency
 * of `@valkv/edgekv` that declares its `os`, `cpu` and `libc`, so the package
 * manager installs only the one for the machine it runs on.
 *
 * Set `EDGEKV_NATIVE_PATH` to a built `.node` file to load that instead, for
 * example while developing the bindings.
 */

import { EdgeKVError } from './index.js';

/** What the native library exposes. Its source is `native/src/lib.rs`. */
export interface NativeBinding {
  openKv(options: { path: string; url?: string; apiKey?: string; maxOpenDatabases?: number }): Promise<NativeKv>;
}

export interface NativeKv {
  database(name: string, options?: { durability?: string; encryptionKey?: Buffer }): Promise<NativeDb>;
  close(): Promise<void>;
}

export interface NativeDb {
  readonly name: string;
  get(key: Buffer): Buffer | null;
  scan(bounds: { prefix?: Buffer; start?: Buffer; end?: Buffer; after?: Buffer; limit?: number }): { key: Buffer; value: Buffer }[];
  commit(ops: { delete: boolean; key: Buffer; value?: Buffer }[], durability?: string): Promise<{ lsn?: number | null; outboxSeq?: number | null }>;
  sync(): Promise<number>;
  flush(): Promise<number>;
  status(): { appliedLsn: number; generation: number; outboxEntries: number; outboxBytes: number; diskBytes: number };
  takeEvents(): { outboxSeq: number; key: Buffer; outcome: string }[];
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
  const name = `@valkv/edgekv-${suffix}`;
  try {
    return require(name) as NativeBinding;
  } catch (error) {
    throw new EdgeKVError(
      'UNSUPPORTED',
      `the local mode needs ${name}, which did not load (${error instanceof Error ? error.message : error}). ` +
        'It is installed with @valkv/edgekv unless optional dependencies were left out: reinstall without --no-optional or --omit=optional',
      0,
    );
  }
}
