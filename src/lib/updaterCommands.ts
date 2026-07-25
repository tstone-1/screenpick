// Thin adapter over tauri-plugin-updater and tauri-plugin-process, following
// the same convention as editorCommands.ts / diagnosticsLog.ts: keep the
// `@tauri-apps/*` imports out of the state machine so `updateState.svelte.ts`
// stays a state machine over a small typed surface (and stays mockable in
// vitest, where no Tauri runtime exists underneath the page).
//
// Unlike editorCommands.ts these are NOT one-line pass-throughs of `commands.*`
// bindings — the updater is a Tauri *plugin*, outside the specta contract, so
// this file is where its shape gets pinned down to what the UI actually needs.
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { relaunch as relaunchApp } from "@tauri-apps/plugin-process";

// What the UI needs from a pending update. The plugin's own `Update` object
// carries a live handle (it owns the download), so it is passed back opaquely
// rather than reconstructed.
export type PendingUpdate = {
  version: string;
  // Release notes from latest.json. Absent for releases published without them.
  notes: string | null;
  // Downloads AND installs — the plugin exposes no way to separate the two, so
  // the name says both. `onInstalling` fires when the bytes are in and the
  // install begins, which is the only honest moment to show an "installing"
  // state: once this promise resolves the install is already done.
  downloadAndInstall: (callbacks: {
    onProgress: (downloaded: number, total: number | null) => void;
    onInstalling: () => void;
  }) => Promise<void>;
};

// Resolves to null when the running build is already current. Rejects when the
// endpoint is unreachable or the manifest is unusable — callers decide whether
// that is worth showing (a failed background check is not).
export async function checkForUpdates(): Promise<PendingUpdate | null> {
  const update = await checkForUpdate();
  if (!update) return null;

  return {
    version: update.version,
    notes: update.body ?? null,
    downloadAndInstall: async ({ onProgress, onInstalling }) => {
      let downloaded = 0;
      let total: number | null = null;
      // The plugin streams three event kinds; only Started carries the content
      // length, and Progress reports per-chunk deltas rather than a running
      // total, so the accumulation has to happen here. `Finished` means the
      // download finished — the install runs after it, before the outer promise
      // resolves — so that is where the installing state belongs.
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? null;
            onProgress(0, total);
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            onProgress(downloaded, total);
            break;
          case "Finished":
            onProgress(total ?? downloaded, total);
            onInstalling();
            break;
        }
      });
    }
  };
}

// Restart into the freshly installed build. On Windows the NSIS installer has
// already terminated the app by the time this would run, so the call is
// effectively macOS-only in practice — it must never be the thing that throws.
export function relaunch(): Promise<void> {
  return relaunchApp();
}
