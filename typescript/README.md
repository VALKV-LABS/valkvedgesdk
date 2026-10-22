# @valkvlabs/edgekv for TypeScript and JavaScript

A client for ValkvEdgeKV, in two modes:

| | `EdgeKV` | `LocalEdgeKV` |
|---|---|---|
| Local copy | None: every read and write is a request | On this machine's disk |
| Reads | Over HTTPS | Local, no network |
| Writes | Over HTTPS | Stored by the service (`sync`), or on disk at once and pushed later (`buffered`, works offline) |
| Encryption | Values encrypted in this process before they are sent | Values encrypted on this machine before they leave it |
| Runs on | Anywhere `fetch` exists: Node 18+, Deno, Bun, browsers | Node 18+, Bun, Deno on macOS, Linux and Windows (below) |

```sh
npm install @valkvlabs/edgekv
```

That one install has both. The local mode runs the valkvedge library, compiled ahead of
time for each platform: npm installs only the build for your machine, and nothing needs
Rust or a compiler.

**Not published to npm yet.** Build it from this folder: `make ts-test` in the
repository root type-checks, tests and builds it into `dist/`.

## Use, with no local copy

```ts
import { EdgeKV } from '@valkvlabs/edgekv'

const kv = new EdgeKV({
  apiKey: process.env.EDGEKV_API_KEY!,   // ekv_…, from the portal
  url: 'https://api.example.com',
})
const db = kv.database('orders')

await db.put('order/1001', JSON.stringify({ total: 42 }))
await db.putJson('order/1002', { total: 17 })

const order = await db.getJson<{ total: number }>('order/1001')   // null if there is none
const raw = await db.get('order/1001')                            // Uint8Array | null

await db.delete('order/1001')
```

Values are bytes. Text you pass is stored as UTF-8; `getText` and `getJson` read it
back.

### Several changes as one

```ts
await db.commit([
  { op: 'put', key: 'stock/widget', value: '9' },
  { op: 'put', key: 'order/1003', value: JSON.stringify({ item: 'widget' }) },
  { op: 'delete', key: 'cart/77' },
])
```

All of them happen or none does.

### Writing only if nothing changed

Every value has a version that changes with each write. A write can require the key
to still be at the version you read, so two clients updating the same counter or stock
level never overwrite each other:

```ts
const current = await db.getVersioned('stock/widget')    // { value, version } or null
await db.put('stock/widget', '8', { ifVersion: current!.version })
await db.put('order/1004', '{}', { ifAbsent: true })      // create, never overwrite
await db.commit(operations, { conditions: [{ key: 'stock/widget', version: current!.version }] })
```

If a condition does not hold, nothing is written and the call fails with
`CONDITION_FAILED` (`error.key` names the key). `update` does the read, the change and
the retry for you:

```ts
await db.update('stock/widget', (value) => String(Number(new TextDecoder().decode(value!)) - 1))
```

Your function gets the current value (`null` if there is none) and returns the new one
(`null` deletes the key). It may run more than once, so keep it free of side effects.

### Values that expire

```ts
await db.put('session/42', token, { ttlSeconds: 3600 })        // gone in an hour
await db.put('code/7', '123456', { expiresAt: new Date(Date.now() + 300_000) })
await db.commit([{ op: 'put', key: 'otp/1', value: 'x', ttlSeconds: 60 }])
(await db.getVersioned('session/42'))?.expiresAt               // a Date
```

Once its time has passed the key reads as not there, and the service then deletes it.
A later put without `ttlSeconds` or `expiresAt` keeps the value for good. The time is
stored beside the value, not encrypted with it. The local mode does not take a lifetime
yet.

### Reading many keys

```ts
for await (const entry of db.scan({ prefix: 'order/' })) {
  console.log(entry.key, new TextDecoder().decode(entry.value))
}
```

Entries come back in key order, fetched a page at a time as the loop runs. `scanPage`
gives you one page and a token for the next, if you would rather drive it yourself.

### Encrypting values

```ts
// 32 bytes, or 64 hexadecimal characters (openssl rand -hex 32). Keep it safe: it cannot be recovered.
const vault = kv.database('vault', { encryptionKey: process.env.VAULT_KEY! })

await vault.putJson('patient/7', { diagnosis: 'asthma' })   // the service receives ciphertext
const record = await vault.getJson('patient/7')             // decrypted here
```

With `encryptionKey`, values are encrypted in this process with ChaCha20-Poly1305
before they are sent, and decrypted when read: `get`, `scan`, `put`, `commit` and
`update` all work as before, and the service only ever stores ciphertext. Without it,
values are sent as they are. Key names, value sizes and timestamps are not encrypted, so
keep secrets out of key names. Each value grows by `ENCRYPTION_OVERHEAD` (28 bytes).

The format is the one the local mode and the Rust library use: a `LocalEdgeKV`
replica opened with the same key reads these values, and this reads theirs.

Choose per database, not per write: a database is either encrypted, always with the
same key, or not at all. Reading a value written without the key, or with another key,
fails with `INVALID_ENCRYPTION_KEY`.

### Waiting for changes

```ts
let { lsn } = await db.head()
for (;;) {
  const head = await db.waitForChange(lsn)   // returns on a write, or after 30 s
  if (head.lsn > lsn) {
    lsn = head.lsn
    // something changed: read what you need
  }
}
```

A database allows a limited number of clients to wait at once. Past it, the call fails
with `TOO_MANY_CONNECTIONS`; fall back to calling `head()` on a timer.

## Managing databases

With an API key that was created with "Can create and delete databases", and the
address where databases are managed:

```ts
const kv = new EdgeKV({
  apiKey: process.env.EDGEKV_API_KEY!,
  url: 'https://api.example.com',
  controlUrl: 'https://cp.example.com',
})

const [region] = await kv.regions()
const created = await kv.databases.create({ name: 'orders', region })

for await (const database of kv.databases.list()) console.log(database.name, database.status)

const { storedBytes } = await kv.databases.get(created.id)
await kv.databases.delete(created.id)   // deletes all its data; cannot be undone
```

A database can be used on the data API a moment after it is created. Until then,
requests for it fail with `NOT_FOUND`.

Give such a key to tools you run yourself. An application you ship to other people
should not carry an API key at all: see the next section.

## Apps on your users' devices

Anyone can take an API key out of an app, so keep keys on your servers. Your backend,
which knows who the user is, mints a short-lived token for that user's database:

```ts
// On your backend, with the API key
const { token, expiresAt } = await kv.database(`notes-${userId}`).createToken({
  scope: 'write',          // or 'read', the default
  ttlSeconds: 3600,        // 60 to 86 400
  subject: userId,         // your own name for the user, kept in the token
})
```

The app gets tokens from your backend instead of holding a key:

```ts
// In the app
const kv = new EdgeKV({
  url: 'https://api.example.com',
  tokens: async (database) => (await fetch(`/my-backend/edgekv-token?db=${database}`)).text(),
})
await kv.database(`notes-${userId}`).put('note/1', 'hello')
```

The client asks for a token the first time it uses a database, again about a minute
before the token expires, and whenever the service refuses it (`TOKEN_EXPIRED`), and
then repeats the request once. A token works for its one database only, cannot mint
tokens or manage databases, and stops working when the key that minted it is revoked.
`LocalEdgeKV.open` takes `tokens` in the same way.

## Use, with a local copy

```ts
import { LocalEdgeKV } from '@valkvlabs/edgekv'

const kv = await LocalEdgeKV.open({
  path: './data/kv',                     // where the local copies live
  url: 'https://api.example.com',
  apiKey: process.env.EDGEKV_API_KEY!,
})
const db = await kv.database('orders')   // downloads a copy the first time

await db.putJson('order/1001', { total: 42 })                       // returns once the service has it
await db.put('draft/7', 'unsent', { durability: 'buffered' })       // returns at once; works offline

const order = await db.getJson<{ total: number }>('order/1001')     // from local disk
for await (const entry of db.scan({ prefix: 'order/' })) console.log(entry.key)

await kv.close()                         // before the process exits
```

The methods are the ones `EdgeKV` has, with the same names: `get`, `getText`, `getJson`,
`getVersioned`, `put`, `putJson`, `delete`, `commit`, `update`, `scan`, `scanPage`.
Writes also take `{ durability }`. Conditions (`ifVersion`, `ifAbsent`, `conditions`,
`update`) need a sync write when the database follows the service; on a buffered write
they fail with `UNSUPPORTED`.

Leave out `url` and `apiKey` for databases that live only on this machine. Names can
then also be `namespace/name`, to keep one user's or one tenant's databases together.

### Writes

- **`sync`** (the default) returns once the service has stored the write. Nothing it
  confirmed is lost if the machine is.
- **`buffered`** returns once the write is on local disk. It is readable at once, works
  without a network, and is pushed to the service in the background within a few
  seconds. It can be lost if the machine is lost before then, and it can lose to a
  newer write of the same key from another replica: the newer write wins, and
  `db.takeEvents()` reports the one that lost.

Set the default for a database with `kv.database(name, { durability: 'buffered' })`.

What other replicas write reaches the local copy in the background, about once a second.
`db.sync()` pushes and pulls now; `db.status()` shows how many buffered writes are still
waiting.

### Following changes

```ts
const watch = db.watch('order/')         // every key when left out
for await (const change of watch) {
  if (change.type === 'reset') reloadEverything()
  else show(change.key, change.value)    // value is null when the key was deleted
}
```

A watch reports each change as it reaches the local copy: this process's writes, writes
pulled from the service, and buffered writes that lost to a newer one. `reset` means any
key may have changed, for example after the copy was reloaded from the service: read
again whatever you show. Leaving the loop closes the watch; so does `watch.close()`. An
open watch keeps the process running.

### Encryption

```ts
const key = crypto.getRandomValues(new Uint8Array(32))   // keep it safe: it cannot be recovered
const vault = await kv.database('vault', { encryptionKey: key })
```

Values are encrypted on this machine, before they are written to disk or sent: the
service only ever holds ciphertext. Key names, value sizes and timestamps are not
encrypted. Opening the database without the key, or with another key, fails with
`INVALID_ENCRYPTION_KEY`. The key is 32 bytes or 64 hexadecimal characters, and an
`EdgeKV` client given the same key reads and writes the same values without a copy
(see *Encrypting values* above).

### Platforms

The local mode is built for:

| | x64 | arm64 |
|---|---|---|
| macOS 11 or later | ✓ | ✓ (Apple Silicon) |
| Linux, glibc 2.17 or later (most distributions) | ✓ | ✓ |
| Linux, musl (Alpine) | ✓ | ✓ |
| Windows | ✓ | |

Each build is its own package, `@valkvlabs/edgekv-<platform>`, which `@valkvlabs/edgekv` lists as an
optional dependency. The package manager installs the one that matches the machine.
Installing with `--no-optional` or `--omit=optional` leaves it out, and then
`LocalEdgeKV.open` fails with `UNSUPPORTED`. `EdgeKV` works either way. A bundler must
leave `@valkvlabs/edgekv` external for the local mode to find its build.

Errors from the local mode are `EdgeKVError`s too, with `status` 0. Besides the codes
below it can report `INVALID_ENCRYPTION_KEY`, `OUTBOX_FULL` (too many buffered writes
waiting to be pushed), `LOCAL_STORE` (the disk) and `UNSUPPORTED`.

## Errors

Every failure is an `EdgeKVError` with a stable `code`, the HTTP `status`, and a message.

```ts
import { EdgeKVError } from '@valkvlabs/edgekv'

try {
  await db.put('k', 'v')
} catch (error) {
  if (error instanceof EdgeKVError && error.code === 'STORAGE_QUOTA_EXCEEDED') {
    // the account is over its storage limit; reads and deletes still work
  } else throw error
}
```

| Code | What it means |
|---|---|
| `UNAUTHENTICATED` | The API key or token is missing, wrong or revoked |
| `TOKEN_EXPIRED` | The token has expired. With `tokens`, the client gets a new one and tries again |
| `FORBIDDEN` | The key may not do this: a read-only key or token writing, an ordinary key managing databases, a token minting tokens |
| `CONDITION_FAILED` | A conditional write found the key changed; nothing was written. `error.key` names the key |
| `NOT_FOUND` | No such database for this key |
| `ACCOUNT_SUSPENDED` | The account cannot be used at the moment |
| `STORAGE_QUOTA_EXCEEDED` | The account is over its storage limit; reads and deletes still work |
| `PLAN_LIMIT_EXCEEDED` | The plan allows no more databases |
| `NAME_CONFLICT`, `INVALID_NAME`, `REGION_UNAVAILABLE` | A database could not be created as asked |
| `KEY_TOO_LARGE`, `VALUE_TOO_LARGE`, `BATCH_TOO_LARGE` | A size limit |
| `RATE_LIMITED`, `LEASE_HELD`, `UNAVAILABLE` | Nothing happened; try again shortly. The client already does, see below |
| `TOO_MANY_CONNECTIONS` | Too many clients are waiting on this database |
| `TIMEOUT` | No answer in time. A write may or may not have been stored |
| `NETWORK` | The service could not be reached |

A missing key is not an error: `get` returns `null`.

### Retries and timeouts

Requests that failed with `RATE_LIMITED`, `LEASE_HELD`, `UNAVAILABLE` or a connection
failure are tried again, three times by default, waiting a little longer each time. Puts,
deletes and commits are safe to repeat: doing one twice leaves the same data as doing it
once.

A request that gets no answer within 15 seconds fails with `TIMEOUT` and is not retried
for you, because the service may have carried it out. Repeating it yourself is safe for
the same reason, except for a conditional write: if the first attempt was stored, the
repeat fails with `CONDITION_FAILED`, so read the key to find out.

```ts
new EdgeKV({ apiKey, url, retries: 0, timeoutMs: 5_000 })
```

## Keys

Keys are text. Slashes are fine and make good prefixes for `scan`. A key that is not
valid UTF-8 can be written and deleted through `commit`, which accepts bytes, and comes
back from `scan` in `keyBytes`.

## Developing

Everything runs in Docker, from the repository root:

```sh
make ts-test     # type-check, unit tests (no network), build
make ts-integ EDGEKV_URL=… EDGEKV_CONTROL_URL=… EDGEKV_API_KEY=ekv_…
```

`ts-integ` runs against a real service with a key that may manage databases. It creates
a database, uses it and deletes it.

The local mode's native half is the Rust crate in [`../native`](../native). To build it
for Linux and run the local-mode tests on glibc and on musl:

```sh
make native-test
```

The `.node` files land in `npm/<platform>/`, where the tests find them. On macOS or
Windows with Rust installed, build it yourself and point the tests at it:

```sh
cargo build --release --manifest-path ../native/Cargo.toml
EDGEKV_NATIVE_PATH=../native/target/release/libedgekv_native.dylib npm run test:local   # .so on Linux, edgekv_native.dll on Windows
```

### Releasing

The [npm workflow](../.github/workflows/npm.yml) builds the native library on every
platform, tests each build, and stages `@valkvlabs/edgekv` with its seven platform
packages on npm, all at one version, for a maintainer to approve with 2FA. The steps,
and what to do when one fails, are in [RELEASING.md](../RELEASING.md).
