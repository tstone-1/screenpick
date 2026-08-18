# ScreenPick — Build Instructions

ScreenPick is a Tauri 2 (Rust) + SvelteKit 5 (TypeScript) desktop app targeting
**macOS** (Apple Silicon + Intel) and **Windows** (x64).

> **Distribution model:** **macOS release builds are signed with a Developer ID
> identity and notarized by Apple** (since 26.7.6) — users open them normally.
> **Windows is still unsigned**, with no Authenticode cert, so SmartScreen warns
> on first launch; those user-facing steps live in the **Install** section of
> [`README.md`](README.md).
>
> Signing is applied by CI when the Apple secrets are present. **Local builds
> stay ad-hoc-signed** (`bundle.macOS.signingIdentity: "-"` in
> `tauri.conf.json`) unless you export `APPLE_SIGNING_IDENTITY` yourself — see
> [macOS code signing and notarization](#macos-code-signing-and-notarization).
>
> **The updater is the exception.** Update payloads *are* signed, with a
> minisign key that is unrelated to OS code signing — see
> [Updater signing key](#updater-signing-key). That signature is the only
> cryptographic control on the update path, which makes the private key the
> most safety-critical secret in this project.

## Prerequisites

- **Node.js** 24+ (Active LTS; matches CI, `.nvmrc`, and Vite's supported runtime).
- **Rust** latest stable via [rustup](https://rustup.rs/).
- **ripgrep** (`rg`) — used by the release-checklist verification commands.
- **macOS**: Xcode Command Line Tools (`xcode-select --install`). No signing
  certificate is required for a local build — those stay ad-hoc-signed. For a
  universal binary, add both Rust targets:
  `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.
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

## Updater

### Updater signing key

Every update payload is signed with a **minisign** keypair (Tauri's updater
format). Clients verify it against `plugins.updater.pubkey` in
`tauri.conf.json` before installing anything. This is independent of Apple/
Windows code signing and is *not* fixed by adding a Developer ID.

- **Private key + password: KeePass**, and mirrored into the repo secrets
  `TAURI_SIGNING_PRIVATE_KEY` (the key file's **contents**) and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- **Public key: committed** in `tauri.conf.json`. Public by design.
- **Losing the private key permanently orphans the installed base.** A new key
  cannot sign for clients that already hold the old public key, so every
  existing user would have to find and reinstall ScreenPick by hand. There is
  no recovery path. Keep the KeePass database backed up.

Regenerating (only ever for a *new* app, never to "fix" a lost key):

```sh
npx tauri signer generate -w ~/.tauri/screenpick.key
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo tstone-1/screenpick < ~/.tauri/screenpick.key
read -rs "PW?Password: " && printf '%s' "$PW" | \
  gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo tstone-1/screenpick && unset PW
```

> Use `printf '%s'`, not `echo` — a trailing newline becomes part of the secret
> and surfaces later as a bogus "wrong password" signing failure in CI. And note
> `gh secret set` has **no** `--body-file` flag (that's `gh release`); it takes
> `-b`, `-f`, or stdin.

**Gotchas that cost time once already:**

- **The bundler reads `TAURI_SIGNING_PRIVATE_KEY` (contents), not
  `TAURI_SIGNING_PRIVATE_KEY_PATH`.** The `_PATH` form works only for the
  `tauri signer sign` CLI. With just `_PATH` set, the build runs all the way to
  the end and *then* fails with "A public key has been found, but no private
  key".
- **Updater endpoints must be `https`.** Tauri validates this while
  deserializing the config, so a plain-`http` endpoint makes the packaged app
  **panic on startup** rather than merely warn. `dangerousInsecureTransportProtocol: true`
  is the documented escape hatch, and is only ever acceptable in a throwaway
  local test build. `src/lib/updaterConfig.test.ts` asserts the committed
  endpoint is https for exactly this reason.
- **`--bundles app` is enough to produce updater artifacts on macOS**
  (`.app.tar.gz` + `.sig`); no DMG build required. That turns a re-test into a
  ~20 s incremental build.

### Verifying the updater locally

Do this after any change to the updater wiring, and before trusting a release to
reach real users. It exercises signature verification, download, in-place bundle
replacement and relaunch without publishing anything or burning a tag.

Use a **throwaway keypair** so the real private key never leaves KeePass/CI:

```sh
SCRATCH=$(mktemp -d)
npx tauri signer generate -w "$SCRATCH/test.key" -p "" --ci -f

# In tauri.conf.json, TEMPORARILY: swap in "$SCRATCH/test.key.pub"'s contents as
# `pubkey`, point `endpoints` at http://localhost:8787/latest.json, and add
# "dangerousInsecureTransportProtocol": true

# 1. Build the "old" app at the current version and keep it aside.
npx tauri build --bundles app
cp -R src-tauri/target/release/bundle/macos/ScreenPick.app "$SCRATCH/installed/"

# 2. Bump the version everywhere, rebuild -> this is the update payload.
#    Both builds need the same temporary config, or the updated app panics on
#    relaunch against a config it cannot deserialize.
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$SCRATCH/test.key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npx tauri build --bundles app

# 3. Serve ScreenPick.app.tar.gz plus a hand-written latest.json whose
#    `signature` is the contents of ScreenPick.app.tar.gz.sig, with
#    darwin-aarch64 and darwin-x86_64 entries.
python3 -m http.server 8787

# 4. Launch "$SCRATCH/installed/ScreenPick.app"; the banner appears ~10 s later.
```

Verify: the server log shows a `latest.json` GET at launch+10 s, then a
`.app.tar.gz` GET after clicking **Install and restart**; the relaunched window
title reads the new version; and the follow-up check reports no update.

> **Clicking the button is manual.** The banner is inside the webview and
> resists scripting — synthetic clicks are blocked without Accessibility trust,
> and the button does not respond to `AXPress` despite appearing in the
> accessibility tree. Do not sink time into automating it.

> **Afterwards, revert `tauri.conf.json` and every version file**, re-run
> `cargo check` to refresh `Cargo.lock`, and clear `lastRunVersion` from
> `~/Library/Application Support/com.tstone1.screenpick/capture-settings.json` —
> the test build shares the real app's bundle identifier, so it writes its
> version into the *real* settings file and would otherwise make the next real
> launch believe it had just been updated.

## macOS code signing and notarization

**Status: done, 2026-07-25.** Certificate issued, notarization key created, and
both wired into `release.yml`; verified end to end on a local universal build
(notarization Accepted, stapled, `spctl` reports `source=Notarized Developer
ID`). Ships from 26.7.6.

The motivation is not Gatekeeper friction — it is that ad-hoc signing makes the
macOS Screen Recording grant die on every update (ROADMAP P0 #1 has the TCC
detail). A Developer ID identity is stable across versions, so the grant
survives. The first signed release still breaks it one final time, because the
signature identity itself changes.

This is **independent of the updater's minisign key** — different key, different
purpose, different failure mode. See [Updater signing key](#updater-signing-key).

### What has to exist

| Thing | Where it lives | Recoverable if lost? |
|---|---|---|
| Developer ID Application cert + private key | this Mac's login keychain; `.p12` export attached to a KeePass entry (authoritative), second copy in iCloud Drive → `Developer/signing/apple-developer-id-NVX72G8SJ8.p12` | Yes — revoke and reissue (limit 5) |
| The `.p12` export password | the same KeePass entry as the `.p12`. Inside an encrypted vault that co-location is fine; **in iCloud it is not** — iCloud is not sole-custody storage, so the password must never sit there next to the file | No — without it the `.p12` is inert |
| App Store Connect API key (`.p8`) | `~/.appstoreconnect/private_keys/`, KeePass attachment (it is an *unencrypted* private key — it does not go in iCloud) | Yes — revoke and generate another |
| Key ID, Issuer ID, Team ID | KeePass | Yes — readable in the portal |

The identity in use is `Developer ID Application: Timo Stein (NVX72G8SJ8)`; Team ID
`NVX72G8SJ8`, G2 sub-CA, **valid to 2031-07-26**.

On expiry — or if the key is ever compromised — repeat *Setup* for a new
certificate and update `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` /
`APPLE_SIGNING_IDENTITY` **in this repo and in `tstone-1/dblitz`**, which signs
with the same certificate. Releases already published keep working: notarization
tickets stay valid after the signing certificate expires, and the Team ID in the
Designated Requirement does not change, so **the Screen Recording grant survives
a certificate renewal** as long as the Team ID does. Renewing is not the same
class of event as losing the updater's minisign key, which is unrecoverable.

### Setup

1. **CSR** — Keychain Access → *Certificate Assistant → Request a Certificate
   From a Certificate Authority*; leave CA Email blank, choose *Saved to disk*.
2. **Certificate** — developer.apple.com → Certificates → **+** → *Developer ID
   Application* → profile type *G2 Sub-CA* → upload the CSR → download the
   `.cer` → double-click to install into the **login** keychain. Confirm with
   `security find-identity -v -p codesigning`; the full
   `Developer ID Application: <Name> (TEAMID)` string is `APPLE_SIGNING_IDENTITY`.
3. **Notarization key** — App Store Connect → Users and Access → Integrations →
   *Team Keys* → generate with the **Developer** role. The `.p8` downloads
   **once, ever**. Store at `~/.appstoreconnect/private_keys/`, `chmod 600`.
4. **Prove the notarization credentials before relying on them** — one cheap call,
   rather than discovering a bad Issuer ID at the end of a build:

   ```sh
   xcrun notarytool history --key ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8 \
     --key-id <KEYID> --issuer <ISSUER-UUID>
   ```

   `No submission history` is **success** on a fresh account — it means the call
   authenticated. An auth failure looks nothing like it.

(Prerequisite for all three: an active Apple Developer Program membership,
Individual or Organization. The portal will not offer *Developer ID Application*
until enrolment is fully activated, which can lag payment by a day.)

> **Two import traps, both hit on 2026-07-25.** Double-clicking the `.cer` failed
> with `Unable to import … Error: -25294` (`errSecNoSuchKeychain`) even though
> `security default-keychain` was correctly set to `login.keychain-db`. That is a
> Keychain Access GUI failure, not a bad certificate — import from the CLI
> instead: `security import <file>.cer -k ~/Library/Keychains/login.keychain-db`.
>
> Then `find-identity -v -p codesigning` still reported **0 valid identities**,
> while bare `find-identity` listed the identity as `CSSMERR_TP_NOT_TRUSTED` —
> so the private key matched fine and only the chain was broken. macOS does not
> ship the **G2 intermediate**, and without it a Developer ID cert can never
> validate. Fetch and import it once per machine:
> ```sh
> curl -fsSLO https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
> security import DeveloperIDG2CA.cer -k ~/Library/Keychains/login.keychain-db
> ```
> Read the two commands as a pair: `-v` filtering an identity out means *chain*,
> bare `find-identity` showing nothing at all means *missing private key*.

Smoke-test the identity before trusting a release to it — signing any throwaway
binary proves the key, the chain, and keychain access in one shot:

```sh
cp /bin/echo /tmp/signtest
codesign --force --options runtime --timestamp -s "$APPLE_SIGNING_IDENTITY" /tmp/signtest
codesign -dv --verbose=4 /tmp/signtest 2>&1 | grep -E 'Authority|TeamIdentifier|flags'
```

Expect three `Authority=` lines ending at `Apple Root CA` and
`flags=0x10000(runtime)`. The first `codesign` triggers a keychain dialog —
answer **Always Allow**, or every subsequent build blocks on the same prompt
(and in a non-interactive build, fails).

### Backing up the identity

**The backup filename is deliberately team-scoped, not app-scoped.** A Developer
ID Application certificate certifies the *team* (`NVX72G8SJ8`), never one app —
the friendly name inside the `.p12` is plain "Timo Stein" — and this same file
signs `dblitz` too. It was originally exported as `screenpick-devid.p12` and
renamed 2026-07-25, once the second app started using it: an app-scoped name
invites the next person to export a redundant second certificate against the
account's limit of five.

Export the identity to a `.p12` the moment it exists — a login keychain is one
disk failure from costing a revoke-and-reissue cycle:

```sh
security export -k ~/Library/Keychains/login.keychain-db \
  -t identities -f pkcs12 -P "$(pbpaste)" \
  -o "$HOME/Library/Mobile Documents/com~apple~CloudDocs/Developer/signing/apple-developer-id-NVX72G8SJ8.p12"
```

Generate the export password in KeePass, copy it, and let `"$(pbpaste)"` expand
it — the value never appears in the command text, shell history, or an agent
transcript. Two traps around that:

- **Omitting `-P` hangs forever without a TTY.** `security export` then wants to
  prompt for the passphrase, and under an agent tool call or any non-interactive
  shell there is no terminal to prompt on, so it blocks until killed. Same shape
  as the `tauri signer generate` failure. Always pass `-P`.
- **KeePass clears the clipboard ~12s after a copy**, which is shorter than a
  copy-then-run round trip. Start the command *first* with a short poll loop
  waiting for the clipboard to become non-empty, then copy — don't copy and then
  go looking for the command.

Verify the backup actually restores, rather than trusting that a file appeared:

```sh
KC=/tmp/verify.keychain
security create-keychain -p "$(openssl rand -base64 24)" "$KC"
security import <the>.p12 -k "$KC" -P "$(pbpaste)" -A
security find-identity "$KC"        # must list the identity, same SHA-1
security delete-keychain "$KC"
```

> **`openssl pkcs12` reports a valid Apple `.p12` as unopenable.** Apple encrypts
> the cert bag with 40-bit RC2 (OID `1.2.840.113549.1.12.1.6`), which OpenSSL 3.x
> moved to the legacy provider and refuses by default — the error reads like a
> wrong password or a corrupt file. Pass **`-legacy`**
> (`openssl pkcs12 -legacy -in … -nokeys -noout -passin pass:…`), or use the
> keychain-import check above, which is better evidence anyway since it exercises
> the same Security framework path a real restore would.

Then attach the `.p12` to the KeePass entry alongside its password, and clear the
clipboard.

### Building signed locally

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (TEAMID)"
export APPLE_API_KEY=<KEYID>
export APPLE_API_ISSUER=<ISSUER-UUID>
export APPLE_API_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8"
npx tauri build --target universal-apple-darwin
```

**Budget real time for notarization, and keep the machine awake.** Apple's notary
service is not fast and not predictable: the 2026-07-25 run took ~50 minutes for
a 16 MB payload, against single-digit minutes on other days. The compile is the
short part. `notarytool --wait` holds an open poll for the whole duration, so an
idle-sleep partway through drops it — and on a laptop the default battery idle
sleep can be **1 minute**. Hold a power assertion for the build's lifetime:

```sh
npx tauri build --target universal-apple-darwin &
caffeinate -dimsu -w $!     # releases itself when the build exits
```

Note `caffeinate` does **not** defeat a lid close, only idle sleep. Once the
payload has finished uploading (`notarytool` reports the submission id and starts
polling) the submission survives on Apple's side regardless — a lost poll then
costs a `stapler staple`, not a rebuild.

`APPLE_SIGNING_IDENTITY` (env) **overrides** `bundle.macOS.signingIdentity` in
`tauri.conf.json` — verified in `tauri-cli`'s `interface/rust.rs`, which reads
the env var and only falls back to the config value when it is unset. So the
committed `"signingIdentity": "-"` can stay: local dev builds remain ad-hoc,
signed builds override it. No `tauri.macos.conf.json` overlay is needed.

Hardened runtime is on by default (`hardenedRuntime` defaults to `true`) and is
required for notarization — do not turn it off.

### Verify — the build will NOT fail if notarization is skipped

When notarization credentials are missing or malformed, the bundler logs
`skipping app notarization` and **succeeds**. You get a signed, un-notarized app
that Gatekeeper still rejects on a machine that has never seen it. Same
looks-green failure shape as a release with no `latest.json`. Always run:

```sh
APP=src-tauri/target/universal-apple-darwin/release/bundle/macos/ScreenPick.app
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E 'Authority|TeamIdentifier|flags'
xcrun stapler validate "$APP"   # "The validate action worked!"
spctl -a -vvv -t exec "$APP"    # "source=Notarized Developer ID"
```

Expect `Authority=Developer ID Application: …` and `flags=…(runtime)`.

> **The bundler does NOT notarize the DMG — only the `.app` inside it.** After a
> signed build the DMG carries a Developer ID signature but no ticket, and
> `spctl -a -t open --context context:primary-signature <dmg>` rejects it as
> `Unnotarized Developer ID`. Since the DMG is the thing users download, opening
> it would still raise "Apple cannot check it for malicious software" —
> most of the benefit lost, on an artifact that verifies clean if you only ever
> check the `.app`. `release.yml` therefore notarizes and staples the DMG in a
> separate step and re-uploads it over the asset `tauri-action` published
> (`gh release upload --clobber`). Verify a release DMG with the `-t open` form
> above, not just `-t exec` on the app.

**Updates inherit the signature automatically — verified 2026-07-25.** The app
bundler signs → notarizes → staples the `.app`, and the updater bundler tars
*that* already stapled bundle (`updater_bundle.rs` archives the existing `.app`,
it does not re-sign). The staple ticket lives at `Contents/CodeResources`, an
ordinary file inside the bundle rather than an extended attribute, which is
*why* it survives being tarred — an xattr-based ticket would not, since the Rust
`tar` crate does not carry xattrs. Confirmed by round-tripping the stapled
bundle: the extracted copy still passes `stapler validate` and `spctl` still
reports `source=Notarized Developer ID`. That is what makes the TCC grant
survive updates.

### CI

Six repo secrets, consumed by the macOS leg only:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the `.p12` (`openssl base64 -A -in …`) |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Timo Stein (NVX72G8SJ8)` |
| `APPLE_API_KEY` | the Key ID, `T87S5KZQ4J` |
| `APPLE_API_ISSUER` | the Issuer UUID |
| `APPLE_API_KEY_P8` | the `.p8` contents; the workflow writes it to `$RUNNER_TEMP` and points `APPLE_API_KEY_PATH` at it |

Set them with `printf '%s' … | gh secret set …` — `echo` appends a newline, and a
trailing newline in `APPLE_CERTIFICATE_PASSWORD` surfaces at the *end* of a
release build as a wrong-password error that reads like a corrupt certificate.
Verify a candidate password against the `.p12` (`openssl pkcs12 -legacy -in … 
-nokeys -noout -passin pass:…`) before storing it.

The Tauri CLI imports the certificate itself from `APPLE_CERTIFICATE` /
`APPLE_CERTIFICATE_PASSWORD` — no manual `security create-keychain` step, and it
sets the key partition list so `codesign` never blocks on a prompt.

> **The signing vars must be exported via `$GITHUB_ENV`, never listed in the
> build step's `env:` block.** A fork has none of these secrets; `env:` would
> then pass an **empty** `APPLE_SIGNING_IDENTITY`, which the CLI reads as "sign
> with this identity" and fails on. A conditional export step leaves them
> genuinely unset, so the CLI falls back to the ad-hoc `"-"` and the fork builds.

`release.yml` ends the macOS leg with a verification step that greps for
`Authority=Developer ID Application`, the `runtime` flag, a successful
`stapler validate`, and `source=Notarized Developer ID` — because a skipped
notarization exits 0 (see above), and without a gate an unnotarized release
ships looking green.

### Gotcha: local signing dies with `errSecInternalComponent`

On a dev Mac, `codesign` can start failing with `errSecInternalComponent` on
*every* signature — including a `/bin/echo` copy that signed minutes earlier —
while `security find-identity -v -p codesigning` still reports the identity as
valid. It is not the certificate or the chain: it is the private key's ACL. The
earlier successes came from an interactive "Allow" that does not persist, and a
non-interactive shell has no TTY for the prompt to reappear on, so it fails hard
instead of asking. Grant persistent access once:

```sh
security unlock-keychain ~/Library/Keychains/login.keychain-db
security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
  -k "$(pbpaste)" ~/Library/Keychains/login.keychain-db
```

**Ignore that command's exit code — judge it by a test signature.** It walks
every key in the keychain and returns non-zero if any unrelated key fails, after
having already updated the one you care about. Confirm with a real signature and
a timeout, so a hidden prompt shows up as a hang rather than a mystery:

```sh
perl -e 'alarm 25; exec @ARGV' codesign --force --options runtime --timestamp \
  -s "$APPLE_SIGNING_IDENTITY" /tmp/signtest    # macOS has no `timeout(1)`
```

This does not affect CI, which builds in a fresh keychain each run.

## Release Procedure

### 1. Pre-release Checklist

**Update toolchains and dependencies:**
- [ ] `rustup update stable`
- [ ] `cargo update --manifest-path src-tauri/Cargo.toml` — review major bumps against changelogs.
- [ ] `npm update && npm outdated` — review remaining majors individually.
- [ ] **Majors are a decision to put to the maintainer, not one to make silently.**
      `npm update` / `cargo update` only move within the allowed range, so anything
      still listed by `npm outdated` is a held-back major. Do not apply them
      unprompted and do not quietly skip them either: for each one, say what it is,
      what it would take, and **whether anything is actually blocking the upgrade**
      (a breaking API in use here, a peer-dep conflict, an unported plugin) — then
      ask whether to take it in this cycle or defer. "Two majors held back, both
      clean, want them?" is the answer being looked for; a bare list is not.
- [ ] `cargo audit -f src-tauri/Cargo.lock` (install: `cargo install cargo-audit`) — run from
      `src-tauri/` so it picks up `.cargo/audit.toml`. Expect a **clean exit** (only the
      pre-triaged "allowed warnings" — unmaintained gtk3-family crates, `paste`, `anyhow`
      1.0.102, `memmap2` via pinned xcap — none actionable). If `cargo audit` reports a
      new, non-allow-listed vulnerability, that is a real release blocker: do not add it to
      `.cargo/audit.toml` without recording the same reviewed/accepted/revisit-condition
      reasoning the existing quick-xml entries carry (see the comments in that file). A
      release must not ship with an unreviewed red `cargo audit`.
- [ ] `npm audit`.

**Code quality — these are the *exact* commands `ci.yml` runs.** Run them verbatim,
not an approximation: a weaker local variant passes while CI goes red, which is
how v26.7.6 shipped with a red `main` (the checklist omitted `cargo fmt`
entirely, and its clippy line lacked `--all-targets -- -D warnings`).
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml --check` — **formatting is a
      CI gate.** It is the cheapest one to fail and the easiest to forget after
      hand-editing Rust; `cargo fmt` (without `--check`) fixes it.
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
      — note `--all-targets` (covers test code) and `-D warnings` (a warning is a
      failure). Plain `cargo clippy` is *not* equivalent and will let a CI
      failure through.
- [ ] `npm run check` passes.
- [ ] `npm run test` passes (frontend checks + unit + Rust tests run via `cargo test` on
      Windows).
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --locked` — `--locked` fails
      if `Cargo.lock` would have to change, catching a lockfile that was never
      committed after a `cargo update`.
- [ ] **macOS bindings drift guard — hard gate, cannot be skipped:** confirm the
      macOS CI check is **green on the commit being tagged**. It runs automatically in
      two places, both on macOS: `ci.yml`'s macOS job on every push and pull request
      (step "Rust unit tests (includes Specta drift check)"), and `release.yml`'s
      `test` job on `macos-latest`, which the release build `needs:` — so a tag on
      drifted bindings fails the gate before any installer is produced. That job is
      the only thing that actually exercises
      `export_typescript_bindings`/`specta_builder` — see the comment at the
      `cfg(not(all(test, target_os = "windows")))` gate atop `src-tauri/src/lib.rs` for
      why it cannot run on Windows (a `cargo test` binary never gets the Windows GUI
      manifest `tauri_build` embeds into the real app, so the linked-in Tauri GUI stack
      fails to even start the test process — verified, not a shortcut). Development
      happens on Windows, where drift is structurally invisible, so the CI run is the
      only evidence there is: **do not tag on a red — or missing — macOS run.** A local
      Mac run is still the *regeneration* path after an IPC change: run
      `cargo test --manifest-path src-tauri/Cargo.toml export_typescript_bindings` with
      `BINDINGS_UPDATE=1` first to regenerate `src/lib/bindings.ts`, commit that, then
      re-run without the env var to confirm it's back in sync.
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
- [ ] **Re-derive the version from the release date — do not trust the number on
      the `Unreleased` heading.** That heading is written when the first entry of
      a cycle lands, so it encodes the month the *work started*, and CalVer
      encodes the month it *ships*. Cross a month boundary and the two disagree:
      26.8.0 was cut from a heading that read `[26.7.8] - Unreleased`, because
      the work began in July and the release went out on 6 August — and MICRO
      resets to 0 for the first release of a month, so it is not 26.8.8 either.
      A stale heading is the only place this is recorded, so nothing else
      catches it.

### 2. Build Release

```sh
npx tauri build
```

> **This step exits non-zero locally, and that is expected.** Without
> `TAURI_SIGNING_PRIVATE_KEY` exported, the build writes every bundle — `.app`,
> DMG, `.app.tar.gz` — and *then* fails on the updater signature with
> `A public key has been found, but no private key`. The artifacts are complete;
> only the `.sig` is missing, and the release build in CI is the one that signs.
> Judge a local smoke build by the bundle paths it prints, not by its exit code.
> (A stale `.sig` from an earlier build is left in place next to the new
> tarball, so its presence proves nothing either — check the timestamp.)

> **A *different* non-zero exit arrives earlier, and looks the same: a leftover
> mounted DMG.** `bundle_dmg.sh` attaches a read-write image while it works, and
> a run that dies leaves it attached — after which every later build fails at
> `Running bundle_dmg.sh` with nothing but
> `failed to run .../bundle_dmg.sh`, *before* ever reaching the updater
> signature. Since the note above trains you to expect a non-zero exit, the
> reflex is to wave it through; the tell is that the log stops at the DMG step
> and never prints `A public key has been found, but no private key`. Check
> `hdiutil info | grep image-path` (or just `ls /Volumes` for a `dmg.*` entry),
> then `hdiutil detach /Volumes/dmg.XXXXXX -force` and delete the orphaned
> `bundle/macos/rw.*.dmg`. Hit cutting 26.8.0; the retry succeeded unchanged,
> which is what proved the failure environmental rather than a packaging break.

### 3. Verify the build

A plain local `npx tauri build` is **ad-hoc-signed** — `codesign -dv` shows a
`Signature=adhoc` line, and `spctl` correctly rejects it with
`Unnotarized Developer ID`. That is expected for a dev build and proves nothing
about the release.

The release artifacts are produced by `release.yml`, which signs and notarizes
them and then gates on the result. Verify a **signed** bundle (locally with the
env vars exported, or by downloading the release DMG) with the commands in
[macOS code signing and notarization](#macos-code-signing-and-notarization):
`Authority=Developer ID Application`, `stapler validate`, and `spctl` reporting
`source=Notarized Developer ID`.

> Do not strip the ad-hoc signature on a local build. On Apple Silicon an
> unsigned (not even ad-hoc) arm64 binary is killed on launch.

### 4. Git Commit and Tag

> ScreenPick is a **public** GitHub repo under the `tstone-1` account.
> Before pushing: `gh auth switch --user tstone-1`.

```sh
gh auth switch --user tstone-1
git add -A
git commit -m "Release vYY.M.MICRO: brief description"
git tag vYY.M.MICRO
git push origin main
git push origin vYY.M.MICRO
```

> Push the release tag **by name** — never `git push --tags` (or `--all`/`--mirror`).
> A clone can carry local tags that were deliberately never published (e.g. tags
> from before the public-history squash, which point into the retired private
> history); `--tags` would push them all, and pushed tags drag their entire
> commit graph to the public repo with them.

**Release hygiene checks:**
- [ ] `git describe --tags --exact-match` matches the version files.
- [ ] `git ls-remote --tags origin vYY.M.MICRO` shows the pushed tag.
- [ ] **A run actually exists for the tag** — a pushed tag is not a triggered
      build:
      ```sh
      gh run list --workflow=release.yml --branch vYY.M.MICRO --limit 1
      ```
      An empty result means nothing was queued. Push the tag during a GitHub
      Actions outage and **no run is ever created, then or later** — Actions
      does not backfill events it missed, and nothing anywhere reports this:
      the tag is on the remote, `git push` exited 0, and the release simply
      never happens. Hit cutting 26.8.0, pushed at 19:26Z into an
      `Actions: major_outage` window. Check
      `curl -s https://www.githubstatus.com/api/v2/components.json` when a run
      fails to appear. **Recovery:** re-create the tag push once Actions is
      healthy — `git push origin :vYY.M.MICRO && git push origin vYY.M.MICRO`
      — which is safe while no release references the tag yet. `release.yml`
      has no `workflow_dispatch` trigger, so re-pushing the tag is the only
      way to start it.

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

**Updater checks — after publishing the draft, not before.** The endpoint
resolves `releases/latest`, which ignores drafts and prereleases, so the update
only goes live when the release does.

- [ ] The release lists `latest.json`, plus `.app.tar.gz`/`.nsis.zip` and their
      `.sig` files. **No `latest.json` means no update reaches anyone** — the
      most likely cause is a missing/empty signing secret, since `tauri-action`
      logs "Signature not found for the updater JSON. Skipping upload..." and
      still finishes green.
- [ ] `curl -sL https://github.com/tstone-1/screenpick/releases/latest/download/latest.json | jq '.version, (.platforms | keys)'`
      reports the new version and **both** `darwin-*` and `windows-x86_64` keys.
      A manifest with only one platform means the release matrix raced (see the
      `max-parallel: 1` comment in `release.yml`) — re-run the missing leg.
- [ ] The `windows-x86_64` URL points at the **NSIS** bundle, not the MSI
      (`updaterJsonPreferNsis: true`). An MSI update on top of an NSIS install
      creates a second parallel installation instead of upgrading.

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
- [ ] **Updater, on a real install of the previous version** (both platforms):
      the banner offers the new version, installs it, and the relaunched app
      reports the new version in its window title. This is the only check that
      covers `tauri-action`'s generated manifest and the GitHub endpoint; the
      local recipe above cannot.
- [ ] **macOS after that update:** captures still work, or the post-update
      banner correctly explains the remove-and-re-add fix. From 26.7.6 the
      Developer ID identity is stable, so the grant should now *survive* an
      update — **updating to 26.7.6 itself is the exception**, because the
      signing identity changes on that one hop (ROADMAP P0 #1). Treat a lost
      grant on any later update as a regression, not as expected behaviour.

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
git tag vYY.M.MICRO && git push origin main && git push origin vYY.M.MICRO   # tag by name, never --tags
git describe --tags --exact-match
# Pushing the tag triggers release.yml, which builds macOS + Windows and opens a
# DRAFT release. Review it, then publish: gh release edit vYY.M.MICRO --draft=false
# Only after publishing does the updater endpoint resolve — then verify it:
# curl -sL https://github.com/tstone-1/screenpick/releases/latest/download/latest.json | jq '.version, (.platforms | keys)'
#
# Local publish alternative (skip the CI build):
# gh release create vYY.M.MICRO --title "ScreenPick vYY.M.MICRO" --notes-from-tag <dmg-path>
# gh release upload vYY.M.MICRO <exe/msi paths>   # Windows installers, built on Windows
```
