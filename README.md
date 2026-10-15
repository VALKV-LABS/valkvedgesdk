# valkvedgesdk

Client SDKs (TypeScript, Python) and the desktop app for ValkvEdgeKV, the local-first
key-value database.

**Status:** the TypeScript and Python SDKs and the desktop application are built and
tested. None is published yet.

## Layout

| Folder | What | State |
|---|---|---|
| [`typescript/`](typescript/README.md) | `@valkvlabs/edgekv` for TypeScript and JavaScript: reads, writes, scans, waiting for changes, and managing databases; and a local mode with an offline copy on disk | Built; release workflow ready, not run |
| [`native/`](native/src/lib.rs) | The Rust bindings to the valkvedge library behind the local mode, built for each platform into `typescript/npm/` | Built and tested on Linux (glibc, musl) and Windows |
| [`python/`](python/README.md) | `valkv-edgekv` for Python: the same, with the same names in Python style | Built |
| [`desktop/`](desktop/README.md) | Desktop application (Tauri) for Windows and macOS: browse a database and its contents, create and delete databases | Built and tested on Windows; no release yet |

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

`ts-test`, `ts-integ`, `py-test` and `py-integ` run one SDK at a time. `make native-test`
builds the native library for Linux and runs the TypeScript local mode on it.

## Releases

| What | Workflow | Where it goes |
|---|---|---|
| `@valkvlabs/edgekv` and its platform packages | [`npm.yml`](.github/workflows/npm.yml), tag `ts-vX.Y.Z` | npm |
| Desktop application | [`desktop-release.yml`](.github/workflows/desktop-release.yml), tag `desktop-vX.Y.Z` | GitHub Releases |

## Licence

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or
[MIT licence](LICENSE-MIT) at your option, the same as the library.

## Rules

Everything here ships to customers, so treat it as public:

- Describe the service only from the customer's side of its API: endpoints, request and
  response shapes, error codes, limits a client must respect.
- Nothing about how the service is built or run.
- Commits are authored by `Joti <joti@valkvlabs.com>` only, with no co-author or tool
  attribution.
