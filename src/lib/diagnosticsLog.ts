// Thin adapter over tauri-plugin-log's JS API (see the other small adapters,
// e.g. editorCommands.ts, for the "keep @tauri-apps/* imports out of state/
// orchestration modules" convention this follows).
//
// W5 in the 2026-07 code review: the Rust side registers tauri-plugin-log
// with a file sink, but nothing on the webview side forwarded to it, so
// `console.error`/`console.warn` detail — the only place frontend failures
// were visible — never reached the on-disk diagnostic log the README tells
// users to attach. logError/logWarn keep writing to the console (preserving
// today's devtools debuggability) AND forward the same detail to the plugin.
//
// Fire-and-forget by design: the plugin's IPC call rejects when there's no
// Tauri runtime underneath the page (vitest/jsdom, a bare browser tab), and a
// logging call must never be the thing that throws. `void ... .catch(() => {})`
// swallows that unconditionally.
import { error as logErrorIpc, warn as logWarnIpc } from "@tauri-apps/plugin-log";

// Render `detail` (an Error, or any other failure value) as one ASCII-safe
// trailing fragment, preferring a stack trace when available since that's
// the most actionable thing to find in a packaged-build log file.
function formatDetail(detail: unknown): string {
  if (detail === undefined) return "";
  if (detail instanceof Error) return ` ${detail.stack ?? detail.message}`;
  return ` ${String(detail)}`;
}

export function logError(message: string, detail?: unknown): void {
  console.error(message, detail);
  void logErrorIpc(`${message}${formatDetail(detail)}`).catch(() => {});
}

export function logWarn(message: string, detail?: unknown): void {
  console.warn(message, detail);
  void logWarnIpc(`${message}${formatDetail(detail)}`).catch(() => {});
}
