# valkv-edgekv for Python

A client for ValkvEdgeKV. It talks to the service over HTTPS with an API key; it keeps
no local copy, so every read and write is a request. For a local replica that works
offline, use the Rust library.

Python 3.9 or later. No dependencies: it uses only the standard library, and the
`cryptography` package if you encrypt values (`pip install "valkv-edgekv[encryption]"`).
Calls block; use a thread, or `asyncio.to_thread`, to run them alongside other work.

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

### Writing only if nothing changed

Every value has a version that changes with each write. A write can require the key
to still be at the version you read, so two clients updating the same counter or stock
level never overwrite each other:

```python
current = db.get_versioned("stock/widget")      # Versioned(value, version), or None
db.put("stock/widget", "8", if_version=current.version)
db.put("order/1004", "{}", if_absent=True)      # create, never overwrite
db.commit(operations, conditions=[{"key": "stock/widget", "version": current.version}])
```

If a condition does not hold, nothing is written and the call raises
`CONDITION_FAILED` (`error.key` names the key). `update` does the read, the change and
the retry for you:

```python
db.update("stock/widget", lambda value: str(int(value) - 1))
```

Your function gets the current value (`None` if there is none) and returns the new one
(`None` deletes the key). It may run more than once, so keep it free of side effects.

### Reading many keys

```python
for entry in db.scan(prefix="order/"):
    print(entry.key, entry.value.decode())
```

Entries come back in key order, fetched a page at a time as the loop runs. `scan_page`
gives you one page and a token for the next, if you would rather drive it yourself.

### Encrypting values

```python
# 32 bytes, or 64 hexadecimal characters (openssl rand -hex 32). Keep it safe: it cannot be recovered.
vault = kv.database("vault", encryption_key=os.environ["VAULT_KEY"])

vault.put_json("patient/7", {"diagnosis": "asthma"})   # the service receives ciphertext
record = vault.get_json("patient/7")                   # decrypted here
```

With `encryption_key`, values are encrypted in this process with ChaCha20-Poly1305
before they are sent, and decrypted when read: `get`, `scan`, `put`, `commit` and
`update` all work as before, and the service only ever stores ciphertext. Without it,
values are sent as they are. Key names, value sizes and timestamps are not encrypted, so
keep secrets out of key names. Each value grows by `ENCRYPTION_OVERHEAD` (28 bytes).
Needs `pip install "valkv-edgekv[encryption]"`.

The format is the one local replicas use (the Rust library, and the TypeScript
package's local mode): a replica opened with the same key reads these values, and this
reads theirs.

Choose per database, not per write: a database is either encrypted, always with the
same key, or not at all. Reading a value written without the key, or with another key,
raises `INVALID_ENCRYPTION_KEY`.

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
should not carry an API key at all: see the next section.

## Apps on your users' devices

Anyone can take an API key out of an app, so keep keys on your servers. Your backend,
which knows who the user is, mints a short-lived token for that user's database:

```python
# On your backend, with the API key
token = kv.database(f"notes-{user_id}").create_token(
    scope="write",       # or "read", the default
    ttl_seconds=3600,    # 60 to 86,400
    subject=user_id,     # your own name for the user, kept in the token
)
# token.token, token.expires_at
```

A Python app on a user's device gets tokens from your backend instead of holding a key:

```python
def tokens(database):
    return requests.get("https://my-backend.example.com/edgekv-token", params={"db": database}).text

kv = EdgeKV(url="https://api.example.com", tokens=tokens)
kv.database(f"notes-{user_id}").put("note/1", "hello")
```

The client asks for a token the first time it uses a database, again about a minute
before the token expires, and whenever the service refuses it (`TOKEN_EXPIRED`), and
then repeats the request once. A token works for its one database only, cannot mint
tokens or manage databases, and stops working when the key that minted it is revoked.

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

A missing key is not an error: `get` returns `None`.

### Retries and timeouts

Requests that failed with `RATE_LIMITED`, `LEASE_HELD`, `UNAVAILABLE` or a connection
failure are tried again, three times by default, waiting a little longer each time. Puts,
deletes and commits are safe to repeat: doing one twice leaves the same data as doing it
once.

A request that gets no answer within 15 seconds fails with `TIMEOUT` and is not retried
for you, because the service may have carried it out. Repeating it yourself is safe for
the same reason, except for a conditional write: if the first attempt was stored, the
repeat raises `CONDITION_FAILED`, so read the key to find out.

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
