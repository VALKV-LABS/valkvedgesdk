# valkvedgesdk

Client SDKs (TypeScript, Python) and the desktop app for ValkvEdgeKV, the local-first
key-value database.

**Status:** the TypeScript and Python SDKs are built and tested. Neither is published
to a package registry yet. The desktop application is not started.

## Layout

| Folder | What | State |
|---|---|---|
| [`typescript/`](typescript/README.md) | `@valkv/edgekv` for TypeScript and JavaScript: reads, writes, scans, waiting for changes, and managing databases | Built |
| [`python/`](python/README.md) | `valkv-edgekv` for Python: the same, with the same names in Python style | Built |
| `desktop/` | Desktop application (Tauri) for macOS and Windows: browse a database and its contents, create and delete databases | Planned |

## What this code talks to

The SDKs call the service's data API with an API key: key-value reads and writes,
scans, and waiting for changes. With an API key that was given the right to manage
databases when it was created, they also list, create and delete databases.

## Developing

Everything runs in Docker; `make` lists the commands.

```sh
make test        # both SDKs: unit tests, no network
make integ EDGEKV_URL=… EDGEKV_CONTROL_URL=… EDGEKV_API_KEY=ekv_…   # both, against a running service
```

`ts-test`, `ts-integ`, `py-test` and `py-integ` run one SDK at a time.

## Licence

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or
[MIT licence](LICENSE-MIT) at your option, the same as the library.

## Rules

Everything here ships to customers, so treat it as public:

- Describe the service only from the customer's side of its API: endpoints, request and
  response shapes, error codes, limits a client must respect.
- Nothing about how the service is built or run.
- Commits are authored by `Joti <joti@valkv.com>` only, with no co-author or tool
  attribution.
