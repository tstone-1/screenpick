# ScreenPick — Build Instructions

ScreenPick is a Tauri 2 (Rust) + Svelte 5 / SvelteKit 3 (TypeScript) desktop app targeting
**macOS** (Apple Silicon + Intel) and **Windows** (x64).

> **Distribution model:** **macOS release builds are signed with a Developer ID
> identity and notarized by Apple** (since 26.7.6) — users open them normally.
> **Windows release builds are signed with a Certum Open Source Code Signing
> certificate** (from the release after 26.10.2) — see
> [Windows code signing](#windows-code-signing). The certificate is new, so
> SmartScreen can still warn on first launch; those user-facing steps live in
> the **Install** section of [`README.md`](README.md). A local Windows build is
> unsigned.
>
> Apple signing is applied by CI when the Apple secrets are present. **Local builds
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
- `nsis/ScreenPick_<version>_x64-setup.exe` — NSIS installer. It is the only
  Windows installer: no `.msi` is built, see
  [Windows code signing](#windows-code-signing).
- Portable executable: `src-tauri/target/release/screenpick.exe`.

## Updater

### Updater signing key

Every update payload is signed with a **minisign** keypair (Tauri's updater
format). Clients verify it against `plugins.updater.pubkey` in
`tauri.conf.json` before installing anything. This is independent of Apple and
Windows code signing and is *not* fixed by adding a Developer ID or an
Authenticode certificate.

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

That step covers credentials that are **present and wrong**. It is skipped when
they are absent, which is what lets a fork build. In `tstone-1/screenpick` an
absent `APPLE_CERTIFICATE` or `APPLE_API_KEY_P8` is a mistake — the usual one
is a secret left out when the certificate was renewed — so there the prepare
step fails the macOS leg with an error instead of warning and building ad-hoc.

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

## Windows code signing

**Status: wired into `release.yml` on 2026-10-08 and rehearsed the same day,
with `sign-rehearsal.yml` and with a full build from a rehearsal tag. No
published release is signed yet; see *What has been seen and what has not*
below.

The certificate is Certum *Open Source Code Signing in the Cloud*, subject
`CN=Open Source Developer Timo Stein`, issued by *Certum Code Signing 2021 CA*,
valid until 2027-10-07. The key is in Certum's SimplySign service and cannot be
exported.

**The certificate, the account and every rule below are shared with
[`tpdf`](https://github.com/tstone-1/tpdf)**, where this was built and
rehearsed first, and with any other project of the maintainer that signs with
it. `tpdf`'s `BUILD.md`, *Signing with the Certum certificate*, has the
measurements behind each rule. A certificate certifies the developer and not
one program, so there is one of it: renewing it, or changing the login, means
updating the `signing` environment in every repository that uses it.

This is **independent of the updater's minisign key** — different key,
different purpose, different failure mode. See
[Updater signing key](#updater-signing-key). An installed copy accepts an
update by the minisign key alone, so somebody who steals the Certum login can
sign their own program under this name and cannot update anybody's ScreenPick.

### How a release is signed

`release.yml` takes [`ssign`](https://github.com/Le-Syl21/ssign), an unofficial
client (MIT) for the SimplySign service, built from a pinned commit (from a
cache when there is one, see [The cached signing client](#the-cached-signing-client)),
and names it as Tauri's `signCommand` through the overlay `src-tauri/tauri.signing.conf.json`,
on the Windows leg only. Tauri then starts the command once for
`screenpick.exe`, once for each NSIS plugin DLL, once for the uninstaller (from
inside makensis) and once for the installer. The first start logs in and the
later ones reuse that session, so one build is one login.

| Piece | What it is for |
|---|---|
| `src-tauri/tauri.signing.conf.json` | The overlay with `bundle.windows.signCommand`. It is not in `tauri.conf.json`, because there every local Windows build would ask for a signing login |
| `tools/sign-windows.cmd` | What Tauri and makensis start. It finds the PowerShell script through `SCREENPICK_SIGN_SCRIPT`, not beside itself |
| `tools/sign-windows.ps1` | Runs `ssign` into a folder of its own, copies the signed bytes back over the file with retries, and logs everything to `%RUNNER_TEMP%\ssign.log` |
| `tools/verify_signature.ps1` | Reads signatures back with `signtool` and PowerShell; fails unless each is valid, timestamped and by the named signer |
| `.github/workflows/sign-rehearsal.yml` | Signs a plain executable and the installer of a published release, without building ScreenPick |
| `src/lib/windowsSigning.test.ts` | Runs with the unit tests on every platform: no `.msi` target, the sign command only in the overlay, the wrapper not looking beside itself, one pinned `ssign` commit, its cache keyed by that commit alone, every job that is handed the login in the one concurrency group and the one environment. The same file pins three things of `release.yml` that fail without a red step: `max-parallel: 1`, the job that reads `latest.json` back, and the macOS leg refusing to build here without the Apple secrets |

The login is two secrets of the GitHub environment `signing`: `CERTUM_EMAIL`
and `CERTUM_OTP_URI`, the whole `otpauth://` address Certum shows once, at
activation. Keep the whole address and not only its `secret`: `ssign` reads
`algorithm`, `digits` and `period` from it. The environment accepts the `main`
branch and `v*` tags. Set a secret from the clipboard, so that the value is in
no command line:

```sh
pbpaste | gh secret set CERTUM_EMAIL --env signing --repo tstone-1/screenpick
pbpaste | gh secret set CERTUM_OTP_URI --env signing --repo tstone-1/screenpick
```

After the build the Windows leg reads the installer's signature back, installs
it silently, and reads the signature of every `.exe` and `.dll` in
`%LOCALAPPDATA%\ScreenPick`, which has to contain `screenpick.exe` and
`uninstall.exe`. It fails unless each is valid, timestamped and by that signer,
and it fails if an `.msi` was built.

### Rules the login brings

- **One code is one login.** Two jobs that log in within the same 30 seconds
  make the second fail, and repeated failed logins can lock the account.
  Everything that signs here is in the concurrency group `certum-signing`, and
  nothing in it is cancelled. In the release job that is the Windows leg; the
  macOS leg logs in nowhere and has a group of its own, so a rehearsal can
  neither hold it up nor cancel it while it waits.
- **That group holds inside this repository only.** GitHub does not share a
  concurrency group between repositories, and the account is shared. Do not
  start a release or a rehearsal here while one runs in another project that
  signs with this certificate.
- **Do not log in to Certum's desktop program while a signing job runs**, for
  the same reason.
- **`ssign` keeps its session in a file for twenty minutes** (`%TEMP%\ssign`, or
  `.cache\ssign` under the home folder). Both workflows remove it in a step
  that runs whether the job passed or not.
- **The secrets reach the Windows leg only.** Both legs of the release job name
  the environment, because a job has one; the build step hands the two values
  to the Windows leg and an empty string to the macOS one.
- **`ssign` is pinned by commit** (`SSIGN_REV`, v0.1.7), not by tag, in both
  workflows. Run the rehearsal on `main` before a release whenever it changes;
  that run is also what builds the client the release then takes from the cache.

### The cached signing client

Building `ssign` took 2.9 minutes of the Windows leg (measured on the run for
`v26.10.3-rc1`), so both workflows keep the built client in the Actions cache.
It is installed into a folder of its own, `%RUNNER_TEMP%\ssign-client`, with
`cargo install --root`, and that folder is what is cached. The key is
`ssign-<runner OS>-<runner architecture>-<SSIGN_REV>` and there are no
`restore-keys`, so a client built from another commit is never restored.
`cargo install` runs only when the cache has nothing under that key; starting
the client (`ssign --version`) and copying `sign-windows.cmd` beside it happen
on every run.

**The cached file is the program that reads the Certum login.** What follows
from how GitHub scopes a cache:

- **A run on a tag can restore only a cache saved on the default branch** (or
  on that same tag). So the client a release uses is the one
  `sign-rehearsal.yml` saved when it ran on `main`. A tag that finds none
  builds the client as before; nothing fails, the leg is three minutes slower.
- **After changing `SSIGN_REV`, run the rehearsal on `main` once.** The new
  commit is a new key, so that run builds the client and saves it. The cache is
  saved only when every step of the job passed, so what a release restores has
  signed two files and had both signatures read back.
- **A cache that nothing read for 7 days is removed.** The next run then builds
  the client again and saves it again.
- **Only a workflow run on `main` can replace the client that releases use.**
  A pull request from a fork cannot write a cache that `main` or a tag reads.
  Whoever can push a workflow to `main` can, which is the same person who can
  change `release.yml` itself. An existing entry is never overwritten: it has
  to be deleted first (`gh cache delete <key>`), and the next rehearsal on
  `main` then saves a new one.
- **The key is the only thing that ties the file to the commit.** If there is
  ever a doubt about what is in the cache, delete the entry and run the
  rehearsal on `main`: `gh cache list --key ssign-` shows what is there and on
  which ref.

The cargo cache of the release job (`Swatinem/rust-cache`) holds cargo's own
folders and `src-tauri/target`. The client is not in either, and has to stay
out of `~/.cargo/bin`, which that cache saves.

### Four failures already paid for

Each of these cost `tpdf` one rehearsal tag or one release. The files here are
written so as not to repeat them; do not simplify them back.

| What was tried | What happened |
|---|---|
| The overlay's path put together in the job matrix | `github.workspace` is empty there, so Tauri was given `/src-tauri/tauri.signing.conf.json`. The path is put together in the build step's `args` |
| `ssign` named directly as the sign command | `failed to run ssign` and no reason: Tauri shows nothing of a sign command that failed. Hence the wrapper and its log, which the step *Show what the signing client said* prints |
| `ssign` writing the file in place | `atomically replacing ...: Access is denied. (os error 5)`, a fraction of a second after Tauri had written the executable. `ssign` replaces a file by renaming a signed copy over it. Hence `sign-windows.ps1`, which lets it sign into its own folder and copies the bytes back, again for up to thirty seconds |
| The wrapper finding its script through `%~dp0` | A release with an unsigned `uninstall.exe`. makensis starts the wrapper by its quoted name through `PATH` from `target\release\nsis\x64`, cmd then gives that folder for `%~dp0`, the script is not there, makensis prints `UninstFinalize command returned 64` and goes on. Hence `SCREENPICK_SIGN_SCRIPT`, and hence the leg installs what it built and reads `uninstall.exe` where it lands |

`npx tauri build --verbose` is the one way to see what makensis says; without
it Tauri shows none of it.

### No `.msi`

`ssign` signs executables only: it refuses an `.msi` with `not a PE (no MZ
signature)`. A release with a signed installer beside an unsigned package is
worse than one without the package, so `bundle.targets` in `tauri.conf.json` is
`["app", "dmg", "nsis"]` and no `.msi` is built from the release after 26.10.2
on. `"all"` would bring it back, and the Windows leg fails if one appears.

What that costs: the `.msi` was downloaded five times in all, twice each from
26.7.4 and 26.7.5 and once from 26.7.6, and never from 26.7.7 to 26.10.2 (read
from the release assets on 2026-10-08). A copy installed from an `.msi` finds
no `windows-x86_64-msi` in `latest.json`, falls back to `windows-x86_64` and
runs the NSIS installer, which leaves the `.msi` registered beside its own
entry: two installed copies. That was measured for `tpdf` and not for
ScreenPick. The release notes and the README say to uninstall the `.msi` once.

### Rehearsing

`sign-rehearsal.yml` proves the build of `ssign` and the login without building
ScreenPick. It downloads the installer of a published release that is unsigned
(default `v26.10.2`, the last one built before signing), checks that it is
unsigned, signs it and a plain executable the way makensis starts the command,
holds one of the two open against writing so that the retry has to wait, reads
both signatures back and installs from the signed installer.

```sh
gh workflow run sign-rehearsal.yml --ref main
gh run list --workflow sign-rehearsal.yml --limit 1
```

Run it before the first release that signs, whenever `SSIGN_REV` changed, and
when a release leg fails in the build step with a login error. Run it with
`--ref main`: only a run on `main` saves the signing client where a release tag
can read it ([The cached signing client](#the-cached-signing-client)).

It does not cover the build itself: the overlay, Tauri starting the command,
and the uninstaller signed inside makensis are first exercised by a tag. The
tag filter of `release.yml` also matches a name such as `vYY.M.MICRO-rc1`,
which builds and signs everything and ends in a draft that nobody publishes.
Delete that draft and the tag afterwards, and delete the tag on the remote by
name. A draft is never served by `releases/latest`, so no installed copy sees
it.

### Signing by hand

The fallback when the workflow cannot sign. Certum supports one way to use the
key: log in to its desktop program with the account's e-mail address and a
six-digit code, after which the certificate appears in the user's certificate
store and `signtool` can use it.

```
signtool sign /sha1 <thumbprint> /fd sha256 /tr http://time.certum.pl /td sha256 <file>
tools/verify_signature.ps1 -Signer 'Open Source Developer Timo Stein' -Path <file>
```

An installer signed after the build no longer matches its updater `.sig`,
which is over the installer's bytes: make the `.sig` again with
`npx tauri signer sign` and put its contents into `latest.json`, or the updater
refuses the download. An installer signed by hand also contains an unsigned
`screenpick.exe` and uninstaller, because those are signed during the build
or not at all.

### What has been seen and what has not

Seen in `tpdf`, with these scripts and this pin, on `windows-2025`: one login
signing every file of a build, each signature valid, timestamped and by the
signer, the uninstaller included; the updater `.sig` verifying against the
signed installer; the signed installer installing.

Seen here on 2026-10-08, at commit `df165d0`, each at the first attempt:

- `sign-rehearsal.yml`, run 37745453182: the 26.10.2 installer and a plain
  executable read `NotSigned` before and valid, timestamped and by the signer
  after; the file held open was written at the sixth attempt; the signed
  installer installed with exit code 0.
- The tag `v26.10.3-rc1`, run 37745986428, both legs: one login signed eight
  files, `screenpick.exe`, five NSIS plugin libraries, the uninstaller and the
  installer. The leg read the installer back, installed it, and found
  `screenpick.exe` and `uninstall.exe` as the executables of the installation
  folder, both signed. The draft held six assets and no `.msi`; `latest.json`
  named `windows-x86_64` and `windows-x86_64-nsis` and no `windows-x86_64-msi`;
  `minisign` verified the downloaded installer against its `.sig`. The draft
  and the tag were deleted afterwards.

Not yet seen: a published signed release, the signed installer read on a
Windows computer outside GitHub, and the client restored from the cache on a
tag (see *The cached signing client*).

## Release Procedure

### 1. Pre-release Checklist

**Update toolchains and dependencies:**
- [ ] `rustup update stable`
- [ ] `cargo update --manifest-path src-tauri/Cargo.toml` — review major bumps against changelogs.
      Confirm the update landed in the file, not only in cargo's output: `git diff --stat -- src-tauri/Cargo.lock` must list the lockfile whenever cargo printed `Updating` lines. On 2026-09-30 `cargo update` printed 55 updates and exited 0 three times in a row without writing the lockfile.
- [ ] `npm update && npm outdated` — review remaining majors individually.
- [ ] **Majors are a decision to put to the maintainer, not one to make silently.**
      `npm update` / `cargo update` only move within the allowed range, so anything
      still listed by `npm outdated` is a held-back major. Do not apply them
      unprompted and do not quietly skip them either: for each one, say what it is,
      what it would take, and **whether anything is actually blocking the upgrade**
      (a breaking API in use here, a peer-dep conflict, an unported plugin) — then
      ask whether to take it in this cycle or defer. "Two majors held back, both
      clean, want them?" is the answer being looked for; a bare list is not.
- [ ] `cargo audit -f Cargo.lock` (install: `cargo install cargo-audit`) — run from
      `src-tauri/` so it picks up `.cargo/audit.toml`. Expect a **clean exit** (only the
      pre-triaged "allowed warnings" — unmaintained gtk3-family crates, `paste`, `anyhow`
      1.0.104, `memmap2` via pinned xcap — none actionable). If `cargo audit` reports a
      new, non-allow-listed vulnerability, that is a real release blocker: do not add it to
      `.cargo/audit.toml` without recording, next to the entry, why it was reviewed and
      accepted and under which condition it is revisited (the ignore list is empty today). A
      release must not ship with an unreviewed red `cargo audit`. The release
      workflow's `audit` job runs `cargo audit` on every tag as well, and no
      installer is built unless it passes; keep this local step anyway, so a
      finding surfaces before the tag rather than after it. `ci.yml` does not
      audit.
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
      drifted bindings fails the gate before any installer is produced.
      `release.yml` skips its `test` job only when its `proven` job found a
      finished, green `ci.yml` push run with all three jobs green on the very
      commit the tag names; in every other case, a CI run that is still going
      included, the tests run again on the tag. That macOS job is
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
- [ ] **Windows signing rehearsed, if anything it depends on changed** since the
      last signed release: `SSIGN_REV`, `tools/sign-windows.*`,
      `tools/verify_signature.ps1`, the signing steps of `release.yml`, or the
      secrets of the `signing` environment. `gh workflow run sign-rehearsal.yml --ref main`,
      then read the run; see [Rehearsing](#rehearsing). No other project that
      signs with the same certificate may be releasing at the same time.

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

> The push check (`.githooks/pre-push`) only runs in a clone where the hooks path
> was set. Before pushing, `git config core.hooksPath` must print `.githooks`; if
> it prints nothing, run `git config core.hooksPath .githooks`.

```sh
gh auth switch --user tstone-1
git add -A
git commit -m "Release vYY.M.MICRO: brief description"
git push origin main
# Wait for ci.yml to pass on this exact commit, including the macOS bindings check.
# Inspect the selected run's headSha, conclusion, and jobs with gh run view.
# A tag pushed after that run is green skips the release workflow's own tests
# (its "CI already passed this commit?" job says so); a tag pushed earlier
# runs them again, which is slower and not wrong.
git tag vYY.M.MICRO
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
which builds the **macOS universal DMG** and the **Windows x64 installer**, signs
both, and publishes them to a **draft** GitHub Release for you to review and publish. This repo is public,
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

- [ ] Build the Windows installer on a Windows machine (`npx tauri build`, see
      [Build Output](#build-output)) and attach it to the same release:
      `gh release upload vYY.M.MICRO src-tauri/target/release/bundle/nsis/ScreenPick_*_x64-setup.exe`.
      **That installer is unsigned**: a local build has no sign command. Sign it
      as [Signing by hand](#signing-by-hand) says, or say in the release notes
      that it is not signed.
- [ ] `gh release view vYY.M.MICRO` confirms it points to the tag and lists the
      `.dmg` + `-setup.exe` assets.

**Updater checks — after publishing the draft, not before.** The endpoint
resolves `releases/latest`, which ignores drafts and prereleases, so the update
only goes live when the release does.

The job *Check the updater manifest* in `release.yml` has already read
`latest.json` from the draft once both legs were done: it fails unless the file
exists, carries the tag's version, has a signed entry for `darwin-aarch64`,
`darwin-x86_64` and `windows-x86_64`, points `windows-x86_64` at the
`-setup.exe` and names no `.msi`. The first three checks below repeat that on
the published release, which is the address an installed copy asks.

- [ ] The release lists six assets: `latest.json`, the `.dmg`, the
      `-setup.exe` and its `.sig`, and the `.app.tar.gz` and its `.sig`. There
      is no `.msi`. **No `latest.json` means no update reaches anyone** — the
      most likely cause is a missing/empty signing secret, since `tauri-action`
      logs "Signature not found for the updater JSON. Skipping upload..." and
      still finishes green.
- [ ] `curl -sL https://github.com/tstone-1/screenpick/releases/latest/download/latest.json | jq '.version, (.platforms | keys)'`
      reports the new version and **both** `darwin-*` and `windows-x86_64` keys.
      A manifest with only one platform means the release matrix raced (see the
      `max-parallel: 1` comment in `release.yml`) — re-run the missing leg.
- [ ] The `windows-x86_64` and `windows-x86_64-nsis` URLs both point at the
      `-setup.exe`, and there is no `windows-x86_64-msi` key. An MSI update on
      top of an NSIS install creates a second parallel installation instead of
      upgrading.
- [ ] **The Windows leg's step *Verify the Windows build is signed* printed
      `[OK]` for the installer, `screenpick.exe` and `uninstall.exe`**, and the
      downloaded installer reads as signed on a Windows computer:
      `(Get-AuthenticodeSignature .\ScreenPick_*_x64-setup.exe) | Format-List Status, SignerCertificate, TimeStamperCertificate`
      — `Valid`, subject `CN=Open Source Developer Timo Stein`, and a timestamp
      certificate. A signature without a timestamp stops being valid on the day
      the certificate expires.

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
SemVer with `26.5.0` (May 2026)**.

| Segment | Meaning | Example |
|---------|---------|---------|
| **YY** | Two-digit year | 26 = 2026 |
| **M** | Month, no zero-padding | 5 = May |
| **MICRO** | Sequential release within the month, starting at 0 | 0, 1, 2… |

Examples: `26.5.0` (first May 2026 release), `26.5.1` (second), `26.6.0` (first June).

The same `YY.M.MICRO` value must appear in `package.json`, `package-lock.json`
(top-level and root package), `src-tauri/Cargo.toml`, and
`src-tauri/tauri.conf.json`, with `Cargo.lock` refreshed by `cargo check`; the local tag must be `vYY.M.MICRO`; and (once a
channel exists) the published release must point to that tag. Do not leave a tag,
release, or version file behind on an older value.

## Dependency Pin Notes

Every pin in `src-tauri/Cargo.toml` carries its own why/when-to-revisit comment
inline — that's the source of truth on the Rust side. `package.json` has no
comment syntax, so anything pinned there is documented here instead. It has no
pin today: the `overrides.cookie: "0.7.2"` entry was removed with the move to
SvelteKit 3 (26.10.0), which depends on `cookie ^2` directly and fails to build
against the forced 0.7.2 (`Named export 'parseCookie' not found`).

Two majors are held back on purpose, and `npm outdated` lists both:

- **`typescript` 6** — TypeScript 7 is installed as `@typescript/native` for the
  tsgo pass. The `typescript` package itself stays on 6 because SvelteKit 3
  peers on `typescript ^6` and svelte-check 4 on `^5 || ^6`. **Revisit** when
  both accept 7 (`npm info @sveltejs/kit peerDependencies.typescript`,
  `npm info svelte-check peerDependencies.typescript`).
- **`@types/node` 24** — follows the Node major in `.nvmrc` and the workflows.
  **Revisit** when those move to Node 26.

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
git diff --stat -- src-tauri/Cargo.lock   # must list the lockfile if cargo printed updates
npm update && npm outdated
npm audit && (cd src-tauri && cargo audit -f Cargo.lock)   # run from src-tauri/ for .cargo/audit.toml
npm run check && npm run test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
# Hard gate, macOS only — see Pre-release Checklist:
cargo test --manifest-path src-tauri/Cargo.toml export_typescript_bindings
# Bump version in package.json, package-lock.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json
rg -n '"version"|^version =' package.json package-lock.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
cargo check --manifest-path src-tauri/Cargo.toml   # refresh Cargo.lock
# Move CHANGELOG.md entry to [YY.M.MICRO] - YYYY-MM-DD
npx tauri build --target universal-apple-darwin   # local smoke build (unsigned, ad-hoc)
gh auth switch --user tstone-1
git add -A && git commit -m "Release vYY.M.MICRO: description"
git push origin main
# Wait for ci.yml to pass on this exact commit, including the macOS bindings check.
git tag vYY.M.MICRO && git push origin vYY.M.MICRO   # tag by name, never --tags
git describe --tags --exact-match
# Pushing the tag triggers release.yml, which builds macOS + Windows and opens a
# DRAFT release. Review it, then publish: gh release edit vYY.M.MICRO --draft=false
# Only after publishing does the updater endpoint resolve — then verify it:
# curl -sL https://github.com/tstone-1/screenpick/releases/latest/download/latest.json | jq '.version, (.platforms | keys)'
#
# Local publish alternative (skip the CI build):
# gh release create vYY.M.MICRO --title "ScreenPick vYY.M.MICRO" --notes-from-tag <dmg-path>
# gh release upload vYY.M.MICRO <setup.exe path>   # Windows installer, built on Windows (unsigned)
```
