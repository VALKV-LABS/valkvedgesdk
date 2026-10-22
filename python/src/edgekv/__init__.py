"""ValkvEdgeKV client for Python.

Talks to the service over HTTPS with an API key, or with access tokens your
backend mints. It keeps no local copy: every read and write is a request. (The
Rust library is the one that keeps a local replica and works offline.)

Uses only the standard library, and the ``cryptography`` package to encrypt
values (``pip install "valkv-edgekv[encryption]"``). Python 3.9 or later.
"""

from __future__ import annotations

import base64
import json
import random
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Sequence, Tuple, Union

from ._crypto import ENCRYPTION_OVERHEAD, ValueCipher

__all__ = [
    "ENCRYPTION_OVERHEAD",
    "EdgeKV",
    "Database",
    "Databases",
    "EdgeKVError",
    "Entry",
    "Head",
    "DatabaseInfo",
    "UsageHour",
    "Page",
    "Token",
    "Versioned",
    "RETRYABLE",
    "UPDATE_ATTEMPTS",
]
__version__ = "0.1.0"

#: A value to store: bytes, or text, which is stored as UTF-8.
Value = Union[bytes, bytearray, memoryview, str]

#: Codes that mean "nothing happened, try again shortly": the key is over its
#: request rate, the database is moving between servers, or the service is
#: briefly unavailable. Puts, deletes and commits are safe to repeat: doing one
#: twice leaves the same data as doing it once.
RETRYABLE = ("RATE_LIMITED", "LEASE_HELD", "UNAVAILABLE")

#: Sends one request: (method, url, headers, body, timeout seconds) and returns
#: (status, headers with lowercase names, body). Raises ``TimeoutError`` when no
#: answer came in time and ``OSError`` when the service could not be reached.
Transport = Callable[[str, str, Dict[str, str], Optional[bytes], float], Tuple[int, Mapping[str, str], bytes]]

#: Gets an access token for one database, usually by asking your backend, which
#: mints it with :meth:`Database.create_token`. Called with the database's name
#: the first time it is used, again about a minute before the token expires,
#: and whenever the service refuses it.
TokenSource = Callable[[str], str]

#: How many times :meth:`Database.update` reads and tries again before giving
#: up with ``CONDITION_FAILED``.
UPDATE_ATTEMPTS = 16

#: Codes that mean the credential itself was refused.
_REFUSED = ("TOKEN_EXPIRED", "UNAUTHENTICATED")


class EdgeKVError(Exception):
    """Any failure reported by the service, or in reaching it."""

    def __init__(self, code: str, message: str, status: int, key: Optional[bytes] = None) -> None:
        super().__init__(f"{code}: {message}")
        #: A stable code, for example ``NOT_FOUND`` or ``STORAGE_QUOTA_EXCEEDED``.
        #: ``NETWORK`` and ``TIMEOUT`` are raised by this client.
        self.code = code
        self.message = message
        #: The HTTP status, or 0 when no response arrived.
        self.status = status
        #: For ``CONDITION_FAILED``: the key whose condition did not hold, when known.
        self.key = key

    @property
    def retryable(self) -> bool:
        """True if the same request may succeed when tried again shortly."""
        return self.code in RETRYABLE or self.code == "NETWORK"


@dataclass(frozen=True)
class Entry:
    key: str
    #: The key as stored, for keys that are not valid UTF-8 text.
    key_bytes: bytes
    value: bytes
    #: The value's version, when the service reports it.
    version: Optional[str] = None
    #: When the value expires (RFC 3339), for a value that does.
    expires_at: Optional[str] = None


@dataclass(frozen=True)
class Versioned:
    """A value and its version: pass the version back to write only if the
    value has not changed since."""

    value: bytes
    version: str
    #: When the value expires (RFC 3339), for a value that does.
    expires_at: Optional[str] = None


@dataclass(frozen=True)
class Token:
    """An access token for one database."""

    #: Send it as a key: ``Authorization: Bearer <token>``, or hand it to an app.
    token: str
    #: ``read`` or ``write``.
    scope: str
    expires_at: str


@dataclass(frozen=True)
class Head:
    generation: int
    #: Position of the newest write in the database's log.
    lsn: int


@dataclass(frozen=True)
class Page:
    items: list
    #: Pass to the next call to continue, or ``None`` when there is nothing more.
    next_page_token: Optional[str]


@dataclass(frozen=True)
class DatabaseInfo:
    """A database as the service describes it."""

    id: str
    name: str
    region: str
    #: provisioning, active, degraded, suspended, deleting, deleted or error.
    status: str
    status_reason: Optional[str]
    created_at: str
    #: Stored size in bytes. Present when one database is read.
    stored_bytes: Optional[int] = None


@dataclass(frozen=True)
class UsageHour:
    hour: str
    stored_bytes: int
    ops_written: int
    bytes_served: int


def _to_bytes(value: Value) -> bytes:
    if isinstance(value, str):
        return value.encode("utf-8")
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value)
    raise TypeError(f"a key or value must be bytes or str, not {type(value).__name__}")


def _b64(value: Value) -> str:
    return base64.b64encode(_to_bytes(value)).decode("ascii")


def _expiry(ttl_seconds: Optional[int], expires_at: Union[None, str, datetime]) -> Dict[str, Any]:
    """``ttl_seconds`` or ``expires_at`` for the service: at most one. A
    ``datetime`` without a time zone is taken as UTC."""
    if ttl_seconds is not None and expires_at is not None:
        raise EdgeKVError("BAD_REQUEST", "give ttl_seconds or expires_at, not both", 0)
    if ttl_seconds is not None:
        return {"ttl_seconds": int(ttl_seconds)}
    if isinstance(expires_at, datetime):
        moment = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=timezone.utc)
        return {"expires_at": moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
    if expires_at is not None:
        return {"expires_at": expires_at}
    return {}


def _condition_headers(if_version: Optional[str], if_absent: bool) -> Dict[str, str]:
    if if_version is not None and if_absent:
        raise EdgeKVError("BAD_REQUEST", "give if_version or if_absent, not both", 0)
    if if_version is not None:
        return {"If-Match": if_version}
    return {"If-None-Match": "*"} if if_absent else {}


def _key_path(key: str) -> str:
    """A key as a URL path: every segment escaped, slashes kept."""
    if not isinstance(key, str):
        raise TypeError("a key must be str here; use commit() for keys that are bytes")
    if key == "":
        raise EdgeKVError("BAD_REQUEST", "a key must not be empty", 0)
    return "/".join(urllib.parse.quote(part, safe="") for part in key.split("/"))


def _urllib_transport(
    method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float
) -> Tuple[int, Mapping[str, str], bytes]:
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read()
    except urllib.error.HTTPError as error:
        # An answer with an error status is still an answer.
        return error.code, {k.lower(): v for k, v in error.headers.items()}, error.read()
    except urllib.error.URLError as error:
        if isinstance(error.reason, (socket.timeout, TimeoutError)):
            raise TimeoutError(str(error.reason)) from error
        raise OSError(str(error.reason)) from error


def _refresh_at(token: str, now: Optional[float] = None) -> float:
    """When to stop using a token, in seconds since the epoch: a minute before
    its ``exp``, or halfway through its life if that is sooner. A token that
    does not say is used until refused."""
    now = time.time() if now is None else now
    try:
        part = token.split(".")[1]
        exp = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))).get("exp")
    except (IndexError, ValueError, AttributeError):
        return float("inf")
    if not isinstance(exp, (int, float)) or isinstance(exp, bool):
        return float("inf")
    return max(exp - 60.0, now + (exp - now) / 2)


class _ApiKey:
    """A fixed API key."""

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    def get(self) -> str:
        return self._api_key

    def refuse(self, token: str) -> bool:
        return False


class _TokenCache:
    """One database's access token, fetched from the application's source and
    kept until it is due for renewal. Safe to share between threads."""

    def __init__(self, source: TokenSource, database: str) -> None:
        self._source = source
        self._database = database
        self._lock = threading.Lock()
        self._token: Optional[str] = None
        self._refresh_at = 0.0

    def get(self) -> str:
        with self._lock:
            if self._token is not None and time.time() < self._refresh_at:
                return self._token
            try:
                token = self._source(self._database)
            except EdgeKVError:
                raise
            except Exception as error:
                # Retryable, like a service that is briefly unavailable.
                raise EdgeKVError("UNAVAILABLE", f"the token source failed: {error}", 0) from error
            if not isinstance(token, str) or not token:
                raise EdgeKVError("BAD_REQUEST", f"the token source returned no token for {self._database}", 0)
            self._token, self._refresh_at = token, _refresh_at(token)
            return token

    def refuse(self, token: str) -> bool:
        with self._lock:
            if self._token == token:
                self._token = None
        return True


class _Client:
    """Sends requests to one base URL: adds the credential, the timeout and the
    retries, and turns failures into :class:`EdgeKVError`."""

    def __init__(self, base: str, credential: Any, timeout: float, retries: int, transport: Transport) -> None:
        self._base = base.rstrip("/")
        self._credential = credential
        self._timeout = timeout
        self._retries = retries
        self._transport = transport

    def with_credential(self, credential: Any) -> "_Client":
        """The same service, with another credential."""
        return _Client(self._base, credential, self._timeout, self._retries, self._transport)

    def send(self, method: str, path: str, **options: Any) -> bytes:
        return self.request(method, path, **options)[1]

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Optional[bytes] = None,
        json_body: Any = None,
        query: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
        timeout: Optional[float] = None,
    ) -> Tuple[Mapping[str, str], bytes]:
        """Sends a request and returns the answer's headers (lowercase names) and body."""
        url = self._base + path
        pairs = [(name, str(value)) for name, value in (query or {}).items() if value is not None]
        if pairs:
            url += "?" + urllib.parse.urlencode(pairs)
        base_headers = dict(headers or {})
        if json_body is not None:
            base_headers["Content-Type"] = "application/json"
            body = json.dumps(json_body).encode("utf-8")
        elif body is not None:
            base_headers["Content-Type"] = "application/octet-stream"
        attempt = 0
        renewed = False
        while True:
            token: Optional[str] = None
            try:
                token = self._credential.get()
                sent = dict(base_headers, Authorization=f"Bearer {token}")
                return self._once(method, url, sent, body, self._timeout if timeout is None else timeout)
            except EdgeKVError as error:
                # A refused token is renewed and the request tried once more, at once.
                if error.code in _REFUSED and token is not None and not renewed and self._credential.refuse(token):
                    renewed = True
                    continue
                if not error.retryable or attempt >= self._retries:
                    raise
                # 0.1 s, 0.2 s, 0.4 s, …, with jitter so many clients do not retry together.
                time.sleep(0.1 * 2**attempt * (0.5 + random.random()))
                attempt += 1

    def _once(
        self, method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float
    ) -> Tuple[Mapping[str, str], bytes]:
        try:
            status, reply_headers, payload = self._transport(method, url, headers, body, timeout)
        except (TimeoutError, socket.timeout) as error:
            # Not retried: the service may have done the work.
            raise EdgeKVError(
                "TIMEOUT", f"no answer within {timeout:g} s; the request may or may not have been carried out", 0
            ) from error
        except OSError as error:
            origin = "{0.scheme}://{0.netloc}".format(urllib.parse.urlsplit(url))
            raise EdgeKVError("NETWORK", f"could not reach {origin}: {error}", 0) from error
        if 200 <= status < 300:
            return reply_headers, payload
        code = reply_headers.get("x-edgekv-error", "")
        message = ""
        key: Optional[bytes] = None
        try:
            parsed = json.loads(payload)
            detail = parsed.get("error", {}) if isinstance(parsed, dict) else {}
            if isinstance(detail, dict):
                code = detail.get("code") or code
                message = detail.get("message") or ""
                if isinstance(detail.get("key"), str):
                    key = base64.b64decode(detail["key"])
        except ValueError:
            pass  # Not the service's error shape: a gateway or proxy answered.
        raise EdgeKVError(code or "SERVICE_ERROR", message or f"the service answered {status}", status, key)

    def send_json(self, method: str, path: str, **options: Any) -> Any:
        return json.loads(self.send(method, path, **options))


class Database:
    """One database's contents. Get one from :meth:`EdgeKV.database`."""

    def __init__(self, client: _Client, name: str, cipher: Optional[ValueCipher] = None) -> None:
        self._client = client
        self._cipher = cipher
        #: The database's name within the account.
        self.name = name

    @property
    def encrypted(self) -> bool:
        """True if values are encrypted here before they are sent."""
        return self._cipher is not None

    def _path(self, rest: str) -> str:
        return f"/v1/db/{urllib.parse.quote(self.name, safe='')}{rest}"

    def _sealed(self, key: bytes, value: bytes) -> bytes:
        """The value to send for ``key``: encrypted when there is a key."""
        return value if self._cipher is None else self._cipher.seal(key, value)

    def _opened(self, key: bytes, stored: bytes) -> bytes:
        """The value as read for ``key``: decrypted when there is a key."""
        if self._cipher is None:
            return stored
        value = self._cipher.open(key, stored)
        if value is None:
            raise EdgeKVError(
                "INVALID_ENCRYPTION_KEY",
                f"the value of {key.decode('utf-8', 'replace')} could not be decrypted: "
                "another key encrypted it, or it was not encrypted",
                0,
                key,
            )
        return value

    def get(self, key: str) -> Optional[bytes]:
        """The value stored under ``key``, or ``None`` if there is none."""
        found = self.get_versioned(key)
        return None if found is None else found.value

    def get_versioned(self, key: str) -> Optional[Versioned]:
        """The value stored under ``key`` and its version, or ``None`` if there is none."""
        try:
            headers, value = self._client.request("GET", self._path(f"/kv/{_key_path(key)}"))
        except EdgeKVError as error:
            if error.code == "KEY_NOT_FOUND":
                return None
            raise
        return Versioned(
            self._opened(_to_bytes(key), value), headers.get("x-edgekv-version", ""), headers.get("x-edgekv-expires")
        )

    def get_text(self, key: str) -> Optional[str]:
        """The value as text, or ``None``."""
        value = self.get(key)
        return None if value is None else value.decode("utf-8")

    def get_json(self, key: str) -> Any:
        """The value parsed as JSON, or ``None``. Raises if the stored value is not JSON."""
        text = self.get_text(key)
        return None if text is None else json.loads(text)

    def put(
        self,
        key: str,
        value: Value,
        *,
        if_version: Optional[str] = None,
        if_absent: bool = False,
        ttl_seconds: Optional[int] = None,
        expires_at: Union[None, str, datetime] = None,
    ) -> int:
        """Stores a value and returns its position in the log. Returns once the
        service has made it durable.

        With ``if_version``, only if the key is still at that version; with
        ``if_absent``, only if it has no value. Otherwise nothing is written and
        it raises ``CONDITION_FAILED``.

        With ``ttl_seconds`` (1 second to 10 years) or ``expires_at``, the
        value expires: from then on the key reads as not there, and the service
        deletes it. The time is stored beside the value, not encrypted with it.
        """
        reply = self._client.send_json(
            "PUT",
            self._path(f"/kv/{_key_path(key)}"),
            body=self._sealed(_to_bytes(key), _to_bytes(value)),
            query=_expiry(ttl_seconds, expires_at),
            headers=_condition_headers(if_version, if_absent),
        )
        return int(reply["lsn"])

    def put_json(
        self,
        key: str,
        value: Any,
        *,
        if_version: Optional[str] = None,
        if_absent: bool = False,
        ttl_seconds: Optional[int] = None,
        expires_at: Union[None, str, datetime] = None,
    ) -> int:
        """Stores a value as JSON text."""
        return self.put(
            key,
            json.dumps(value),
            if_version=if_version,
            if_absent=if_absent,
            ttl_seconds=ttl_seconds,
            expires_at=expires_at,
        )

    def delete(self, key: str, *, if_version: Optional[str] = None) -> int:
        """Removes a key. Removing a key that is not there is not an error,
        unless ``if_version`` is given."""
        reply = self._client.send_json(
            "DELETE", self._path(f"/kv/{_key_path(key)}"), headers=_condition_headers(if_version, False)
        )
        return int(reply["lsn"])

    def update(self, key: str, change: Callable[[Optional[bytes]], Optional[Value]]) -> Optional[int]:
        """Reads a key, computes its new value with ``change``, and writes it
        back if nobody else wrote the key in between, reading and trying again
        if they did. Use it for counters, stock levels and anything else a plain
        put would lose updates to.

        ``change`` gets the current value (``None`` when there is none) and
        returns the new one (``None`` deletes the key); it may run more than
        once. Returns the write's position in the log, or ``None`` when nothing
        was written (there was no value and ``change`` returned ``None``).
        """
        for _ in range(UPDATE_ATTEMPTS):
            current = self.get_versioned(key)
            new = change(None if current is None else current.value)
            try:
                if new is not None:
                    if current is None:
                        return self.put(key, new, if_absent=True)
                    return self.put(key, new, if_version=current.version)
                if current is None:
                    return None
                return self.delete(key, if_version=current.version)
            except EdgeKVError as error:
                if error.code != "CONDITION_FAILED":
                    raise
        raise EdgeKVError(
            "CONDITION_FAILED", f"{key} kept changing: gave up after {UPDATE_ATTEMPTS} attempts", 412, _to_bytes(key)
        )

    def create_token(
        self, scope: Optional[str] = None, ttl_seconds: Optional[int] = None, subject: Optional[str] = None
    ) -> Token:
        """Mints an access token for this database, to give to an app on a
        user's device instead of an API key. Call it on your backend, with an
        API key.

        :param scope: ``read`` (the default) or ``write``. A read-only key can
            mint only read tokens.
        :param ttl_seconds: how long the token works, 60 to 86,400. Default 3600.
        :param subject: your own name for the user, kept in the token.
        """
        body = {name: value for name, value in (("scope", scope), ("ttl_seconds", ttl_seconds), ("subject", subject)) if value is not None}
        reply = self._client.send_json("POST", self._path("/tokens"), json_body=body)
        return Token(reply["token"], reply["scope"], reply["expires_at"])

    def commit(
        self, operations: Sequence[Mapping[str, Any]], *, conditions: Optional[Sequence[Mapping[str, Any]]] = None
    ) -> int:
        """Several puts and deletes as one write: all of them happen or none does.

        Each operation is ``{"op": "put", "key": …, "value": …}`` or
        ``{"op": "delete", "key": …}``. Keys here may be bytes, so this also
        reaches keys that are not text.

        Each condition is ``{"key": …, "version": …}``: the key must still be at
        that version, or have no value when the version is ``None``. If one does
        not hold, nothing is written and it raises ``CONDITION_FAILED`` with the
        key in ``error.key``.
        """
        if not operations:
            raise EdgeKVError("BAD_REQUEST", "a commit needs at least one operation", 0)
        ops: List[Dict[str, Any]] = []
        for operation in operations:
            kind = operation.get("op")
            if kind == "put":
                key = _to_bytes(operation["key"])
                value = self._sealed(key, _to_bytes(operation["value"]))
                expiry = _expiry(operation.get("ttl_seconds"), operation.get("expires_at"))
                ops.append({"op": "put", "key": _b64(key), "value": _b64(value), **expiry})
            elif kind == "delete":
                ops.append({"op": "delete", "key": _b64(operation["key"])})
            else:
                raise EdgeKVError("BAD_REQUEST", f'an operation is "put" or "delete", not {kind!r}', 0)
        payload: Dict[str, Any] = {"ops": ops}
        if conditions:
            payload["conditions"] = [{"key": _b64(c["key"]), "version": c["version"]} for c in conditions]
        return int(self._client.send_json("POST", self._path("/commit"), json_body=payload)["lsn"])

    def scan_page(
        self, prefix: Optional[str] = None, page_size: Optional[int] = None, page_token: Optional[str] = None
    ) -> Page:
        """One page of entries in key order. Most callers want :meth:`scan`."""
        page = self._client.send_json(
            "GET", self._path("/kv"), query={"prefix": prefix, "limit": page_size, "page_token": page_token}
        )
        items = []
        for item in page["items"]:
            key_bytes = base64.b64decode(item["key"])
            value = self._opened(key_bytes, base64.b64decode(item["value"]))
            items.append(
                Entry(key_bytes.decode("utf-8", "replace"), key_bytes, value, item.get("version"), item.get("expires_at"))
            )
        return Page(items, page.get("next_page_token"))

    def scan(self, prefix: Optional[str] = None, page_size: Optional[int] = None) -> Iterator[Entry]:
        """Every entry in key order, fetched a page at a time as the loop goes.

        ``page_size`` is entries per request, 1 to 200; the default is 50.
        """
        token: Optional[str] = None
        while True:
            page = self.scan_page(prefix, page_size, token)
            yield from page.items
            token = page.next_page_token
            if token is None:
                return

    def head(self) -> Head:
        """Where the database's log ends now."""
        reply = self._client.send_json("GET", self._path("/head"))
        return Head(int(reply["generation"]), int(reply["lsn"]))

    def wait_for_change(self, after_lsn: int, timeout: float = 30.0) -> Head:
        """Waits until something is written after ``after_lsn``, or until
        ``timeout`` seconds pass (at most 30, which is also the default).

        Returns the head either way: compare its ``lsn`` with ``after_lsn`` to
        tell which happened.
        """
        wait = min(max(timeout, 0.0), 30.0)
        reply = self._client.send_json(
            "GET",
            self._path("/head"),
            query={"wait_after": after_lsn, "timeout_ms": int(wait * 1000)},
            # The request itself must outlast the wait it asks for.
            timeout=wait + 10.0,
        )
        return Head(int(reply["generation"]), int(reply["lsn"]))


def _info(raw: Mapping[str, Any]) -> DatabaseInfo:
    usage = raw.get("usage")
    return DatabaseInfo(
        id=raw["id"],
        name=raw["spec"]["name"],
        region=raw["region"],
        status=raw["status"],
        status_reason=raw.get("status_reason"),
        created_at=raw["created_at"],
        stored_bytes=int(usage["stored_bytes"]) if usage else None,
    )


class Databases:
    """Creating, listing and deleting databases. Needs a key that may manage databases."""

    def __init__(self, client: Callable[[], _Client]) -> None:
        self._client = client

    def list_page(self, page_size: Optional[int] = None, page_token: Optional[str] = None) -> Page:
        """One page of the account's databases, oldest first. Most callers want :meth:`list`."""
        page = self._client().send_json(
            "GET", "/v1/databases", query={"limit": page_size, "page_token": page_token}
        )
        return Page([_info(raw) for raw in page["items"]], page.get("next_page_token"))

    def list(self) -> Iterator[DatabaseInfo]:
        """Every database in the account."""
        token: Optional[str] = None
        while True:
            page = self.list_page(page_token=token)
            yield from page.items
            token = page.next_page_token
            if token is None:
                return

    def create(self, name: str, region: str) -> DatabaseInfo:
        """Creates a database.

        The name is 2 to 48 characters: lowercase letters, digits and ``-``,
        starting with a letter. It cannot be changed later.
        """
        return _info(self._client().send_json("POST", "/v1/databases", json_body={"name": name, "region": region}))

    def get(self, database_id: str) -> DatabaseInfo:
        """One database, with its stored size."""
        return _info(self._client().send_json("GET", f"/v1/databases/{urllib.parse.quote(database_id, safe='')}"))

    def delete(self, database_id: str) -> None:
        """Deletes a database and all its data. This cannot be undone.

        The call returns at once; the data is removed in the background.
        """
        self._client().send("DELETE", f"/v1/databases/{urllib.parse.quote(database_id, safe='')}")

    def usage(self, database_id: str) -> List[UsageHour]:
        """Hour-by-hour usage for the last seven days."""
        reply = self._client().send_json("GET", f"/v1/databases/{urllib.parse.quote(database_id, safe='')}/usage")
        return [
            UsageHour(item["hour"], int(item["stored_bytes"]), int(item["ops_written"]), int(item["bytes_served"]))
            for item in reply["items"]
        ]


class EdgeKV:
    """The client. Create one and keep it: it holds no connection and is cheap.

    :param api_key: an API key from the portal: ``ekv_…``. For your servers.
        Give this or ``tokens``.
    :param url: where the data API is, for example ``https://api.example.com``.
    :param control_url: where databases are managed, for example
        ``https://cp.example.com``. Only needed for :attr:`databases` and
        :meth:`regions`, and only works with a key that was given the right to
        manage databases.
    :param timeout: how long one request may take, in seconds.
    :param retries: how many times a request is tried again when the service
        says it was not done and can be repeated (see :data:`RETRYABLE`). 0
        turns retries off.
    :param transport: sends the requests, instead of ``urllib``.
    :param tokens: for apps on your users' devices, which must not hold an API
        key: a function that returns an access token for a database name (see
        :data:`TokenSource`). Give this or ``api_key``.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        url: Optional[str] = None,
        control_url: Optional[str] = None,
        *,
        tokens: Optional[TokenSource] = None,
        timeout: float = 15.0,
        retries: int = 3,
        transport: Optional[Transport] = None,
    ) -> None:
        if (api_key is None) == (tokens is None):
            raise EdgeKVError(
                "BAD_REQUEST", "give api_key (on a server) or tokens (in an app), not both and not neither", 0
            )
        if api_key is not None and (not isinstance(api_key, str) or not api_key.startswith("ekv_")):
            raise EdgeKVError("BAD_REQUEST", "api_key must be an API key from the portal: ekv_…", 0)
        if tokens is not None and not callable(tokens):
            raise EdgeKVError("BAD_REQUEST", "tokens must be a function that returns a token for a database name", 0)
        if not url:
            raise EdgeKVError("BAD_REQUEST", "url is required: where the data API is", 0)
        send = transport or _urllib_transport
        credential = _ApiKey(api_key or "")
        self._tokens = tokens
        #: Each database's token, shared by every Database for it.
        self._caches: Dict[str, _TokenCache] = {}
        self._caches_lock = threading.Lock()
        self._data = _Client(url, credential, timeout, retries, send)
        self._control = (
            _Client(control_url, credential, timeout, retries, send) if control_url and api_key is not None else None
        )
        #: Creating, listing and deleting databases. Needs ``control_url`` and a
        #: key that may manage databases.
        self.databases = Databases(self._require_control)

    def _require_control(self) -> _Client:
        if self._tokens is not None:
            raise EdgeKVError(
                "BAD_REQUEST", "managing databases needs an API key; an access token works for one database only", 0
            )
        if self._control is None:
            raise EdgeKVError("BAD_REQUEST", "managing databases needs control_url", 0)
        return self._control

    def database(self, name: str, *, encryption_key: Optional[Union[bytes, str]] = None) -> Database:
        """A database by name. Makes no request: a wrong name shows up as
        ``NOT_FOUND`` on first use.

        :param encryption_key: 32 bytes, or 64 hexadecimal characters. Values
            are encrypted with it in this process before they are sent, and
            decrypted when read: the service stores only ciphertext. The format
            is the one local replicas use, so they read these values with the
            same key, and this reads theirs. Keys (the names) are not
            encrypted. A lost key cannot be recovered. Without it, values are
            sent as they are. Use one choice per database: reading a value
            written without the key, or with another key, raises
            ``INVALID_ENCRYPTION_KEY``. Needs ``pip install "valkv-edgekv[encryption]"``.
        """
        cipher = None
        if encryption_key is not None:
            try:
                cipher = ValueCipher(encryption_key, name)
            except (ValueError, ImportError) as error:
                raise EdgeKVError("BAD_REQUEST", str(error), 0) from None
        if self._tokens is None:
            return Database(self._data, name, cipher)
        with self._caches_lock:
            cache = self._caches.get(name)
            if cache is None:
                cache = self._caches[name] = _TokenCache(self._tokens, name)
        return Database(self._data.with_credential(cache), name, cipher)

    def regions(self) -> List[str]:
        """Regions a database can be created in."""
        return [item["region"] for item in self._require_control().send_json("GET", "/v1/regions")["items"]]
