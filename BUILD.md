# ScreenPick — Build Instructions

ScreenPick is a Tauri 2 (Rust) + SvelteKit 5 (TypeScript) desktop app targeting
**macOS** (Apple Silicon + Intel) and **Windows** (x64).

> **Distribution model:** ScreenPick is distributed **unsigned** — no Apple
> Developer ID, no notarization, no Windows Authenticode cert. Builds are
> ad-hoc-signed (`bundle.macOS.signingIdentity: "-"` in `tauri.conf.json`) so
> they launch on Apple Silicon, but end users must bypass Gatekeeper /
> SmartScreen on first launch. The user-facing steps live in the **Install**
> section of [`README.md`](README.md). Signing/notarization remains deferred in
> [`ROADMAP.md`](ROADMAP.md) under **P0 #1**.

## Prerequisites

- **Node.js** 24+ (Active LTS; matches CI, `.nvmrc`, and Vite's supported runtime).
- **Rust** latest stable via [rustup](https://rustup.rs/).
- **ripgrep** (`rg`) — used by the release-checklist verification commands.
- **macOS**: Xcode Command Line Tools (`xcode-select --install`). No signing
  certificate is required — builds are ad-hoc-signed. For a universal binary,
  add both Rust targets: `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.
- **Windows**: Visual Studio Build Tools with the "Desktop development with C++"
  workload. WebView2 runtime (ships with Windows 11 and recent Windows 10).

## Development

```sh
npm install          # install JS dependencies
npm run tauri dev    # run the desktop app with hot-reload (Rust auto-recompiles)
npm run dev          # frontend only, in a browser at http://localhost:1420
```

### Code Quality Commands

```sh
# Frontend type + Svelte checks
npm run check

# Frontend unit tests (Vitest)
npm run test:unit

# Full test suite: frontend checks + unit tests + Rust tests
npm run test

# Rust check / lint / test / format (no `cd` — use --manifest-path)
cargo check   --manifest-path src-tauri/Cargo.toml
cargo clippy  --manifest-path src-tauri/Cargo.toml
cargo test    --manifest-path src-tauri/Cargo.toml
cargo fmt     --manifest-path src-tauri/Cargo.toml          # apply
cargo fmt     --manifest-path src-tauri/Cargo.toml --check  # CI-style, fails on diff
```

## Build Output

```sh
npm ci          # sync node_modules with the lockfile first (see note)
npx tauri build
```

> **Run `npm ci` before a local build.** `npx tauri build` runs
> `npm run build` as its `beforeBuildCommand`, which fails hard if `node_modules`
> is out of sync with `package-lock.json` (e.g. a dependency was added on another
> machine but never installed here). The failure surfaces as a Rolldown
> "failed to resolve import" error, not an obvious "missing dependency" message.
> CI always starts from a clean install, so this only bites local builds. `npm ci`
> installs exactly the lockfile and is the safe pre-build step.

> **Close running ScreenPick instances before a Windows build.** `npx tauri build`
> fails near the end with `failed to remove file ...\target\release\screenpick.exe`
> / `Access is denied. (os error 5)` when any screenpick process is running —
> including dev/test launches from `target\release\deps\` — because a live process
> keeps the portable exe mapped. The failure only surfaces *after* the long Rust
> compile, so check first: `Get-Process screenpick` and, once any unsaved work is
> confirmed safe to lose, `Stop-Process -Name screenpick -Force`. Single-instance
> enforcement (v26.6.13) reduces strays but a running app still locks the exe.

Artifacts land in `src-tauri/target/release/bundle/`:

### macOS
- `macos/ScreenPick.app` — application bundle.
- `dmg/ScreenPick_<version>_<arch>.dmg` — disk image installer.
- Build per-arch with `--target aarch64-apple-darwin` / `--target x86_64-apple-darwin`,
  or a universal binary with `--target universal-apple-darwin`.

### Windows
- `nsis/ScreenPick_<version>_x64-setup.exe` — NSIS installer.
- `msi/ScreenPick_<version>_x64_en-US.msi` — MSI installer.
- Portable executable: `src-tauri/target/release/screenpick.exe`.

## Release Procedure

### 1. Pre-release Checklist

**Update toolchains and dependencies:**
- [ ] `rustup update stable`
- [ ] `cargo update --manifest-path src-tauri/Cargo.toml` — review major bumps against changelogs.
- [ ] `npm update && npm outdated` — review remaining majors individually.
- [ ] `cargo audit -f src-tauri/Cargo.lock` (install: `cargo install cargo-audit`) — run from
      `src-tauri/` so it picks up `.cargo/audit.toml`. Expect a **clean exit** (only the
      pre-triaged "allowed warnings" — unmaintained gtk3-family crates, `paste`, `anyhow`
      1.0.102, `memmap2` via pinned xcap — none actionable). If `cargo audit` reports a
      new, non-allow-listed vulnerability, that is a real release blocker: do not add it to
      `.cargo/audit.toml` without recording the same reviewed/accepted/revisit-condition
      reasoning the existing quick-xml entries carry (see the comments in that file). A
      release must not ship with an unreviewed red `cargo audit`.
- [ ] `npm audit`.

**Code quality:**
- [ ] `npm run check` passes.
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml` is clean.
- [ ] `npm run test` passes (frontend checks + unit + Rust tests run via `cargo test` on
      Windows).
- [ ] **macOS bindings drift guard — hard gate, cannot be skipped:**
      `cargo test --manifest-path src-tauri/Cargo.toml export_typescript_bindings` run on
      **macOS** (or any non-Windows box/CI runner). This is the only test that actually
      exercises `export_typescript_bindings`/`specta_builder` — see the comment at the
      `cfg(not(all(test, target_os = "windows")))` gate atop `src-tauri/src/lib.rs` for why
      it cannot run on Windows (a `cargo test` binary never gets the Windows GUI manifest
      `tauri_build` embeds into the real app, so the linked-in Tauri GUI stack fails to even
      start the test process — verified, not a shortcut). Development and CI both currently
      happen without this check running automatically, so it is manual and mandatory: **do
      not tag a release without running it on a Mac and getting a pass.** After an IPC
      change, run it with `BINDINGS_UPDATE=1` first to regenerate `src/lib/bindings.ts`,
      commit that, then re-run without the env var to confirm it's back in sync.
- [ ] Manually smoke-tested via `npm run tauri dev`.

**Version & documentation:**
- [ ] Bump the version in all four files (must match exactly):
  - `package.json` (line 3)
  - `package-lock.json` (top-level and root package)
  - `src-tauri/Cargo.toml` (line 3)
  - `src-tauri/tauri.conf.json` (line 4)
- [ ] Verify the four agree, and that `Cargo.lock` was regenerated:
  ```sh
  rg -n '"version"|^version =' package.json package-lock.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
  cargo check --manifest-path src-tauri/Cargo.toml   # refreshes Cargo.lock
  ```
- [ ] Move the `CHANGELOG.md` entry from `Unreleased` to `[YY.M.MICRO] - YYYY-MM-DD`.

### 2. Build Release

```sh
npx tauri build
```

### 3. Verify the unsigned build

No signing or notarization step — the bundle is ad-hoc-signed by the build.
Sanity-check the macOS bundle:

```sh
# Should report the binary is ad-hoc signed (the "Signature=adhoc" line).
codesign -dv src-tauri/target/<target>/release/bundle/macos/ScreenPick.app

# Expected to FAIL with "rejected / Unnotarized Developer ID" — that is correct
# for an unsigned app. Distribution relies on the user's Gatekeeper bypass, not
# on passing spctl.
spctl -a -vv src-tauri/target/<target>/release/bundle/macos/ScreenPick.app || true
```

> Do not strip the ad-hoc signature. On Apple Silicon an unsigned (not even
> ad-hoc) arm64 binary will be killed on launch.

### 4. Git Commit and Tag

> ScreenPick is a **private** GitHub repo under the `tstone-1` account.
> Before pushing: `gh auth switch --user tstone-1`.

```sh
gh auth switch --user tstone-1
git add -A
git commit -m "Release vYY.M.MICRO: brief description"
git tag vYY.M.MICRO
git push origin main --tags
```

**Release hygiene checks:**
- [ ] `git describe --tags --exact-match` matches the version files.
- [ ] `git ls-remote --tags origin vYY.M.MICRO` shows the pushed tag.

### 5. Publish

**Channel: GitHub Releases, built by CI on a pushed tag.** Pushing a CalVer tag
(`vYY.M.MICRO`) triggers [`.github/workflows/release.yml`](.github/workflows/release.yml),
which builds the **macOS universal DMG** and **Windows x64 installers** and publishes
them to a **draft** GitHub Release for you to review and publish. This repo is public,
so GitHub Actions minutes are free and unlimited — the tag-push path is the primary
release channel.

You can still build and publish locally (the commands below) — useful for a quick
one-platform build or when iterating on packaging without cutting a tag.

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npx tauri build --target universal-apple-darwin
gh release create vYY.M.MICRO --title "ScreenPick vYY.M.MICRO" --notes-from-tag \
  src-tauri/target/universal-apple-darwin/release/bundle/dmg/ScreenPick_*_universal.dmg
```

- [ ] Build the Windows installers on a Windows machine (`npx tauri build`, see
      [Build Output](#build-output)) and attach them to the same release:
      `gh release upload vYY.M.MICRO src-tauri/target/release/bundle/nsis/ScreenPick_*_x64-setup.exe src-tauri/target/release/bundle/msi/ScreenPick_*_x64_en-US.msi`.
- [ ] `gh release view vYY.M.MICRO` confirms it points to the tag and lists the
      `.dmg` + `.exe`/`.msi` assets.

> **Local universal builds need `rustup`, not Homebrew Rust.** `brew install
> rust` ships only the host target's stdlib, so `--target universal-apple-darwin`
> fails to cross-compile the x86_64 slice. Either install the official toolchain
> from [rustup.rs](https://rustup.rs/) (then `rustup target add x86_64-apple-darwin`),
> or build a native-arch-only DMG with a plain `npx tauri build` and let CI
> produce the universal artifact for releases.

### 6. Post-release Verification

- [ ] Install from the built artifact (dmg / setup.exe) and launch.
- [ ] Trigger each capture mode via its global shortcut (region / window / screen).
- [ ] Annotate a capture (pen, arrow, text, blur) and **export to PNG** — verify
      the file is written (regression guard for the asset/canvas CORS path).
- [ ] Copy a capture to the clipboard and paste it elsewhere.
- [ ] **macOS:** confirm the Screen-Recording permission flow (a fresh install
      without permission must not silently produce a black image).

## Version Management

ScreenPick uses [CalVer](https://calver.org/) `YY.M.MICRO`, **switched from
SemVer with `26.5.0` (May 2026)** — matching `atr-viewer`, `snowscreen`, and
`sitm-explorer`.

| Segment | Meaning | Example |
|---------|---------|---------|
| **YY** | Two-digit year | 26 = 2026 |
| **M** | Month, no zero-padding | 5 = May |
| **MICRO** | Sequential release within the month, starting at 0 | 0, 1, 2… |

Examples: `26.5.0` (first May 2026 release), `26.5.1` (second), `26.6.0` (first June).

The same `YY.M.MICRO` value must appear in `package.json`, `src-tauri/Cargo.toml`,
and `src-tauri/tauri.conf.json`; the local tag must be `vYY.M.MICRO`; and (once a
channel exists) the published release must point to that tag. Do not leave a tag,
release, or version file behind on an older value.

## Dependency Pin Notes

Every pin in `src-tauri/Cargo.toml` carries its own why/when-to-revisit comment
inline — that's the source of truth on the Rust side. `package.json` has no
comment syntax, so its one pin is documented here instead:

- **`overrides.cookie: "0.7.2"`** — forces the `cookie` package (a transitive
  dependency of `@sveltejs/kit`) to a version at or above the fix for the
  known `cookie <0.7.0` advisory (out-of-bounds characters accepted in
  cookie name/path/domain, GHSA-pxg6-pf52-xh8x). `npm ls cookie` should show
  exactly one resolution, `cookie@0.7.2 overridden`, under `@sveltejs/kit`.
  **Revisit:** once `@sveltejs/kit`'s own `package.json` depends on
  `cookie >=0.7.2` directly (check with `npm info @sveltejs/kit@latest
  dependencies.cookie` after a `@sveltejs/kit` bump), drop the override —
  an override that silently stops doing anything is worse than no override,
  since it looks like a live constraint.

See also the `.cargo/audit.toml` triage note referenced in the Pre-release
Checklist above for the Rust-side equivalent of "why is this pinned/ignored".

## Icons

App icons live in `src-tauri/icons/`. Regenerate the full platform set from a
1024×1024 source PNG:

```sh
npm run tauri icon <path/to/source-1024.png>
```

This is desktop-only — delete the generated `ios/` and `android/` folders if
`tauri icon` emits them.

## Troubleshooting

### Rust compilation errors
```sh
rustup update
cargo clean --manifest-path src-tauri/Cargo.toml
npx tauri build
```

### Port 1420 already in use
```sh
npx kill-port 1420
```

### WebView2 issues (Windows)
WebView2 ships with Windows 11 and recent Windows 10 updates. For older systems,
install the runtime from
[Microsoft](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

### macOS capture produces a black image
The app lacks Screen-Recording permission. Grant it under **System Settings →
Privacy & Security → Screen Recording**, then relaunch. (First-run onboarding for
this is tracked in ROADMAP P0 #2.)

## Quick Reference

```sh
# Replace YY.M.MICRO with the actual version
rustup update stable
cargo update --manifest-path src-tauri/Cargo.toml
npm update && npm outdated
npm audit && (cd src-tauri && cargo audit -f Cargo.lock)   # run from src-tauri/ for .cargo/audit.toml
npm run check && npm run test
cargo clippy --manifest-path src-tauri/Cargo.toml
# Hard gate, macOS only — see Pre-release Checklist:
cargo test --manifest-path src-tauri/Cargo.toml export_typescript_bindings
# Bump version in package.json, package-lock.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json
rg -n '"version"|^version =' package.json package-lock.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
cargo check --manifest-path src-tauri/Cargo.toml   # refresh Cargo.lock
# Move CHANGELOG.md entry to [YY.M.MICRO] - YYYY-MM-DD
npx tauri build --target universal-apple-darwin   # local smoke build (unsigned, ad-hoc)
gh auth switch --user tstone-1
git add -A && git commit -m "Release vYY.M.MICRO: description"
git tag vYY.M.MICRO && git push origin main --tags
git describe --tags --exact-match
# Pushing the tag triggers release.yml, which builds macOS + Windows and opens a
# DRAFT release. Review it, then publish: gh release edit vYY.M.MICRO --draft=false
#
# Local publish alternative (skip the CI build):
# gh release create vYY.M.MICRO --title "ScreenPick vYY.M.MICRO" --notes-from-tag <dmg-path>
# gh release upload vYY.M.MICRO <exe/msi paths>   # Windows installers, built on Windows
```
