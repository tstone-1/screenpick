# ScreenPick Roadmap

Live forward-looking plan for ScreenPick. Shipped work is tracked in the [CHANGELOG](CHANGELOG.md).

## Priority levels

- **P0 — Ship-blocking.** Required before any public release; nothing else should compete for time.
- **P1 — Next up.** Material user value or structural risk; sequence immediately after P0.
- **P2 — Later.** Useful features and quality investments; sequence by demand or when adjacent work touches the area.
- **P3 — Speculative.** Worth doing only if a real user asks; document so we do not forget the idea.

## In flight

_(nothing currently in flight — move items here from the priority sections as they start)_

---

## P0 — Ship-blocking

### 1. Package and release workflow
ScreenPick now has published builds — installers ship via tagged GitHub Releases (first cut: v26.7.4). What remains is hardening that release path, not creating it.

**Decision (2026-05-30): ship unsigned.** No $99/year Apple Developer ID and no
Windows code-signing cert for now. Builds are ad-hoc-signed so they run on Apple
Silicon; users bypass Gatekeeper / SmartScreen on first launch (steps in
`README.md`). Channel is **GitHub Releases**, built by
`.github/workflows/release.yml` on tag push. Remaining work below.

- Validate `npm run tauri build` end-to-end on macOS (Apple Silicon and Intel) and Windows (x64).
- App metadata, icons, version strings, bundle identifiers.
- ~~Decide and document the distribution channel~~ — done: GitHub Releases, unsigned.
- ~~Wire CI to build on tag pushes and upload artefacts~~ — done: `release.yml`.
- Verify the published draft release attaches both the universal macOS `.dmg` and the Windows installers.

**Deferred (revisit if Gatekeeper friction warrants the cost):**
- macOS: Developer ID Application cert, `notarytool` submission, stapling, hardened runtime.
- Windows: Authenticode signing cert (EV preferred) for SmartScreen reputation.

**Concrete recurring cost of staying ad-hoc-signed — the macOS Screen Recording
grant dies on every version bump.** macOS TCC keys the Screen Recording
permission to the app's code-signature Designated Requirement. Under ad-hoc
signing (`bundle.macOS.signingIdentity: "-"`) that DR is a per-build cdhash, so
each new release is a *different app* to TCC: System Settings still shows the
toggle ON, but capture is denied until the user **removes ScreenPick from the
list and re-adds it** (re-granting via the in-app banner alone does not always
take without a relaunch). A stable Developer ID identity + notarization yields a
fixed DR anchored to the Team ID, so the grant survives version bumps. This — not
Gatekeeper first-launch friction — is the main day-to-day reason to revisit the
deferral, and it's why the #2 permission banner tells users a relaunch may still
be needed.

### 2. macOS screen-recording permission onboarding
On macOS, capture silently produces a black/empty image until the user grants Screen Recording permission. First-time users would otherwise see "ScreenPick is broken" and uninstall.

**Largely delivered in v26.7.1.** The denied state is now detected and surfaced
with an actionable banner:
- ~~Detect `CGPreflightScreenCaptureAccess` state on startup and before each capture.~~ — done. `screen_recording_access` command (non-prompting preflight) polled on startup, on window focus, and after every failed capture; `ensure_screen_capture_access` still guards each capture command in Rust.
- ~~Onboarding card that explains the permission, deep-links into System Settings, and re-checks on window focus.~~ — done. Banner in the capture panel with an "Open Screen Recording settings" button (`open_screen_recording_settings` deep-links via `x-apple.systempreferences`), re-checked on focus so it clears on return.
- ~~Surface a clear error (not a blank image) when capture runs without permission.~~ — done. The permission `Err` propagates to the UI and re-surfaces the banner instead of a silent no-op.

Remaining: proactive first-run onboarding *before* the first capture attempt (today the banner appears after the first denied capture / on the startup poll), and the relaunch caveat that will disappear once signing is stable (see #1).

### 3. Auto-update channel
Without an updater, every released version is the last version a user runs. The first release (v26.7.4) shipped without one, so this is now a retrofit onto an installed base rather than a pre-launch decision — existing users will need to notice a new release and reinstall manually until this lands.

- Adopt `tauri-plugin-updater`.
- Sign update manifests with a Tauri update key (store the private key in 1Password, public key in `tauri.conf.json`).
- Host manifests on GitHub Releases or a static endpoint.
- UI: passive update banner with "Restart to update"; optional "Check for updates" in settings.

---

## P1 — Next up

### 4. Drag-and-drop / paste image import
Today the only way to get an image into the editor is to capture one. Users routinely want to annotate an image they already have (downloaded PNG, screenshot from another tool, image from clipboard).

- Drop a file onto the editor stage to open it as a capture.
- `Cmd/Ctrl+V` to paste a clipboard image into a new editor document.
- Reuse the existing `recentCaptures` store and `editor.openCapture` path; the new entry point only needs to materialise a `Capture` payload from a `File`/`Blob`.

### 5. Capture-with-delay (countdown)
Standard feature in every competing tool (Snipping Tool, CleanShot, Shottr). Lets the user set up the UI state being captured — open a menu, hover a tooltip, scrub a video — before the overlay appears.

- New capture mode: "Delayed full screen" with a 3/5/10 s picker.
- Countdown badge in the corner during the wait.
- Reuse the existing `PickerSession` lifecycle; only the trigger differs.

### 6. Pixelate annotation tool
Blur is implemented but pixelate is the more common redaction style for screenshots showing sensitive data (the rounded blur leaves shape hints; mosaic does not). Recommended as a separate tool rather than a mode toggle on blur, because users reach for them differently.

- Implement as a new `Tool` registry entry alongside `blur`.
- Extract and share a rect-drag controller with blur/highlight/shape as part of
  the first pixelate commit, so a fourth rectangle tool does not add a fourth
  copied gesture lifecycle.
- Canvas export path renders a downsample-then-nearest-neighbor block; SVG preview renders a CSS-filter approximation.

### 7. Number / step annotation tool
Auto-numbered circles (1, 2, 3, …) are the second most-requested annotation in tutorial workflows after arrows. Doing this by hand with the text tool is awkward.

- New `Tool` for placing numbered markers; counter increments per placement, resets per document, user-editable.
- Style: filled circle with contrasting digit, configurable radius and color.

### 8. Capture mouse cursor
Tutorial and bug-report screenshots usually want the cursor included. Currently the cursor is invisible in every capture.

- Add a setting `includeCursor: bool` (default off to match current behavior).
- macOS: query `NSEvent.mouseLocation` and composite onto the bitmap.
- Windows: `GetCursorInfo` + `DrawIcon`.

### 9. Long / scroll capture
Capturing a full webpage or chat history is the biggest feature gap between ScreenPick and CleanShot/Shottr. Hard to do well — stitching algorithms are subtle — so scope it down: capture a fixed region while the user scrolls, stitch by matching pixel rows between frames.

- New capture mode "Scrolling region": user picks a region, then scrolls; capture runs at e.g. 10 fps until they hit Stop.
- Stitching pipeline: sliding-window pixel-row match between consecutive frames; reject low-confidence matches.
- This is multi-week work. Build behind a feature flag and ship to opt-in users first.

### 10. Structured logging fields + IPC error codes (file sink shipped)
The core of the 2026-05-30 review's [N4] is **done**: `eprintln!` was replaced
with the `log` facade behind `tauri-plugin-log`, writing to a rotating file in
the platform log dir (plus stderr), and a settings-load failure now surfaces a
system notification instead of silently resetting to defaults. What remains is
the richer, optional work:

- Include session ids, monitor ids, window labels as structured fields (the
  `log` facade carries plain messages today; this would want `tracing` spans).
- Add `error_code` to the IPC error boundary so the frontend can disambiguate
  retryable vs. terminal failures.
- Optionally also surface the settings reset in-app on next open (currently a
  system notification + log line; an in-app banner would need a new IPC command,
  i.e. a `bindings.ts` regen on macOS).

### 11. Editor state, EditorStage + picker route tests
The 2026-05-30 review's test-coverage gap is partially closed (`captureOrchestration.test.ts` added) but `editor.svelte.ts`, `EditorStage.svelte` (~780 LOC), and the four picker `+page.svelte` files have limited direct tests. The next regression will land here.

- Headless editor-state tests for undo/redo snapshots, the 50-entry history cap, bounded annotation movement, committed text width stamping, stale selection deletion, and color-sample race guards.
- Component tests for `EditorStage`: pointer-event dispatch into the `Tool` registry, paint-order parity with `annotationsInPaintOrder`, crop overlay geometry.
- Behavior tests for each picker route: Escape cancels, confirm commits, the `selectionPending` guard prevents double-submit.

---

## P2 — Later

### 12. Image post-processing: rotate, flip, resize
Common quick-edit operations that today force users to round-trip through another tool. Cheap to implement — the canvas export pipeline already owns the bitmap.

### 13. Aspect-ratio presets for crop
1:1, 4:3, 16:9, current screen ratio. Drives the crop tool from `ToolProperties`.

### 14. Editable ScreenPick document format
Today, once a capture is exported as PNG, annotations are flattened and unrecoverable. A `.screenpick` (JSON + base64 PNG, or a zip) lets users re-open and edit. Useful for iterative bug reports.

### 15. Cloud upload / share link
Imgur, S3, or a generic POST endpoint. One-click share is what makes CleanShot's free tier sticky. Scope down: ship a "POST PNG to webhook URL" first, integrate specific providers later if users ask.

### 16. OCR — extract text from selection
"Copy text from this screenshot" is a high-value workflow. macOS has Vision framework (free, accurate); Windows has Windows.Media.Ocr. Per-OS implementations behind a single `commands.ocrRegion` command.

### 17. System tray / menu-bar quick access
**Delivered in part.** `src-tauri/src/tray.rs` ships an always-present tray icon (Show/Quit menu, left-click restores the window) so the app is reachable without the main window open. Remaining: capture-mode entries directly on the tray menu (region/window/screen) and a recent-captures submenu — today the tray only shows/quits, so a capture still has to go through the global shortcuts or the main window.

### 18. Recent-captures persistence + management
**Persistence and delete-from-list are done.** The document store
(`src-tauri/src/documents.rs` + `src/lib/documentStore.svelte.ts`) persists the
strip across restarts, with retention/eviction of clean documents, and
`editor.closeDocument` removes an entry from the list and disk. Remaining:
pagination and search by filename for the strip.

### 19. Color palette / swatches
The color picker now keeps auto-recents in the `ToolProperties` panel. Remaining gap: a saved/pinned palette for colors users want to keep across sessions.

### 20. Magnifier / loupe overlay during region selection
Pixel-perfect region selection currently has no magnifier. Hover loupe showing the pixel under the cursor at, say, 8x makes precise selections possible.

### 21. Dark theme
Single-theme apps feel dated. Defer until packaging is done — theming churn during an active design phase wastes work.

### 22. Telemetry and crash reporting
Sentry or a self-hosted PostHog. Opt-in. Without this, every released version is shipped blind.

---

## P3 — Speculative

- **Speech-bubble / callout shapes.** Common in marketing screenshots; low priority for a developer-tool audience.
- **Custom shapes library.** Same caveat.
- **Internationalisation.** Wait for actual non-English-speaking user demand; the UI surface is small enough to translate quickly when the time comes.
- **Open-with external app.** "Edit in Photoshop / Preview / Paint" handoff. Niche; rotate/flip/resize covers the common case.
- **Video capture.** A different product. Resist.
- **Browser-tab / window-content capture (DOM-aware).** A different product. Resist.

---

## Technical debt log

Cross-cutting cleanups that do not justify their own roadmap entries but should be picked up when adjacent code is touched:

- **Delete `screenSelectionEvents.ts`** (6-line module, one type + one string constant). Inline into `screen-picker/+page.svelte` and the `bindings.ts` consumer. (Review [N1].)
- **Extract `usePickerSession({ onConfirm, onCancel })`** to dedupe the `selectionPending` + Escape + try/finally-around-IPC scaffolding across the four picker routes. The fourth copy proves the pattern is stable, and capture-with-delay should not become a fifth copy. (Review LLM code-smell scan.)
- **Watch specta's `f64` TypeScript mapping for `WindowBounds`**. Rust already stores plain `f64`, but the generated bindings expose `number | null`, so `windowPickerCommands.ts`'s `StrictWindowBounds` narrowing is load-bearing until specta can emit non-null numeric fields here. (Review LLM code-smell scan.)
- **Schema versioning beyond `version: u32`.** Settings now have a version field, but no migration framework. The first time we rename or change a field, add a `migrate(old, version) -> CaptureSettings` function rather than just bumping the number.
- **Text annotation re-editing.** A placed text annotation's *content* cannot be edited after commit — only its style (color, font size). It needs its own draft/commit flow that re-enters the text input bound to the existing annotation. (Tracked from the `ToolProperties.svelte` text branch.)
