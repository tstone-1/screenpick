# Changelog

All notable changes to ScreenPick are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [CalVer](https://calver.org/) `YY.M.MICRO` versioning
(see [BUILD.md](BUILD.md#version-management)).

## [26.8.0] - 2026-08-06

### Fixed

- **Quitting immediately after an edit could lose that edit.** The exit
  handshake waited only for a document save whose debounce timer had not fired
  yet; a save already in flight was invisible to it, so quitting during the
  write let the process die mid-save. Saves for one document could also overlap
  and land out of order, leaving an older annotation layer on disk. Saves are
  now serialized per document and the exit handshake waits for all of them.
- **A finished picker selection could act on the wrong session.** Confirming a
  selection whose session had already been cancelled (for example via Escape
  racing the click) was treated as an unconditional cancel — if a new picker
  session had started in the meantime, the stale confirmation tore it down and
  captured with the old selection. A finish on a dead session now just reports
  it was cancelled.
- **The screen-capture hotkey ignored "Bring to front on hotkey capture".**
  With ScreenPick closed to the tray and the setting off, capturing the screen
  under the cursor popped the main window to the foreground anyway; it now
  honors the setting the same way the window-capture hotkey does. A main window
  that was visible before the shot still comes back afterwards.
- **Flipping a setting during the first moments after launch could reset the
  others.** A settings save that raced the initial settings load wrote built-in
  defaults over the stored save folder and shortcuts, and could clear the
  stored "last run" version that drives the macOS screen-recording re-grant
  notice after updates. The backend now keeps its own fields regardless of what
  a save sends, and the app refuses to save until settings have loaded.
- **A hand-edited or truncated annotations file no longer breaks the editor.**
  Structurally incomplete annotation entries (missing points, malformed
  geometry) are dropped on load instead of crashing the document open on every
  attempt; oversized document manifests and annotation layers are set aside and
  reported the same way corrupt settings already were.
- **Releases are now type-checked.** The release pipeline ran tests but not the
  TypeScript/Svelte check, so a type error that still produced valid JavaScript
  could ship installers while regular CI failed in parallel.
- **A chord bound twice under different modifier spellings now surfaces in the
  editor** instead of only as a registration failure. `Cmd+Alt+Shift+4` and
  `Cmd+Shift+Alt+4` are one chord to the OS but two different strings, so a
  duplicate went unnoticed until the second registration was refused — with an
  error that names no owner. Accelerators are now compared in a canonical form
  (modifiers deduplicated and ordered, `CommandOrControl` resolved per platform).
- **Moving between two shortcut fields could swallow the next chord.** The old
  field's re-register and the new field's suspend were independent async
  handlers, so the re-register could land last and leave the global shortcuts
  armed while recording — at which point the OS consumed the chord instead of
  the recorder. Those steps now run strictly in order.

### Changed

- **A recorded shortcut now takes effect when you click away from the field.**
  Recording used to write to a draft that did nothing until you found the
  "Apply shortcuts" button at the bottom of the section — so the natural way to
  check a new binding, pressing it, always failed, and the assignment looked
  broken rather than unsaved. Blur is now the commit point and the Apply button
  is gone. Removing a row saves itself, because the click that removes it also
  blurs the field and that blur runs first, on the pre-removal draft.

### Added

- **Each shortcut row says whether it is live**: `Active` once the OS accepted
  it, the reason if it refused, or `Already used by another mode` when the same
  chord is bound twice. The status is hidden while a field is focused, where it
  would describe the previous binding — recording suspends the global shortcuts,
  so nothing is registered until blur.

## [26.7.7] - 2026-07-26

### Fixed

- **macOS: the picker overlay bled into the capture.** Region captures came out
  with the selection rectangle's teal tint baked in (and the window/screen
  paths could keep their overlay or the main window in the shot). The pickers
  hid the overlay and then slept to let it leave the compositor, but a
  synchronous Tauri command runs on the main thread — the same thread that has
  to apply the hide — so the sleep blocked the very work it was waiting for.
  The hide/settle/capture sequence now runs off the UI thread.
- **macOS: the default capture shortcuts were unusable or harmful.** Region
  defaulted to `Cmd+Shift+4`, which is the system screenshot hotkey — the
  WindowServer handles it first, so ScreenPick never saw the press. Screen and
  window defaulted to `Cmd+Shift+S` and `Cmd+Alt+W`, which a global hotkey takes
  away from every other app ("Save As", "Close All Windows"). The macOS defaults
  now add Option: `Cmd+Shift+Alt+4` / `+S` / `+W`, with `Cmd+Shift+Alt+D` for
  "Pick display". Windows defaults are unchanged, and existing custom shortcut
  overrides are untouched.
- The editor's Copy and Export buttons no longer change width while the action
  runs, which nudged the whole button cluster sideways on every click.
- **The shortcut recorder could not record a chord ScreenPick already owned.**
  A registered global shortcut is consumed by the OS system-wide, including
  while ScreenPick has focus, so the recording field never received a key event
  for it — pressing a mode's current binding, or one another mode held, did
  nothing at all. The global shortcuts are now released while a shortcut field
  has focus and re-armed when it loses focus.
- **Every log record was written to the log file twice.** `tauri-plugin-log`'s
  builder defaults to `[Stdout, LogDir]` and `target()` *appends* to that, so
  adding `LogDir` and `Stderr` that way produced `Stdout + LogDir + LogDir +
  Stderr` — a doubled log file (halving the rotation threshold) and output on
  both stdout and stderr. It now uses `targets()`, which replaces the list.
- **Settings card contents spilled over its right border.** The card is a
  single-column grid whose track was sized to the widest row in it — the
  shortcut inputs, which carry a browser default intrinsic width — so every
  other row inherited that width and overflowed the card, buttons and wrapped
  labels alike. The card's column is a fixed 236-264px and cannot grow, so its
  contents now shrink to fit. The capture-mode list is hardened the same way.

### Changed

- macOS renders shortcut chords as modifier glyphs (`⌘⇧⌥4`) instead of running
  the names together (`CmdShiftOption4`). The shortcut editor shows that
  rendering too, instead of the raw `CommandOrControl+Shift+Alt+4` accelerator,
  which did not fit its column.
- The shortcut editor notes on macOS that `⌘⇧3/4/5` belong to the system
  screenshot service and cannot be recorded — pressing one there fires Apple's
  screenshot picker rather than registering, because the WindowServer consumes
  the chord before ScreenPick receives a key event.

## [26.7.6] - 2026-07-25

### Added

- **In-app updater.** ScreenPick checks GitHub Releases for a newer version,
  verifies the download's signature, installs it and restarts. A banner offers
  the update; a "Check for updates" button and an opt-out toggle live in
  Settings, and the tray menu has a "Check for Updates..." item. Update
  payloads are signed and verified before install.
- Settings now shows the running version.
- **macOS builds are signed with an Apple Developer ID and notarized by Apple.**
  No Gatekeeper bypass on first launch, and no more "ScreenPick is damaged"
  message. Windows remains unsigned.

### Fixed

- **macOS Screen Recording permission now survives updates.** Ad-hoc-signed
  builds had no stable identity, so macOS treated every update as a different
  app and silently dropped the grant, leaving captures black. A Developer ID
  identity is stable across versions, so the grant persists. Updating *to* this
  version breaks it one final time, because the signing identity itself changes.

### Note for existing installs

Builds before 26.7.6 have no updater and cannot be reached by it — install this
version manually, once. Updates from 26.7.6 onward are offered in-app.

## [26.7.5] - 2026-07-23

### Fixed

- Documents-manifest writes now hold an explicit lock, preventing a race
  between concurrent saves.
- Settings and documents now share a unified atomic-write path (fsync plus a
  Windows-specific fallback), closing a window where a crash mid-write could
  corrupt either file.
- Frontend errors are now forwarded to the on-disk diagnostic log file
  instead of only the browser console.
- Failed document deletions are no longer silently ignored.
- Startup restore no longer drops a capture completed while the persisted
  document list was still loading.
- Release workflow now runs the frontend and Rust test suites before
  building installers, so a tag on a broken commit can no longer produce
  release artifacts.

### Added

- Tests covering recent-captures retention and eviction logic.

### Changed

- Removed unused SvelteKit/Tauri template assets.
- Added public-repo package metadata (license, repository, homepage).
- Corrected documentation that still described the repo as private or
  described shipped features (published builds, the system tray, persisted
  recent captures) as not yet built.

## [26.7.4] - 2026-07-21

### Added

- Initial public release of ScreenPick — a cross-platform screenshot,
  annotation, and screen-capture utility for macOS and Windows. Region, window,
  and full-screen capture; an annotation editor (arrows, shapes, text,
  highlighter, blur, crop); clipboard and file export; global capture shortcuts;
  and a system-tray workflow.
