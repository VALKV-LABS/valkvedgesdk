# valkvedgesdk

Client SDKs (TypeScript, Python) and the desktop app for ValkvEdgeKV, the local-first
key-value database.

**Status:** the TypeScript SDK is built and tested; it is not published to npm yet. The
Python SDK and the desktop application are not started.

## Layout

| Folder | What | State |
|---|---|---|
| [`typescript/`](typescript/README.md) | TypeScript and JavaScript SDK: reads, writes, scans, waiting for changes, and managing databases | Built |
| `python/` | Python SDK | Planned |
| `desktop/` | Desktop application (Tauri) for macOS and Windows: browse a database and its contents, create and delete databases | Planned |

## What this code talks to

The SDKs call the service's data API with an API key: key-value reads and writes,
scans, and waiting for changes. With an API key that was given the right to manage
databases when it was created, they also list, create and delete databases.

## Developing

Everything runs in Docker; `make` lists the commands.

```sh
make ts-test     # TypeScript SDK: type-check, unit tests, build
make ts-integ    # the same SDK against a running service
```

## Rules

Everything here ships to customers, so treat it as public:

- Describe the service only from the customer's side of its API: endpoints, request and
  response shapes, error codes, limits a client must respect.
- Nothing about how the service is built or run.
- Commits are authored by `Joti <joti@valkv.com>` only, with no co-author or tool
  attribution.
