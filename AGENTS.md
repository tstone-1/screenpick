# ScreenPick Agent Notes

## Project

ScreenPick is an open-source cross-platform screenshot, annotation, and screen utility app for macOS and Windows.

## Stack

- Tauri 2 desktop app.
- Rust backend in `src-tauri/`.
- Svelte 5 + SvelteKit (static adapter) + TypeScript frontend in `src/`.
- Vite build tooling; Vitest for frontend unit tests, `cargo test` for Rust.
- npm is the JavaScript package manager for this repo.
- TypeScript 7 is installed as `@typescript/native` (npm alias); TypeScript 6
  remains installed for Svelte's JavaScript compiler API. `npm run check` runs
  both `--tsgo` and the classic checker: with svelte-check 4.7.6, a missing
  `.svelte` import passes tsgo but fails the classic check (measured using an
  isolated synthetic component). Keep both until that gap is fixed; recheck
  with a failing control before removing the classic pass. Watch mode uses
  the classic checker.

### Typed IPC contract

- `specta` + `tauri-specta` (pinned `2.0.0-rc.25`) generate `src/lib/bindings.ts`
  from the Rust commands/events, so **Rust is the source of truth** for IPC shapes.
- Regenerate with `BINDINGS_UPDATE=1 cargo test export_typescript_bindings`. The
  default `cargo test` asserts `bindings.ts` matches the live contract and fails
  on drift. **Note:** this test is gated to macOS/Linux (`cfg(all(test, not(target_os = "windows")))`),
  so it does not run on Windows — regenerate/verify bindings on a Mac or in CI.
- **Gotcha:** `///` doc comments on a specta-exposed command, type, or field are
  emitted as JSDoc in `bindings.ts`. Existing exposed items use plain `//`
  comments, so the committed bindings have no JSDoc. Use `//` on exposed items
  (or regenerate the bindings) to avoid a drift failure that only surfaces on
  the macOS/Linux CI check, not on a Windows `cargo test`.

### Key Rust crates

- `xcap` (pinned `=0.9.8`) — screen/window/region capture. Pin is load-bearing:
  `capture_window_at_point` relies on `Window::all()` front-to-back order on macOS.
  The 0.9.8 update retains byte-identical macOS/Windows implementations and the
  public Window API from 0.9.6; recheck ordering before changing the pin again.
- `arboard` — clipboard image read/write.
- `tauri-plugin-global-shortcut`, `tauri-plugin-dialog` — capture shortcuts and file dialogs.
- macOS-only: `objc2-core-graphics` for Screen Recording permission preflight.

## Commands

- Install dependencies: `npm install`
- Frontend dev server: `npm run dev`
- Tauri desktop dev app: `npm run tauri dev`
- Frontend build: `npm run build`
- Type and Svelte checks: `npm run check`

## Conventions

- Keep native OS integrations in Rust/Tauri commands or plugins.
- Keep direct frontend Tauri API imports in small adapter modules (for example
  `editorCommands.ts`), not in orchestration or editor state classes.
- Keep UI state and editor interactions in Svelte components unless native access is required.
- Support macOS and Windows as first-class targets.
- Use ASCII-only console output in scripts and app diagnostics.
- On Windows, `cargo test` excludes the GUI modules (they are gated
  `cfg(not(all(test, target_os = "windows")))`), so it does **not** compile
  `lib.rs`, `capture.rs`, `settings.rs`, `region.rs`, etc. A green Windows
  `cargo test` only covers the pure modules — verify the rest with `cargo check`
  (or a real build), not `cargo test`.
- **Never compare `$state`-held objects with `===`, and never write a test that
  depends on that comparison under the default `node` environment.** Svelte's
  client runtime deep-proxies `$state`, so an object read back out of a state
  field is a *proxy*: it is never `===` to the raw object it wraps, and two
  state fields holding the same object hand out two different proxies
  (`this.document.capture === this.recentCaptures[0]` is false even when both
  are the same capture). Match on a stable key instead — `path`, or
  `workspaceKeyFor`.

  The suite cannot see this by default. `.svelte.ts` modules imported under
  `environment: "node"` (vitest.config.ts's default) are compiled in **SSR
  mode**, where `$state` is a plain value and no proxy exists — measured, not
  assumed: `util.types.isProxy` reports `false` for every state value there and
  identity comparisons hold. This cost a real bug that shipped for months:
  `#attachDocumentIdentity` matched the new document against the open capture
  with `capture === original`, which passed every node-mode test and could
  never be true in the app, so every capture kept a null `documentId` and every
  annotation save and crop re-base returned before touching disk (26.9.1).

  Any test whose subject is object identity, proxy behaviour, or reactivity
  therefore needs a `// @vitest-environment jsdom` docblock, which selects the
  client runtime. `editorDocumentIdentity.component.test.ts` is the worked
  example: its assertions go red against the old code under jsdom, and the
  identical file with the docblock removed passes against that same broken code.

  **That docblock is a comment, so nothing enforces it** — a typo in it, a
  config edit, or a change in how the runner selects per-file environments
  would return the file to the blind default silently and while staying green.
  So the file opens with a test that asserts the proxy is live (`openCapture`
  puts a capture into `$state`; reading it back must NOT be `===` to the object
  passed in). Copy that control into any new file that depends on the client
  runtime — and verify it can fail, by running the file once with the docblock
  removed, rather than trusting that it passed.

## Building & verifying

- Run dependency experiments in a directory outside the active dev checkout.
  Vite watches nested `tsconfig.json` and HTML files even when their modules are
  not imported: a nested staging build can reload the running editor or stop
  its dev server. A nested `.gitignore` does not isolate the watcher.
- Build, test-gate, and release procedures live in [BUILD.md](BUILD.md) — including
  two local-build gotchas: run `npm ci` first, and on Windows close every running
  ScreenPick instance before `npx tauri build` (a live process locks
  `target\release\screenpick.exe`; the failure only surfaces after the full compile).
- **Windows HDR capture:** `capture_backend` routes advanced-color displays
  through `windows_capture` (float scRGB WGC), normalizes by the target display's
  live `DISPLAYCONFIG_SDR_WHITE_LEVEL / 1000`, then encodes sRGB. xcap's 8-bit
  WGC output can clip before the app receives it; changing the saved PNG's gamma
  cannot recover those pixels. A window and its monitor can behave differently:
  reproduce with the actual failing window, not just a monitor capture. A prior
  non-reproduction did not establish a driver glitch. Regression checks need
  both an affected window and known SDR colors; a merely darker image is not
  proof of correct normalization. HDR highlights beyond SDR white are clipped
  on SDR export; this is not a perceptual tone mapper for HDR video.
  `src-tauri/examples/capture-color-probe.rs` exercises the production backend
  and generates a known-color chart; its header has the commands. Keep captured
  desktop images outside the repository.
- **Verifying capture-backend changes:** don't hand-drive the picker overlay
  (clicking a target window in it isn't scriptable). Use the color probe above:
  it calls `capture_backend`, the same boundary as `write_window_capture`, and
  saves xcap's uncorrected output alongside the result. Calling only
  `Window::capture_image()` bypasses the HDR correction. Its `--verify` option
  checks known colors, and `--display` also checks screen and region capture.
  **Look at the actual output PNGs** — pixel-statistic heuristics mislead (a
  correct light-theme Task Manager capture is ~60% near-white; a blank GDI
  failure can read 0% if it grabbed dark frame chrome). Capture a known
  GPU-composited window (Task Manager, Settings); this is how the v26.6.23
  blank-capture fix was confirmed.
- **The updater's minisign private key is the most safety-critical secret here.**
  It lives in KeePass and in the `TAURI_SIGNING_PRIVATE_KEY` /
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repo secrets; the public key is committed
  in `tauri.conf.json`. Losing it permanently orphans every installed copy — a
  new key cannot sign for clients holding the old public key, so each user would
  have to reinstall by hand. It is unrelated to OS code signing and is not fixed
  by adding an Apple Developer ID. Never print, echo, or paste the private key
  into a tool call; regeneration and rotation live in
  [BUILD.md](BUILD.md#updater-signing-key).
- **A release with no `latest.json` updates nobody, and looks green.** When the
  signing secret is missing or empty, `tauri-action` logs "Signature not found
  for the updater JSON. Skipping upload..." and still succeeds. The release
  ships with installers and no manifest, and the failure only surfaces as users
  silently never updating. BUILD.md's post-publish checks exist for this.
- **A signed-but-not-notarized macOS build also looks green.** If notarization
  credentials are missing or malformed the bundler logs `skipping app
  notarization` and succeeds; Gatekeeper then rejects the app on any machine
  that has never seen it. Never treat a successful signed build as verified —
  run `xcrun stapler validate` and `spctl`. Note this is a *different* key from
  the updater's minisign key, and losing it is recoverable. Setup, env-var
  precedence, and verification live in
  [BUILD.md](BUILD.md#macos-code-signing-and-notarization).
- **The signing identity is shared with `dblitz`, so rotating it is a two-repo
  event.** A Developer ID Application certificate certifies the team
  (`NVX72G8SJ8`), never one app, and Apple caps the account at 5 of them — so
  `dblitz` reuses this certificate and the same App Store Connect `.p8`
  notarization key rather than minting its own (since dblitz 26.7.6). Renewing
  or revoking it means updating `APPLE_CERTIFICATE` /
  `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` in **both** repos'
  secrets. Forget one and that repo silently drops to
  signed-but-unverifiable on its next release — which, per the point above,
  still looks green.
- **The release matrix must stay `max-parallel: 1`.** `tauri-action` builds
  `latest.json` by read-modify-write against the release asset, so parallel legs
  can clobber each other's platform entries and produce a manifest that updates
  only one OS. Nothing fails; the manifest is just incomplete.
- **Post-release commits need a version bump.** A commit landing after a release
  tag without bumping the CalVer version silently ships in the *next* build while
  the titlebar still shows the old number. When a just-released feature "doesn't
  work", check `git log <latest-tag>..HEAD` before debugging: if the feature
  commit sits after the tag, the installed build simply predates it — it needs a
  version bump + rebuild, not a code fix. The titlebar version alone never proves
  a feature is present in the running build.
- **"Did the annotation save actually happen?" is answered on disk, not in the UI
  and not in the log.** An unsaved document is invisible from the front: the
  Recent thumbnail and drag-out both read `current.png`, and `create_document`
  seeds that file as a byte copy of `base.png` — so a document whose save never
  ran hands other apps a real, openable, un-annotated PNG that looks like a
  correct file. Read the store instead
  (`%LOCALAPPDATA%\com.tstone1.screenpick\documents\<doc-id>\`, macOS
  `~/Library/Application Support/com.tstone1.screenpick/documents/<doc-id>/`);
  three signals each say "never saved", and they agree or something else is
  wrong:
  - `annotations.json` is 2 bytes — the `[]` written at creation.
  - `current.png` has the same size *and* mtime as `base.png` — still the seed
    copy, never re-rendered.
  - the entry in `documents/index.json` has `updatedAt == createdAt` and
    `dirty: false`.

  **An editor crop is the cheapest probe**, because `applyCrop` calls
  `#persistCurrentDocument({ replaceBase: true })` unconditionally on success and
  that rewrites `base.png`. A `screenpick-crop-*.png` in the save directory whose
  `base.png` still holds the pre-crop capture at its creation timestamp proves the
  persist path did not run — no annotation needed, and no reliance on what the
  editor was showing at the time.

  ⚠ **On a build before 26.9.0 an empty diagnostic log proves nothing about the
  save path.** Three exits returned without logging anything — a refused
  `create_document`, a refused `replace_document_base` / `save_document`, and the
  `documentId` check inside `#persistCurrentDocument` — so "no errors in
  `logs/ScreenPick.log`" was read as "the save ran and something else is at
  fault", which is backwards. All three log from 26.9.0 on; on anything older,
  go to the store.

  **The fault those log lines were added to catch was found on the first
  occurrence and fixed in 26.9.1**, so this section now reads as history plus a
  live tripwire. The cause was `#attachDocumentIdentity` matching the new
  document against the open capture by object identity — impossible under
  Svelte's state proxies (see the `$state` bullet under Conventions). The two
  log lines that named it are worth recognising verbatim, because together they
  are the signature of a capture that can never be saved:

  ```
  WARN document identity not attached to the open capture (id=..., path=...)
  WARN save skipped: open capture has no documentId (path=..., annotations=N, replaceBase=...)
  ```

  The first is a post-condition in `#attachDocumentIdentity` and stays in place.
  If it ever fires again, the capture on screen has no `documentId` and every
  save from that point is a silent no-op — go straight to that method, not to
  the IPC layer, because nothing failed there.

- **A capture cannot be saved until its `create_document` resolves, ~40 ms after
  it appears — and work started inside that window can be damaged permanently,
  not just delayed.** Every write path returns early without a `documentId`.
  For an annotation that is harmless (the identity arrives and
  `#attachDocumentIdentity` schedules the save), but a crop or cut is not:
  `rebasedCapture` copies the `documentId` forward, so one started too early
  produces a capture carrying no id **at a new path**, which the arriving record
  can no longer match by path — unsaveable for the rest of the session, and
  invisible to the post-condition above precisely because the paths differ.

  Saves bind their capture and annotation snapshot before waiting for creation;
  shutdown drains both those waits and the store's write queues. Never read the
  live document after an await to decide which document an earlier edit belongs
  to. Crop/cut also compare a document generation across awaits, so switching,
  undoing or editing discards stale completion. Persistence identity is kept
  outside undoable state and restored onto early snapshots/workspaces by path.

  `#pendingCreates` is keyed by capture path because rapid captures overlap;
  creation of one capture must not release another capture's operation.

- Startup quarantines unindexed document folders under `documents/recovered/`.
  A valid index can be a replacement written after corruption recovery, so its
  omission of an old folder never proves that deleting the folder is safe.
  Recovery tests must span corruption, a new capture, and a later startup.

## Platform Notes

- On macOS, window capture can enumerate only `Menubar`; this is the top-of-screen menu bar owned by ScreenPick next to the Apple menu.
