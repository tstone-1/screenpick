// Adapter for the exit handshake. Rust holds the quit (see `begin_shutdown` in
// src-tauri/src/lib.rs), emits `AppExiting`, and waits for `confirm_exit`; this
// is the frontend half. Kept in its own module — rather than inline in
// +page.svelte or as a method on EditorState — for the same reason as
// editorCommands.ts / updaterCommands.ts: the page wires one line, and the flush
// it performs is injected, so this stays testable with no Tauri runtime beneath.
import { commands, events } from "./bindings";
import { logWarn } from "./diagnosticsLog";

// Subscribe to the exit handshake. `flush` is awaited before the quit is
// released; it must resolve (or reject) rather than hang, since Rust only waits
// EXIT_FLUSH_TIMEOUT_MS before exiting regardless. Returns a teardown; the
// listener attaches asynchronously, so it also has to survive being torn down
// before it is ready.
export function listenForExit(flush: () => Promise<void>): () => void {
  let unlisten: (() => void) | null = null;
  let cancelled = false;

  void events.appExiting
    .listen(() => {
      void (async () => {
        try {
          await flush();
        } catch (error) {
          // A failed flush must never strand the user in an app that won't
          // quit. Losing the pending write is bad; refusing to close is worse,
          // so this always falls through to confirm_exit.
          logWarn("Could not flush pending work before exit", error);
        }
        try {
          await commands.confirmExit();
        } catch (error) {
          // The Rust-side timeout is the backstop here — it exits anyway.
          logWarn("Could not confirm exit", error);
        }
      })();
    })
    .then((stop) => {
      if (cancelled) {
        stop();
        return;
      }
      unlisten = stop;
    })
    .catch((error: unknown) => {
      logWarn("Could not listen for the exit handshake", error);
    });

  return () => {
    cancelled = true;
    unlisten?.();
  };
}
