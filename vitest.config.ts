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
export default defineConfig({
  plugins: [svelte()],
  // Vite's dependency prebundling is a dev-server feature Vitest doesn't need
  // (its module runner loads ESM/CJS deps directly), and with the `conditions:
  // ["browser"]` override below it can't work at all: when the optimizer
  // decides to prebundle a dependency, rolldown's injected CJS-interop runtime
  // (`import { createRequire } from 'node:module'`) fails to resolve node
  // builtins under browser conditions. That surfaced as a cold-start-only CI
  // flake — "Could not resolve 'node:module' in \0rolldown/runtime.js" killed
  // the v26.7.5 release run's test job while the same commit passed ci.yml and
  // every warm local run. Turning discovery off makes startup deterministic.
  optimizeDeps: {
    noDiscovery: true,
    include: []
  },
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
