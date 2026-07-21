import { convertFileSrc } from "@tauri-apps/api/core";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";

import { commands, type DocumentRecord } from "./bindings";

type CommandResult<T> = Promise<{ status: "ok"; data: T } | { status: "error"; error: string }>;

// Thin adapter over the editor's Tauri commands, mirroring the role
// `windowPickerCommands.ts` plays for the window picker: keeps `convertFileSrc`
// and the handful of Tauri plugin APIs (dialogs, native drag) out of editor
// state/orchestration modules so they stay state machines over a typed IPC
// surface, not Tauri API sinks.
//
// Narrowed rule (N9 in the 2026-07 code review): a pure one-line pass-through
// of a `commands.*` call earns nothing by living here — callers import
// `commands` from `./bindings` directly and call it themselves. Only genuinely
// value-adding wrappers belong in this file: native dialogs/drag (no
// `commands.*` equivalent), `loadImage`'s CORS/decode handling, and the
// Uint8Array-as-`number[]` binary-IPC shim (tauri-specta has no Uint8Array
// type, so every PNG-bytes command needs the same `as unknown as number[]`
// cast — duplicating that at every call site would be the real smell).

export function savePngBytes(destPath: string, bytes: Uint8Array): CommandResult<null> {
  // Tauri 2 ferries typed arrays as binary IPC; the bindings declare
  // `number[]` because tauri-specta lacks a Uint8Array type, but the runtime
  // accepts the buffer as-is and avoids the N-element JSON inflation.
  return commands.savePngBytes(destPath, bytes as unknown as number[]);
}

// Non-clobbering write for the dialog-less batch export: resolves `true` when a
// fresh file was written and `false` when `destPath` already exists (the caller
// bumps the filename suffix and retries). The single-image path uses the
// dialog-backed `savePngBytes`, whose native overwrite prompt this one replaces.
export function savePngBytesNew(destPath: string, bytes: Uint8Array): CommandResult<boolean> {
  return commands.savePngBytesNew(destPath, bytes as unknown as number[]);
}

// --- Persistent annotation documents (see src-tauri/src/documents.rs) ---
// `listDocuments` / `createDocument` / `replaceDocumentBase` / `deleteDocument`
// are pure pass-throughs — callers use `commands.*` directly. `saveDocument`
// stays here for the same Uint8Array-as-number[] shim as `savePngBytes`.

export function saveDocument(
  id: string,
  annotations: string,
  currentPng: Uint8Array,
  dirty: boolean
): CommandResult<DocumentRecord> {
  // Same Uint8Array-as-number[] binary-IPC shim as savePngBytes.
  return commands.saveDocument(id, annotations, currentPng as unknown as number[], dirty);
}

export function copyPngBytesToClipboard(bytes: Uint8Array): CommandResult<null> {
  // Same Uint8Array-as-number[] IPC shim as savePngBytes: the bytes ride the
  // binary IPC channel; the bindings only declare number[] for lack of a
  // Uint8Array type in tauri-specta.
  return commands.copyPngBytesToClipboard(bytes as unknown as number[]);
}

// Start a native OS drag of on-disk files (the drag plugin), so a Recent
// thumbnail can be dropped into other apps as real image files — something a
// plain webview HTML5 drag can't deliver. `icon` is the drag-cursor preview
// image path. Must be called from within a user gesture (the `dragstart`
// handler). Resolves when the drag ends; the result is reported via `onEvent`.
//
// Trust note: unlike `save_png_bytes`/`copy_image_to_clipboard`/`reveal_in_dir`,
// the plugin's `start_drag` command is NOT backend-gated — it drags whatever
// paths it's handed. This is an accepted gap, not an oversight: the only caller
// (`EditorState.dragCaptures`) sources paths exclusively from `recentCaptures`
// (genuine ScreenPick capture files), and the webview loads only bundled local
// content with no remote/untrusted code that could call it with a foreign path.
// If untrusted content is ever loaded into the webview, replace this with a
// custom `#[command]` that runs `verify_capture_source` on each path before
// delegating to the drag crate.
export function startFileDrag(paths: string[], icon: string): Promise<void> {
  return startDrag({ item: paths, icon });
}

// Prompt for a directory via the native open dialog. Resolves to the chosen
// path, or null if cancelled.
export function pickDirectory(title: string): Promise<string | null> {
  return open({ directory: true, title }).then((dir) =>
    typeof dir === "string" ? dir : null
  );
}

// Native confirm dialog used to gate destroying annotation work (closing a dirty
// document). Resolves true when the user confirms the discard. Kept here with the
// other dialog-plugin touchpoints so UI/state modules don't import it directly.
export function confirmDiscard(message: string): Promise<boolean> {
  return confirm(message, { title: "Discard annotations?", kind: "warning" });
}

// Prompt for a PNG export destination via the native save dialog. Kept here
// with the other Tauri touchpoints so editor modules don't import the dialog
// plugin directly. Resolves to the chosen path, or null if cancelled.
export function pickPngSavePath(suggested: string): Promise<string | null> {
  return save({
    defaultPath: suggested,
    filters: [{ name: "PNG image", extensions: ["png"] }]
  });
}

// Convert an on-disk capture path into an `asset://` URL the webview can
// load via `<img src>`. Centralised here so callers don't have to know
// Tauri's asset-protocol scope plumbing.
export function toAssetUrl(path: string): string {
  return convertFileSrc(path);
}

// Load an `asset://` capture URL into a decoded `<img>` ready to draw onto a
// canvas. `crossOrigin` MUST be set before `src`: Tauri serves `asset://` from
// a different origin than the webview (`tauri://`, or `http://localhost:1420`
// in dev), so without it the canvas is tainted on first `drawImage` and any
// readback fails — `getImageData` throws "DOMException: The operation is
// insecure", and `toBlob` silently yields a null blob (breaking PNG export).
// Lives next to `toAssetUrl` so the CORS requirement of the asset boundary is
// owned in one place and can't drift between the colour picker and exporter.
export async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = src;
  try {
    await image.decode();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load capture image (${src}): ${reason}`);
  }
  return image;
}
