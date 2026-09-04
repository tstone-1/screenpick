import { fileURLToPath } from "node:url";

import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

// Vitest config: the Svelte plugin is wired in so `.svelte.ts` rune modules
// (`$state`, `$derived`) can be imported by tests, AND so `*.component.test.ts`
// files below can compile/mount real `.svelte` components. Skipping the
// SvelteKit plugin keeps the harness small — pure-helper and rune-class tests
// stay fast and Node-only and just need the runes runtime in scope; component
// tests don't need it either, since none of the components under test import
// `$app/*` (SvelteKit's own runtime, which the plugin wires up) — only
// `$lib/*`, which the `resolve.alias` below handles directly. Revisit adding
// the SvelteKit plugin only if a component under test starts needing `$app/*`.
//
// Default environment stays "node" — pure-helper and rune-class tests are the
// overwhelming majority and don't need a DOM. Component tests (which mount
// real .svelte components via @testing-library/svelte) opt into jsdom
// per-file with a `// @vitest-environment jsdom` docblock comment at the top
// of the file (see EditorStage.component.test.ts) rather than a glob here:
// Vitest 4 removed `environmentMatchGlobs` (present in Vitest 1-2) in favor of
// per-file environment comments / the Test Projects (`test.projects`) feature
// — the per-file comment is the simpler of the two for a single test suffix.
// Still the mechanism on Vitest 5, verified rather than assumed when this repo
// moved to it.
//
// That default is not a neutral choice, and one test file's correctness hangs
// on overriding it: `.svelte.ts` modules imported under "node" are compiled in
// SSR mode, where `$state` is a plain value and nothing is proxied. Identity
// comparisons that are FALSE in the running app are therefore TRUE here, which
// is how a save bug survived months of a green suite (26.9.1).
// editorDocumentIdentity.component.test.ts opens with a test that asserts the
// proxy is live, so downgrading it to this default fails loudly instead of
// leaving it green and blind. Read that file before changing anything here.
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    // Without the SvelteKit plugin (deliberately skipped above), `$lib` isn't
    // resolved automatically — components under test import it directly
    // (`$lib/editor.svelte`, etc.), so alias it straight at the source dir
    // rather than pull in the full plugin just for this one alias.
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url))
    },
    // Vitest's default Node/SSR module resolution otherwise picks Svelte's
    // *server* runtime (`svelte/internal/server`), whose `mount()` throws
    // "not available on the server" — components need the client runtime
    // even though tests run under Node. `process.env.VITEST` scopes this to
    // test runs only; the real `npm run build` is untouched.
    conditions: process.env.VITEST ? ["browser"] : undefined
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node"
  }
});
