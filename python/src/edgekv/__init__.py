"""ValkvEdgeKV client for Python.

Talks to the service over HTTPS with an API key. It keeps no local copy: every
read and write is a request. (The Rust library is the one that keeps a local
replica and works offline.)

Uses only the standard library. Python 3.9 or later.
"""

from __future__ import annotations

import base64
import json
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Sequence, Tuple, Union

__all__ = [
    "EdgeKV",
    "Database",
    "Databases",
    "EdgeKVError",
    "Entry",
    "Head",
    "DatabaseInfo",
    "UsageHour",
    "Page",
    "RETRYABLE",
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


class EdgeKVError(Exception):
    """Any failure reported by the service, or in reaching it."""

    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(f"{code}: {message}")
        #: A stable code, for example ``NOT_FOUND`` or ``STORAGE_QUOTA_EXCEEDED``.
        #: ``NETWORK`` and ``TIMEOUT`` are raised by this client.
        self.code = code
        self.message = message
        #: The HTTP status, or 0 when no response arrived.
        self.status = status

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


class _Client:
    """Sends requests to one base URL: adds the key, the timeout and the retries,
    and turns failures into :class:`EdgeKVError`."""

    def __init__(self, base: str, api_key: str, timeout: float, retries: int, transport: Transport) -> None:
        self._base = base.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout
        self._retries = retries
        self._transport = transport

    def send(
        self,
        method: str,
        path: str,
        *,
        body: Optional[bytes] = None,
        json_body: Any = None,
        query: Optional[Mapping[str, Any]] = None,
        timeout: Optional[float] = None,
    ) -> bytes:
        url = self._base + path
        pairs = [(name, str(value)) for name, value in (query or {}).items() if value is not None]
        if pairs:
            url += "?" + urllib.parse.urlencode(pairs)
        headers = {"Authorization": f"Bearer {self._api_key}"}
        if json_body is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(json_body).encode("utf-8")
        elif body is not None:
            headers["Content-Type"] = "application/octet-stream"
        attempt = 0
        while True:
            try:
                return self._once(method, url, headers, body, self._timeout if timeout is None else timeout)
            except EdgeKVError as error:
                if not error.retryable or attempt >= self._retries:
                    raise
                # 0.1 s, 0.2 s, 0.4 s, …, with jitter so many clients do not retry together.
                time.sleep(0.1 * 2**attempt * (0.5 + random.random()))
                attempt += 1

    def _once(self, method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float) -> bytes:
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
            return payload
        code = reply_headers.get("x-edgekv-error", "")
        message = ""
        try:
            parsed = json.loads(payload)
            detail = parsed.get("error", {}) if isinstance(parsed, dict) else {}
            if isinstance(detail, dict):
                code = detail.get("code") or code
                message = detail.get("message") or ""
        except ValueError:
            pass  # Not the service's error shape: a gateway or proxy answered.
        raise EdgeKVError(code or "SERVICE_ERROR", message or f"the service answered {status}", status)

    def send_json(self, method: str, path: str, **options: Any) -> Any:
        return json.loads(self.send(method, path, **options))


class Database:
    """One database's contents. Get one from :meth:`EdgeKV.database`."""

    def __init__(self, client: _Client, name: str) -> None:
        self._client = client
        #: The database's name within the account.
        self.name = name

    def _path(self, rest: str) -> str:
        return f"/v1/db/{urllib.parse.quote(self.name, safe='')}{rest}"

    def get(self, key: str) -> Optional[bytes]:
        """The value stored under ``key``, or ``None`` if there is none."""
        try:
            return self._client.send("GET", self._path(f"/kv/{_key_path(key)}"))
        except EdgeKVError as error:
            if error.code == "KEY_NOT_FOUND":
                return None
            raise

    def get_text(self, key: str) -> Optional[str]:
        """The value as text, or ``None``."""
        value = self.get(key)
        return None if value is None else value.decode("utf-8")

    def get_json(self, key: str) -> Any:
        """The value parsed as JSON, or ``None``. Raises if the stored value is not JSON."""
        text = self.get_text(key)
        return None if text is None else json.loads(text)

    def put(self, key: str, value: Value) -> int:
        """Stores a value and returns its position in the log. Returns once the
        service has made it durable."""
        return int(self._client.send_json("PUT", self._path(f"/kv/{_key_path(key)}"), body=_to_bytes(value))["lsn"])

    def put_json(self, key: str, value: Any) -> int:
        """Stores a value as JSON text."""
        return self.put(key, json.dumps(value))

    def delete(self, key: str) -> int:
        """Removes a key. Removing a key that is not there is not an error."""
        return int(self._client.send_json("DELETE", self._path(f"/kv/{_key_path(key)}"))["lsn"])

    def commit(self, operations: Sequence[Mapping[str, Any]]) -> int:
        """Several puts and deletes as one write: all of them happen or none does.

        Each operation is ``{"op": "put", "key": …, "value": …}`` or
        ``{"op": "delete", "key": …}``. Keys here may be bytes, so this also
        reaches keys that are not text.
        """
        if not operations:
            raise EdgeKVError("BAD_REQUEST", "a commit needs at least one operation", 0)
        ops: List[Dict[str, str]] = []
        for operation in operations:
            kind = operation.get("op")
            if kind == "put":
                ops.append({"op": "put", "key": _b64(operation["key"]), "value": _b64(operation["value"])})
            elif kind == "delete":
                ops.append({"op": "delete", "key": _b64(operation["key"])})
            else:
                raise EdgeKVError("BAD_REQUEST", f'an operation is "put" or "delete", not {kind!r}', 0)
        return int(self._client.send_json("POST", self._path("/commit"), json_body={"ops": ops})["lsn"])

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
            items.append(Entry(key_bytes.decode("utf-8", "replace"), key_bytes, base64.b64decode(item["value"])))
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

    :param api_key: an API key from the portal: ``ekv_…``.
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
    """

    def __init__(
        self,
        api_key: str,
        url: str,
        control_url: Optional[str] = None,
        *,
        timeout: float = 15.0,
        retries: int = 3,
        transport: Optional[Transport] = None,
    ) -> None:
        if not isinstance(api_key, str) or not api_key.startswith("ekv_"):
            raise EdgeKVError("BAD_REQUEST", "api_key must be an API key from the portal: ekv_…", 0)
        if not url:
            raise EdgeKVError("BAD_REQUEST", "url is required: where the data API is", 0)
        send = transport or _urllib_transport
        self._data = _Client(url, api_key, timeout, retries, send)
        self._control = _Client(control_url, api_key, timeout, retries, send) if control_url else None
        #: Creating, listing and deleting databases. Needs ``control_url`` and a
        #: key that may manage databases.
        self.databases = Databases(self._require_control)

    def _require_control(self) -> _Client:
        if self._control is None:
            raise EdgeKVError("BAD_REQUEST", "managing databases needs control_url", 0)
        return self._control

    def database(self, name: str) -> Database:
        """A database by name. Makes no request: a wrong name shows up as
        ``NOT_FOUND`` on first use."""
        return Database(self._data, name)

    def regions(self) -> List[str]:
        """Regions a database can be created in."""
        return [item["region"] for item in self._require_control().send_json("GET", "/v1/regions")["items"]]
