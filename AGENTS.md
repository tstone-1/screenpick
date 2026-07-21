# ScreenPick Agent Notes

## Project

ScreenPick is an open-source cross-platform screenshot, annotation, and screen utility app for macOS and Windows.

## Stack

- Tauri 2 desktop app.
- Rust backend in `src-tauri/`.
- Svelte 5 + SvelteKit (static adapter) + TypeScript frontend in `src/`.
- Vite build tooling; Vitest for frontend unit tests, `cargo test` for Rust.
- npm is the JavaScript package manager for this repo.

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

- `xcap` (pinned `=0.9.6`) — screen/window/region capture. Pin is load-bearing:
  `capture_window_at_point` relies on `Window::all()` front-to-back order on macOS.
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

## Building & verifying

- Build, test-gate, and release procedures live in [BUILD.md](BUILD.md) — including
  two local-build gotchas: run `npm ci` first, and on Windows close every running
  ScreenPick instance before `npx tauri build` (a live process locks
  `target\release\screenpick.exe`; the failure only surfaces after the full compile).
- **Verifying capture-backend changes:** don't hand-drive the picker overlay
  (clicking a target window in it isn't scriptable). Write a tiny standalone
  scratch crate pinned to the same `xcap = "=0.9.6"` and call `Window::all()` +
  `Window::capture_image()` against a live target window — the identical API
  `write_window_capture` uses (`src-tauri/src/capture.rs`), so it faithfully
  reproduces real behavior in seconds. Gate the backend behind a cargo feature
  (`xcap/wgc`) and run with and without `--features wgc` for a clean before/after.
  **Look at the actual output PNGs** — pixel-statistic heuristics mislead (a
  correct light-theme Task Manager capture is ~60% near-white; a blank GDI
  failure can read 0% if it grabbed dark frame chrome). Capture a known
  GPU-composited window (Task Manager, Settings); this is how the v26.6.23
  blank-capture fix was confirmed.

## Platform Notes

- On macOS, window capture can enumerate only `Menubar`; this is the top-of-screen menu bar owned by ScreenPick next to the Apple menu.
