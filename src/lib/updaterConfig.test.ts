import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Repo root, two levels up from src/lib.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, file), "utf8")) as Record<string, unknown>;
}

// Placeholder committed alongside the updater wiring so the config is complete
// and reviewable before the signing key exists. This test is what stops it from
// reaching a release: a build with a placeholder pubkey produces artifacts no
// client can verify, and the failure would otherwise surface as "update
// silently never installs" on users' machines rather than in CI.
const PUBKEY_PLACEHOLDER = "REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY";

// The updater config is spread across two files that must agree, and both are
// easy to break silently — a missing permission fails only at runtime in a
// packaged build, and a missing pubkey fails only on a user's machine. This
// runs on every platform, unlike the macOS-only bindings check.
describe("updater configuration", () => {
  const conf = readJson("src-tauri/tauri.conf.json");
  const bundle = conf.bundle as Record<string, unknown>;
  const updater = (conf.plugins as Record<string, unknown>).updater as Record<string, unknown>;

  it("emits updater artifacts from the bundler", () => {
    // Without this the release builds no .app.tar.gz/.nsis.zip and no .sig, so
    // tauri-action has nothing to put in latest.json and skips it entirely —
    // a release that looks fine and updates nobody.
    expect(bundle.createUpdaterArtifacts).toBe(true);
  });

  it("carries a real signing public key", () => {
    const pubkey = updater.pubkey;
    expect(typeof pubkey).toBe("string");
    expect(pubkey).not.toBe(PUBKEY_PLACEHOLDER);
    expect((pubkey as string).length).toBeGreaterThan(0);
  });

  it("fetches the manifest over https from this repo's releases", () => {
    const endpoints = updater.endpoints as string[];
    expect(Array.isArray(endpoints)).toBe(true);
    expect(endpoints.length).toBeGreaterThan(0);
    for (const endpoint of endpoints) {
      // Plain http would let a network attacker serve a manifest; the minisign
      // signature still gates installation, but https costs nothing here.
      expect(endpoint.startsWith("https://")).toBe(true);
    }
    expect(endpoints).toContain(
      "https://github.com/tstone-1/screenpick/releases/latest/download/latest.json",
    );
  });

  it("grants the main window updater and restart permissions", () => {
    const capability = readJson("src-tauri/capabilities/default.json");
    const permissions = capability.permissions as string[];
    expect(permissions).toContain("updater:default");
    expect(permissions).toContain("process:allow-restart");
  });

  it("keeps updater permissions off the capture overlays", () => {
    // The overlays are transient, always-on-top windows; nothing there should
    // be able to trigger a download or restart the app.
    const overlays = readJson("src-tauri/capabilities/overlays.json");
    const permissions = overlays.permissions as string[];
    expect(permissions.some((p) => p.startsWith("updater:"))).toBe(false);
    expect(permissions.some((p) => p.startsWith("process:"))).toBe(false);
  });
});
