import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Repo root, two levels up from src/lib.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(file: string): string {
  return readFileSync(join(root, file), "utf8");
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(read(file)) as Record<string, unknown>;
}

// Windows signing is spread over a config, an overlay, a wrapper and two
// workflows, and none of it runs before a release tag. These are the parts
// that can be broken by an edit that looks harmless; BUILD.md, "Windows code
// signing", has what each one cost.
describe("windows signing configuration", () => {
  const workflows = [".github/workflows/release.yml", ".github/workflows/sign-rehearsal.yml"];

  it("builds no .msi, which the signing client cannot sign", () => {
    const bundle = readJson("src-tauri/tauri.conf.json").bundle as Record<string, unknown>;
    // "all" is a string and includes the MSI on Windows.
    expect(Array.isArray(bundle.targets)).toBe(true);
    expect(bundle.targets).toContain("nsis");
    expect(bundle.targets).not.toContain("msi");
  });

  it("keeps the sign command in the overlay, so a local build asks for no login", () => {
    const bundle = readJson("src-tauri/tauri.conf.json").bundle as Record<string, unknown>;
    const main = (bundle.windows ?? {}) as Record<string, unknown>;
    expect(main.signCommand).toBeUndefined();

    const overlay = readJson("src-tauri/tauri.signing.conf.json").bundle as Record<string, unknown>;
    const command = (overlay.windows as Record<string, unknown>).signCommand as Record<string, unknown>;
    expect(command.cmd).toBe("sign-windows.cmd");
    // Tauri replaces %1 with the file to sign; without it nothing is signed.
    expect(command.args).toEqual(["%1"]);
  });

  it("lets the wrapper find its script through the environment, not beside itself", () => {
    const code = read("tools/sign-windows.cmd")
      .split(/\r?\n/)
      .filter((line) => !/^\s*rem\b/i.test(line));
    // makensis starts the wrapper by name through PATH from another folder,
    // where %~dp0 is that folder and the script is not in it.
    expect(code.some((line) => line.includes("%~dp0"))).toBe(false);
    expect(code.some((line) => line.includes('"%SCREENPICK_SIGN_SCRIPT%"'))).toBe(true);
    for (const workflow of workflows) {
      expect(read(workflow)).toMatch(/^\s+SCREENPICK_SIGN_SCRIPT: \$\{\{ github\.workspace \}\}\/tools\/sign-windows\.ps1$/m);
    }
  });

  it("builds the signing client from one commit in both workflows", () => {
    const revisions = workflows.map((workflow) => {
      const found = [...read(workflow).matchAll(/^\s+SSIGN_REV: (\S+)$/gm)].map((match) => match[1]);
      expect(found).toHaveLength(1);
      // A commit and not a tag: a tag can be moved.
      expect(found[0]).toMatch(/^[0-9a-f]{40}$/);
      return found[0];
    });
    expect(new Set(revisions).size).toBe(1);
  });

  it("puts every signing job in the one concurrency group and the one environment", () => {
    for (const workflow of workflows) {
      const text = read(workflow);
      expect(text).toMatch(/^\s+environment: signing$/m);
      expect(text).toMatch(/^\s*group: certum-signing\n\s*cancel-in-progress: false$/m);
    }
  });
});
