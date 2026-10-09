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

// A top-level job: from its two-space key to the next one.
function jobs(text: string): Map<string, string> {
  const body = text.slice(text.indexOf("\njobs:\n") + "\njobs:\n".length);
  const found = new Map<string, string>();
  for (const block of body.split(/\n(?= {2}[A-Za-z_][\w-]*:\n)/)) {
    const name = /^ {2}([A-Za-z_][\w-]*):\n/.exec(block);
    if (name) found.set(name[1], block);
  }
  return found;
}

// One step of a job, found by its name: from its `- name:` line to the next
// step. Exactly one step may carry the name.
function step(job: string, name: string): string {
  const found = job.split(/\n(?= {6}- )/).filter((part) => part.includes(`- name: ${name}\n`));
  expect(found).toHaveLength(1);
  return found[0];
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

  it("keeps the built signing client in a cache that only its own commit can fill", () => {
    for (const workflow of workflows) {
      const text = read(workflow);
      // At job level, six spaces in: the `env` context of a cache key does not
      // see a variable that one step sets for itself.
      expect(text).toMatch(/^ {6}SSIGN_REV: [0-9a-f]{40}$/m);
      expect(text).toContain("uses: actions/cache@v6\n");
      expect(text).toContain("path: ${{ runner.temp }}\\ssign-client\n");
      expect(text).toContain("key: ssign-${{ runner.os }}-${{ runner.arch }}-${{ env.SSIGN_REV }}\n");
      // A fallback key would restore a client built from another commit.
      expect(text).not.toMatch(/^\s*restore-keys:/m);

      // One install, of the pinned commit, into the folder the cache holds
      // and not into cargo's own bin folder, which the cargo cache saves.
      const installs = text.split("\n").filter((line) => line.includes("cargo install"));
      expect(installs).toHaveLength(1);
      expect(installs[0]).toContain("--locked ");
      expect(installs[0]).toContain("--rev $env:SSIGN_REV ");
      expect(installs[0]).toContain('--root "$env:RUNNER_TEMP\\ssign-client" ');

      // The build runs on a miss only; starting the client and copying the
      // wrapper are in a step of their own that runs on a hit too.
      const steps = text.split(/\n(?= {6}- )/);
      const build = steps.filter((step) => step.includes("cargo install"));
      expect(build).toHaveLength(1);
      expect(build[0]).toMatch(/^ {8}if: .*steps\.ssign\.outputs\.cache-hit != 'true'$/m);
      const start = steps.filter((step) => step.includes("--version"));
      expect(start).toHaveLength(1);
      expect(start[0]).not.toContain("cache-hit");
      expect(start[0]).toContain("tools\\sign-windows.cmd");
      expect(start[0]).toContain("$env:GITHUB_PATH");
    }
  });

  it("puts every signing job in the one concurrency group and the one environment", () => {
    // A job signs when it is handed the login, and the login is in the
    // `signing` environment only. Each such job is checked by itself: one job
    // in the group does not cover a second one beside it.
    const signing: string[] = [];
    for (const workflow of workflows) {
      const text = read(workflow);
      const forWholeWorkflow = /^concurrency:\n {2}group: certum-signing\n {2}cancel-in-progress: false$/m.test(text);
      for (const [name, job] of jobs(text)) {
        if (!job.includes("secrets.CERTUM_")) continue;
        signing.push(`${workflow}:${name}`);
        expect(job).toMatch(/^ {4}environment: signing$/m);
        const group = /^ {4}concurrency:\n {6}group: (.+)\n {6}cancel-in-progress: false$/m.exec(job)?.[1];
        if (group === undefined) {
          expect(forWholeWorkflow, `${workflow}:${name} is in no concurrency group`).toBe(true);
        } else {
          // The release job is a matrix, and only its Windows leg signs.
          expect(group).toBe(
            "${{ matrix.signs-windows && 'certum-signing' || format('release-{0}-{1}', github.run_id, matrix.platform) }}"
          );
        }
      }
    }
    expect(signing).toEqual([
      ".github/workflows/release.yml:release",
      ".github/workflows/sign-rehearsal.yml:rehearse"
    ]);
  });
});

// The release workflow skips its own tests when CI passed the same commit.
// That is safe only while CI runs everything the skipped job runs, and while
// the number the release asks for is the number of jobs CI has.
describe("release workflow gates", () => {
  const release = read(".github/workflows/release.yml");
  const ci = read(".github/workflows/ci.yml");

  // The commands of a job whose steps are single-line `run:` entries.
  function commands(job: string): string[] {
    return [...job.matchAll(/^ {8}run: (.+)$/gm)].map((match) => match[1]);
  }

  it("finds the jobs it reads", () => {
    expect([...jobs(release).keys()]).toEqual(["proven", "test", "audit", "release", "manifest"]);
    expect([...jobs(ci).keys()]).toEqual(["macos", "linux", "windows"]);
  });

  it("asks CI for as many green jobs as CI has, on a push to main", () => {
    const proven = jobs(release).get("proven") ?? "";
    expect(proven).toMatch(/^ {4}permissions:\n {6}actions: read$/m);
    expect(proven).toContain("workflows/ci.yml/runs?head_sha=$SHA&event=push&status=success");
    const asked = /if \[ "\$jobs" = "(\d+) true" \]/.exec(proven);
    expect(asked?.[1]).toBe(String(jobs(ci).size));
    // A job that can be skipped would make a green run that tested less.
    for (const job of jobs(ci).values()) expect(job).not.toMatch(/^ {4}if:/m);
    expect(ci).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]$/m);
  });

  it("skips the tests on a verified yes only, and runs nothing in them that CI does not", () => {
    const test = jobs(release).get("test") ?? "";
    expect(test).toMatch(/^ {4}needs: proven$/m);
    expect(test).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) && needs\.proven\.outputs\.passed != 'true' \}\}$/m);
    expect(test).toMatch(/^ {8}platform: \[macos-latest, windows-2025\]$/m);

    const wanted = commands(test);
    expect(wanted).toEqual([
      "npm ci",
      "npm run check",
      "npm run test:unit",
      "cargo test --manifest-path src-tauri/Cargo.toml --locked"
    ]);
    // Every step of the job is one of those commands or a `uses:`.
    expect(test).not.toMatch(/^ {8}run: \|/m);
    for (const [name, runner] of [
      ["macos", "macos-latest"],
      ["windows", "windows-2025"]
    ]) {
      const job = jobs(ci).get(name) ?? "";
      expect(job).toMatch(new RegExp(`^ {4}runs-on: ${runner}$`, "m"));
      for (const command of wanted) expect(commands(job)).toContain(command);
    }
  });

  it("audits on every tag, with a released cargo-audit at a fixed version", () => {
    const audit = jobs(release).get("audit") ?? "";
    // No condition and no dependency: CI does not audit, so this is never skipped.
    expect(audit).not.toMatch(/^ {4}(if|needs):/m);
    expect(audit).toMatch(/^ {8}uses: taiki-e\/install-action@[0-9a-f]{40} # v\d+\.\d+\.\d+$/m);
    expect(audit).toMatch(/^ {10}tool: cargo-audit@\d+\.\d+\.\d+$/m);
    expect(audit).toMatch(/^ {10}fallback: none$/m);
    expect(audit).toMatch(/^ {8}working-directory: src-tauri\n {8}run: cargo audit -f Cargo\.lock$/m);
    // Compiling it from source is what took four to six minutes a leg.
    expect(release).not.toContain("cargo install cargo-audit");
  });

  it("builds only after the audit, and after tests that passed or were proven", () => {
    const job = jobs(release).get("release") ?? "";
    expect(job).toMatch(/^ {4}needs: \[proven, test, audit\]$/m);
    const condition = /^ {4}if: >-\n((?: {6}.+\n)+)/m.exec(job)?.[1].replace(/\s+/g, " ").trim();
    expect(condition).toBe(
      "${{ !cancelled() && needs.audit.result == 'success' && (needs.test.result == 'success' || (needs.test.result == 'skipped' && needs.proven.outputs.passed == 'true')) }}"
    );
  });

  // Two legs at once can each read the updater manifest before the other has
  // written it, and the second upload then drops the first platform. Nothing
  // fails when that happens, so the setting and the check for its effect are
  // both pinned here.
  it("builds the two platforms one after the other", () => {
    const job = jobs(release).get("release") ?? "";
    expect(job).toMatch(/^ {6}max-parallel: 1$/m);
    expect(job.match(/max-parallel:/g)).toHaveLength(1);
  });

  it("fails the release when the updater manifest lacks a platform", () => {
    const job = jobs(release).get("manifest") ?? "";
    expect(job).toMatch(/^ {4}needs: release$/m);
    // `test` is skipped when CI has proven the commit, and a job behind a
    // skipped one is skipped too unless it says otherwise.
    expect(job).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) && needs\.release\.result == 'success' \}\}$/m);
    const check = step(job, "Check that latest.json names every platform");
    expect(check).toMatch(/^ {10}WANTED: darwin-aarch64 darwin-x86_64 windows-x86_64$/m);
    expect(check).toMatch(/^ {10}TAG_NAME: \$\{\{ github\.ref_name \}\}$/m);
    expect(check).toContain('gh release download "$TAG_NAME"');
    expect(check).toContain("for key in $WANTED; do");
    // No expression inside the script: values reach it through `env`.
    expect(check.slice(check.indexOf("run: |"))).not.toContain("${{");
  });

  // The Apple secrets are optional so that a fork can build. In this
  // repository a missing one is a mistake, and the notarization check further
  // down is skipped without them, so the leg would be green and unnotarized.
  it("refuses to build this repository's macOS release without the Apple secrets", () => {
    const job = jobs(release).get("release") ?? "";
    const prepare = step(job, "Prepare Apple signing and notarization");
    const missing = /^( {10})if \[ -z "\$APPLE_CERTIFICATE" \] \|\| \[ -z "\$APPLE_API_KEY_P8" \]; then\n((?: {12}.*\n)+) {10}fi$/m.exec(prepare)?.[2] ?? "";
    expect(missing).toMatch(
      /^ {12}if \[ "\$GITHUB_REPOSITORY" = "tstone-1\/screenpick" \]; then\n {14}echo "::error::.+"\n {14}exit 1\n {12}fi$/m
    );
    // A fork still builds, ad-hoc signed, with the warning.
    expect(missing).toMatch(/^ {12}echo "::warning::.+"\n {12}exit 0$/m);
    expect(missing.indexOf("exit 1")).toBeLessThan(missing.indexOf("exit 0"));
  });
});
