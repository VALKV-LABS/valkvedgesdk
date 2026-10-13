# valkvedgesdk

Client SDKs (TypeScript, Python) and the desktop app for ValkvEdgeKV, the local-first
key-value database.

**Status: nothing is built yet.** This repository holds the plan; each folder below is
added when its work starts.

## Planned layout

```
valkvedgesdk/
├── typescript/     TypeScript SDK for the data API
├── python/         Python SDK for the data API
└── desktop/        Desktop application (Tauri) for macOS and Windows:
                    browse a database and its contents, create databases
```

## What this code talks to

The SDKs call the service's data API with an API key: key-value reads and writes,
scans, and the sync endpoints. The desktop application also lists, creates and deletes
databases, with an API key that was given that permission when it was created.

## Rules

Everything here ships to customers, so treat it as public:

- Describe the service only from the customer's side of its API: endpoints, request and
  response shapes, error codes, limits a client must respect.
- Nothing about how the service is built or run.
- Commits are authored by `Joti <joti@valkv.com>` only, with no co-author or tool
  attribution.
