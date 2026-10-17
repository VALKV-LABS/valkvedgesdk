# ValkvEdgeKV Desktop

A desktop application for looking at your ValkvEdgeKV databases and what is in them.

- See your databases, with their status, region and stored size.
- Create and delete databases.
- Browse a database's entries in key order, filter by prefix, and page through them.
- Add, edit and delete entries. Values are shown as JSON, text or hex, whichever they
  are, and can be typed as text or hex.
- See the replicas of a database (each local copy the library keeps in sync), whether each is connected, and how far behind it is.

It is built with [Tauri](https://tauri.app): a small native program with the interface
in the system's web view. It runs on Windows and macOS.

**Status:** built and tested on Windows. The macOS build is produced by the release
workflow and has not been run by anyone yet. No release has been published.

## Connecting

The app asks for three things:

| | Example |
|---|---|
| Data API address | `https://api.example.com` |
| Management address | `https://cp.example.com` |
| API key | `ekv_…`, from the portal |

To create, list and delete databases, the key must have been created with **Can create
and delete databases**. With an ordinary key the app still works: you open a database
by typing its name, and can browse and edit what is in it.

The key is kept in the system's credential store (Windows Credential Manager, macOS
Keychain), not in a file, and is never shown again after you type it. The two addresses
are kept in the app's settings folder. **Disconnect** removes the key.

## What to know

- **The app has no local copy.** Every screen is a request to the service, so it needs
  a connection, and what you see is as fresh as your last refresh.
- **Saving is immediate and durable.** There is no undo.
- **Deleting a database deletes all its data** and cannot be undone. The app asks first.
- A value is shown as hex when it is not text. Tick "value is hex" to type bytes, for
  example `de ad be ef`.

## Developing

You need Node 22 and a stable Rust toolchain, and on Windows the Visual Studio C++
build tools and WebView2 (part of Windows 11).

```sh
npm install
npm run tauri dev      # run it, reloading as you edit
npm run tauri build    # the program and its installers
```

The build leaves the program at `src-tauri/target/release/edgekv-desktop.exe` and the
installers under `src-tauri/target/release/bundle/`.

### Tests

```sh
npm run typecheck
npm test                                              # how values are shown, names, messages
cargo test --manifest-path src-tauri/Cargo.toml --lib # the native half
```

Two more need a running service and a key that may manage databases:

```sh
export EDGEKV_URL=… EDGEKV_CONTROL_URL=… EDGEKV_API_KEY=ekv_…

# The native client: creates a database, fills it, browses it, deletes it.
cargo test --manifest-path src-tauri/Cargo.toml --lib integration -- --ignored

# The built application, through its real window (Windows only).
npm run test:ui
```

`test:ui` starts the built program, clicks through it by way of the web view's
debugging port, and checks what it did against the service directly. It uses a profile
of its own, so a connection you have saved is not touched. Screenshots land in
`tests/out/`.

## Layout

```
src/               the interface (TypeScript, no framework)
  format.ts        showing values, sizes, names and errors; unit-tested
  main.ts          the window
src-tauri/         the native half (Rust)
  src/client.rs    every request to the service
  src/lib.rs       commands the window can call; the saved connection
tests/ui.mjs       the end-to-end test of the built app
```

Requests are made by the native half, not by the window: the API key never enters the
web view.

## Releasing

The **Desktop release** workflow builds the Windows installers and the macOS disk
image. Set the version in `package.json`, `src-tauri/tauri.conf.json` and
`src-tauri/Cargo.toml`, merge, then run the workflow with a tag such as
`desktop-v0.1.0`. With "publish" off it only builds; with it on, the installers are
attached to a GitHub Release.

Without signing certificates in the repository's secrets the installers are unsigned,
and Windows and macOS warn whoever installs them.
