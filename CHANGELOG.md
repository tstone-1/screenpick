# Changelog

All notable changes to ScreenPick are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [CalVer](https://calver.org/) `YY.M.MICRO` versioning
(see [BUILD.md](BUILD.md#version-management)).

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
