# ScreenPick

A fast, cross-platform screenshot, annotation, and screen-capture utility for
**macOS and Windows**. Capture a region, a window, or a whole display; mark it up
in a built-in editor; and copy it to the clipboard or save it to disk — all from
a small tray app driven by global shortcuts.

Built with [Tauri 2](https://v2.tauri.app/) (Rust) and
[Svelte 5](https://svelte.dev/).

## Features

- **Capture modes** — region select, window pick (click the window you want),
  full screen, pick-a-display, and a screen color picker.
- **Annotation editor** — arrows, shapes, freehand pen, text, highlighter, blur,
  crop, and cut, with undo/redo, pan, and zoom.
- **Global shortcuts** — trigger any capture mode from anywhere without focusing
  the app; shortcuts are configurable in Settings.
- **Clipboard & file export** — copy the result straight to the clipboard or save
  it, with a Recent captures list for quick re-export.
- **Lives in the tray** — stays out of your way and can start hidden at login.
- **Native capture backends** — uses the OS compositor for correct, crisp
  captures of GPU-composited windows on both platforms.

## Install

Download the latest installer from the
[Releases](https://github.com/tstone-1/screenpick/releases) page:

- **macOS:** `ScreenPick_<version>_universal.dmg` (one file, runs on Apple
  Silicon and Intel)
- **Windows:** `ScreenPick_<version>_x64-setup.exe`

### macOS first launch

ScreenPick is **not signed with an Apple Developer ID** (that costs $99/year),
so macOS Gatekeeper blocks it the first time. The app is fine — macOS just can't
verify the publisher. Open it once using either method below; afterwards it
launches normally with a double-click.

1. Open the `.dmg` and drag **ScreenPick** into **Applications**.
2. Clear Gatekeeper, then open:

   **Option A — Terminal (most reliable).** Removes the download quarantine flag:

   ```sh
   xattr -dr com.apple.quarantine /Applications/ScreenPick.app
   open /Applications/ScreenPick.app
   ```

   **Option B — no Terminal.** Double-click ScreenPick. When macOS refuses, go to
   **System Settings → Privacy & Security**, scroll to the message about
   ScreenPick being blocked, and click **Open Anyway**. Confirm once more when
   prompted.

> If you see **"ScreenPick is damaged and can't be opened"**, the app is *not*
> actually damaged — that is the quarantine message for unsigned apps. Use
> **Option A** above to clear it.

3. **Grant Screen Recording permission.** On first capture, macOS asks for it
   (or open **System Settings → Privacy & Security → Screen Recording** and
   enable ScreenPick). Relaunch the app afterwards — without this permission,
   captures come out black.

### Windows first launch

SmartScreen shows a **"Windows protected your PC"** dialog for unsigned apps.
Click **More info → Run anyway** to install.

## Build from source

Prerequisites: [Node.js](https://nodejs.org/) (with npm) and the
[Rust toolchain](https://www.rust-lang.org/tools/install) via `rustup`, plus your
platform's [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm install          # install JS dependencies
npm run tauri dev    # run the desktop app in dev mode
npm run tauri build  # produce installers for the current platform
```

Frontend-only and check/test commands:

```sh
npm run dev          # run the frontend only in a browser at http://localhost:1420
npm run build        # build the frontend bundle
npm run check        # type and Svelte checks
npm run test         # frontend checks, unit tests, and Rust tests
```

See [BUILD.md](BUILD.md) for the full build, test-gate, and release procedure.

## Troubleshooting

ScreenPick writes a diagnostic log (failures only by default) to the OS log
directory. Attach it when reporting a bug:

- **Windows:** `%LOCALAPPDATA%\com.tstone1.screenpick\logs\`
- **macOS:** `~/Library/Logs/com.tstone1.screenpick/`

If your saved preferences ever reset on their own, the log (and a startup
notification) will say why, and the previous settings file is preserved next to
the current one as `capture-settings.invalid-*.json`.

## Tech stack

- Tauri 2 desktop shell (Rust, `src-tauri/`).
- Svelte 5 + SvelteKit + TypeScript frontend (`src/`).
- Vite for bundling, Vitest for frontend unit tests, `cargo test` for Rust.
- Typed IPC between Rust and the frontend via `tauri-specta` (Rust is the source
  of truth for command and event shapes).

## Recommended IDE

[VS Code](https://code.visualstudio.com/) with the
[Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode),
[Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode),
and
[rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
extensions.

## License

[MIT](LICENSE) © Timo Stein
