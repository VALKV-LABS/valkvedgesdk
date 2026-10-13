# valkvedge for TypeScript and JavaScript

A client for ValkvEdgeKV. It talks to the service over HTTPS with an API key; it keeps
no local copy, so every read and write is a request. For a local replica that works
offline, use the Rust library.

Works anywhere `fetch` exists: Node 18 or later, Deno, Bun, browsers. No dependencies.

**Not published to npm yet.** Build it from this folder: `make ts-test` in the
repository root type-checks, tests and builds it into `dist/`.

## Use

```ts
import { EdgeKV } from 'valkvedge'

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

### Reading many keys

```ts
for await (const entry of db.scan({ prefix: 'order/' })) {
  console.log(entry.key, new TextDecoder().decode(entry.value))
}
```

Entries come back in key order, fetched a page at a time as the loop runs. `scanPage`
gives you one page and a token for the next, if you would rather drive it yourself.

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
should carry an ordinary key, or one limited to a single database.

## Errors

Every failure is an `EdgeKVError` with a stable `code`, the HTTP `status`, and a message.

```ts
import { EdgeKVError } from 'valkvedge'

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
| `UNAUTHENTICATED` | The API key is missing, wrong or revoked |
| `FORBIDDEN` | The key may not do this: a read-only key writing, or an ordinary key managing databases |
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
the same reason.

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
