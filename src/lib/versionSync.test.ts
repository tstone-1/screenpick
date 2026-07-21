import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Repo root, two levels up from src/lib.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(file: string): string {
  return readFileSync(join(root, file), "utf8");
}

// BUILD.md requires the version of record to be identical across all four
// files. Releases have desynced them before (npm side left stale while the
// Rust side bumped), so guard it here — this test runs on every platform,
// unlike the macOS-only tauri-specta bindings check.
describe("version of record", () => {
  it("matches across package.json, package-lock.json, Cargo.toml and tauri.conf.json", () => {
    const pkg = JSON.parse(read("package.json")).version as string;
    const lockJson = JSON.parse(read("package-lock.json"));
    const lock = lockJson.version as string;
    // package-lock.json carries the version twice: the top-level field (above)
    // AND `packages[""].version` (the lockfile's own entry for the root
    // package, used by npm's package-lock v2+ format). BUILD.md's "bump the
    // version in all four files" step only names the top-level field, so a
    // hand-edited bump (the historical failure mode this test exists for) can
    // desync exactly the field this checked (N5 in the 2026-07 code review) —
    // `npm version`/`npm install` keep both in sync automatically, but a
    // manual edit doesn't.
    const lockRootPackageVersion = lockJson.packages?.[""]?.version as string | undefined;
    const cargo = read("src-tauri/Cargo.toml").match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    const tauri = JSON.parse(read("src-tauri/tauri.conf.json")).version as string;

    expect(pkg, "package.json version").toMatch(/^\d+\.\d+\.\d+$/);
    expect({
      "package-lock.json": lock,
      'package-lock.json packages[""].version': lockRootPackageVersion,
      "Cargo.toml": cargo,
      "tauri.conf.json": tauri
    }).toEqual({
      "package-lock.json": pkg,
      'package-lock.json packages[""].version': pkg,
      "Cargo.toml": pkg,
      "tauri.conf.json": pkg
    });
  });
});
