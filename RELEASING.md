# Releasing

Everything here is released by GitHub Actions workflows that you start by hand from
the **Actions** tab: pick the workflow, **Run workflow**, branch `main`, and type the
tag. You do not create the tag or the GitHub Release yourself; the workflows do.

| What | Tag | Workflows | Where it goes |
|---|---|---|---|
| TypeScript SDK: `@valkvlabs/edgekv` and its 7 platform packages | `ts-vX.Y.Z` | **npm**, then **npm release check** | npm |
| Desktop application | `desktop-vX.Y.Z` | **Desktop release** | GitHub Releases |

## TypeScript SDK (npm)

`@valkvlabs/edgekv` is released together with one package per platform holding the
native library for its local mode:

```
@valkvlabs/edgekv-darwin-arm64     @valkvlabs/edgekv-linux-x64-gnu
@valkvlabs/edgekv-darwin-x64       @valkvlabs/edgekv-linux-x64-musl
@valkvlabs/edgekv-linux-arm64-gnu  @valkvlabs/edgekv-win32-x64-msvc
@valkvlabs/edgekv-linux-arm64-musl
```

All eight always carry the same version. The workflow does not publish them: it
**stages** them on npm, and they go public only when a maintainer approves each one
with 2FA.

### Once

- An npm account with 2FA turned on, and publish rights in the `valkvlabs` npm
  organisation.
- The repository secret `NPM_TOKEN` (Settings → Secrets and variables → Actions): an
  npm granular access token with **Read and write (stage only)** for `@valkvlabs`. It
  can stage versions but cannot make anything public by itself. Renew it before it
  expires.
- npm 11 or later on the machine you approve from: `npm i -g npm@11`.

### Each release

1. **Set the version** in every package and the native crate, and merge it to `main`:

   ```sh
   cd typescript
   npm run version:set 0.2.0
   ```

   This edits `typescript/package.json` (its version and its optional dependencies),
   the seven `typescript/npm/*/package.json` and `native/Cargo.toml`.

2. **Try it.** Actions → **npm** → Run workflow, tag `ts-v0.2.0`, **stage** off. It
   checks that the tag matches every file, then builds the native library on Linux
   (x64 and arm64, glibc and musl), macOS (Apple Silicon and Intel) and Windows (x64),
   and runs the tests on each build it can run. Nothing reaches npm.

3. **Stage it.** The same, with **stage** on. When it finishes, the run's summary lists
   the eight staged versions and their stage ids. You can also list them yourself:

   ```sh
   npm stage list @valkvlabs/edgekv
   npm stage list @valkvlabs/edgekv-linux-x64-gnu
   ```

4. **Approve them**, the seven platform packages first and `@valkvlabs/edgekv` last.
   The main package names the others as optional dependencies, so if it went public
   first, anyone installing it in between would get no native library and its local
   mode would fail with `UNSUPPORTED`.

   ```sh
   npm stage view <stage-id>                  # optional: what is in it
   npm stage approve <stage-id> --otp <code>
   ```

5. **Check it and create the GitHub Release.** Actions → **npm release check** → Run
   workflow, tag `ts-v0.2.0`. It installs the release from npm on Linux (glibc and
   musl, x64 and arm64), macOS and Windows, opens an encrypted local database with it,
   and, if all of that works, creates the tag `ts-v0.2.0` and its GitHub Release.

### Pre-releases

A version with a suffix, such as `0.2.0-beta.1` (tag `ts-v0.2.0-beta.1`), is staged
under the npm dist-tag `next` instead of `latest`, and its GitHub Release is marked as
a pre-release. `npm install @valkvlabs/edgekv` keeps installing the last full release;
`npm install @valkvlabs/edgekv@next` gets the pre-release.

### When something goes wrong

- **The tag does not match the files.** The workflow stops before building. Run
  `npm run version:set` with the right version, merge, run again.
- **A build or test fails.** Nothing has been staged. Fix it on a branch, merge, and
  run the workflow again with the same tag.
- **Staging stopped half-way.** Run it again with the same tag: packages already staged
  or published at that version are skipped.
- **A staged version is wrong.** Reject it instead of approving it, fix the cause, and
  stage again:

  ```sh
  npm stage reject <stage-id> --otp <code>
  ```

  The dist-tag of a staged version cannot be changed; reject it and stage it again.
- **A bad version is already public.** npm versions cannot be replaced. Release a fixed
  version with a higher number, and deprecate the bad one, which the stage-only token
  is still allowed to do:

  ```sh
  npm deprecate @valkvlabs/edgekv@0.2.0 "broken local mode on Windows; use 0.2.1"
  ```

- **The release check fails.** The packages are public but something is wrong with
  them; no GitHub Release is created. Look at which platform failed, then release a
  fixed version as above.

## Desktop application

1. Set the same version in `desktop/package.json`, `desktop/src-tauri/tauri.conf.json`
   and `desktop/src-tauri/Cargo.toml`, and merge it to `main`.
2. Actions → **Desktop release** → Run workflow, tag `desktop-v0.2.0`, **publish** off.
   It builds the Windows installers (`.msi`, `-setup.exe`) and the macOS (Apple
   Silicon) `.dmg`, and keeps them as workflow artifacts to try.
3. The same with **publish** on: the installers and `SHA256SUMS.txt` are attached to
   the GitHub Release `desktop-v0.2.0`.

Signing is optional. Without these repository secrets the installers are unsigned, and
Windows and macOS warn the person installing them:

| Platform | Secrets |
|---|---|
| Windows | `WINDOWS_CERTIFICATE` (base64 `.pfx`), `WINDOWS_CERTIFICATE_PASSWORD` |
| macOS | `APPLE_CERTIFICATE` (base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` |
