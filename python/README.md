# valkv-edgekv for Python

A client for ValkvEdgeKV. It talks to the service over HTTPS with an API key; it keeps
no local copy, so every read and write is a request. For a local replica that works
offline, use the Rust library.

Python 3.9 or later. No dependencies: it uses only the standard library. Calls block;
use a thread, or `asyncio.to_thread`, to run them alongside other work.

**Not published to PyPI yet.** Install it from this folder: `pip install ./python`.

## Use

```python
import os
from edgekv import EdgeKV

kv = EdgeKV(os.environ["EDGEKV_API_KEY"], "https://api.example.com")   # ekv_…, from the portal
db = kv.database("orders")

db.put("order/1001", '{"total": 42}')
db.put_json("order/1002", {"total": 17})

order = db.get_json("order/1001")   # None if there is none
raw = db.get("order/1001")          # bytes or None

db.delete("order/1001")
```

Values are bytes. Text you pass is stored as UTF-8; `get_text` and `get_json` read it
back. `put` and `delete` return the write's position in the database's log, a number
that only goes up.

### Several changes as one

```python
db.commit([
    {"op": "put", "key": "stock/widget", "value": "9"},
    {"op": "put", "key": "order/1003", "value": '{"item": "widget"}'},
    {"op": "delete", "key": "cart/77"},
])
```

All of them happen or none does.

### Reading many keys

```python
for entry in db.scan(prefix="order/"):
    print(entry.key, entry.value.decode())
```

Entries come back in key order, fetched a page at a time as the loop runs. `scan_page`
gives you one page and a token for the next, if you would rather drive it yourself.

### Waiting for changes

```python
lsn = db.head().lsn
while True:
    head = db.wait_for_change(lsn)   # returns on a write, or after 30 s
    if head.lsn > lsn:
        lsn = head.lsn
        ...                          # something changed: read what you need
```

A database allows a limited number of clients to wait at once. Past it, the call fails
with `TOO_MANY_CONNECTIONS`; fall back to calling `head()` on a timer.

## Managing databases

With an API key that was created with "Can create and delete databases", and the
address where databases are managed:

```python
kv = EdgeKV(os.environ["EDGEKV_API_KEY"], "https://api.example.com", "https://cp.example.com")

region = kv.regions()[0]
created = kv.databases.create("orders", region)

for database in kv.databases.list():
    print(database.name, database.status)

stored = kv.databases.get(created.id).stored_bytes
kv.databases.delete(created.id)   # deletes all its data; cannot be undone
```

A database can be used on the data API a moment after it is created. Until then,
requests for it fail with `NOT_FOUND`.

Give such a key to tools you run yourself. An application you ship to other people
should carry an ordinary key, or one limited to a single database.

## Errors

Every failure is an `EdgeKVError` with a stable `code`, the HTTP `status`, and a
`message`.

```python
from edgekv import EdgeKVError

try:
    db.put("k", "v")
except EdgeKVError as error:
    if error.code == "STORAGE_QUOTA_EXCEEDED":
        ...   # the account is over its storage limit; reads and deletes still work
    else:
        raise
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

A missing key is not an error: `get` returns `None`.

### Retries and timeouts

Requests that failed with `RATE_LIMITED`, `LEASE_HELD`, `UNAVAILABLE` or a connection
failure are tried again, three times by default, waiting a little longer each time. Puts,
deletes and commits are safe to repeat: doing one twice leaves the same data as doing it
once.

A request that gets no answer within 15 seconds fails with `TIMEOUT` and is not retried
for you, because the service may have carried it out. Repeating it yourself is safe for
the same reason.

```python
EdgeKV(api_key, url, retries=0, timeout=5.0)
```

## Keys

Keys are text. Slashes are fine and make good prefixes for `scan`. A key that is not
valid UTF-8 can be written and deleted through `commit`, which accepts bytes, and comes
back from `scan` in `key_bytes`.

## Developing

Everything runs in Docker, from the repository root:

```sh
make py-test     # unit tests (no network), on Python 3.9 and 3.12
make py-integ EDGEKV_URL=… EDGEKV_CONTROL_URL=… EDGEKV_API_KEY=ekv_…
```

`py-integ` runs against a real service with a key that may manage databases. It creates
a database, uses it and deletes it.
