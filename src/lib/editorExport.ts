// The export/clipboard/reveal/drag file-operations block: single and batch
// PNG export, no-clobber batch naming (slugify + Windows reserved-name
// handling), reveal-in-file-manager, copy-path/copy-image-to-clipboard, and
// native drag-out. Every one of these hands out the same artifact — the
// document's flattened `current.png` (annotations baked in) when persisted,
// falling back to the un-annotated base raster otherwise — via
// `currentArtifactPath` below.
//
// Split out of editor.svelte.ts (W5 in the 2026-07 code review) alongside
// documentStore.svelte.ts. Deliberately plain functions, not a class: this
// module holds no `$state` of its own. Every function that needs live editor
// state (the open document's identity, its annotation layer, whether a
// document needs persisting first) takes it as a parameter instead — that's
// what keeps this module free of a dependency on EditorState/DocumentStore,
// per the review's requirement that "export functions can take the state
// they need as parameters." EditorState keeps its existing public methods
// (`editor.exportCapture()`, `editor.revealCapture(capture)`, ...) as thin
// wrappers that supply those parameters from its own fields.
import { commands, type DocumentRecord } from "./bindings";
import {
  copyPngBytesToClipboard as copyPngBytesToClipboardIpc,
  pickDirectory,
  pickPngSavePath,
  savePngBytes as savePngBytesIpc,
  savePngBytesNew as savePngBytesNewIpc,
  startFileDrag as startFileDragIpc
} from "./editorCommands";
import { renderFlattenedPng } from "./annotationRendering";
import { logWarn } from "./diagnosticsLog";
import type { Annotation } from "./annotations";
import type { RecentCapture } from "./documentStore.svelte";

const { copyImageToClipboard: copyImageToClipboardIpc, revealInDir: revealInDirIpc } = commands;

// Upper bound on filename-suffix bumps when batch-exporting captures with the
// same slug into one folder (`screenshot.png`, `screenshot-2.png`, ...). A guard
// against an unbounded loop if every candidate name is somehow taken; far above
// any realistic same-title batch.
const MAX_EXPORT_NAME_ATTEMPTS = 1000;

// Windows reserved device names (case-insensitive, extension-independent) —
// `CON.png`, `com1.png`, etc. all fail to create on that OS, even though the
// name is otherwise a perfectly valid slug. Batch export derives filenames
// from capture titles, so a title that happens to slugify down to one of
// these (a window literally titled "Con", or "COM1" for a serial-port app)
// needs a disambiguating suffix rather than failing the whole batch.
const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9"
]);

// Slugify a capture title into a filesystem-safe base name (no extension),
// used for both the single-image save dialog's default name and the batch
// export's per-file name. Lowercased; runs of characters that aren't a letter
// or digit (this also covers the characters illegal in Windows filenames,
// `:\/*?"<>|`) collapse to a single hyphen; leading/trailing hyphens trimmed.
// Falls back to a generic name when the title has no usable characters, and
// appends a suffix when the result would otherwise collide with a Windows
// reserved device name.
export function slugifyCaptureTitle(title: string): string {
  const name = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
  const base = name || "screenpick-capture";
  return WINDOWS_RESERVED_NAMES.has(base) ? `${base}-capture` : base;
}

// Slugify a capture title into a suggested PNG filename, used for both the
// single-image save dialog's default name and the batch export's per-file
// name.
function suggestedPngName(capture: RecentCapture): string {
  return `${slugifyCaptureTitle(capture.title)}.png`;
}

// Shared save tail for both export paths (the open document's own export
// button, and a Recent-strip capture's "Save image as..."): slugify the
// capture title into a suggested filename, prompt for a PNG destination,
// flatten `annotations` over the capture, and write. Returns an error
// message, or null on success/cancel. Exported under the name `exportRecentCapture`
// alone would undersell that EditorState.exportCapture() (open document) uses
// it too — kept as one function since the two call sites are identical once
// their capture/annotations are resolved by the caller.
export async function saveFlattenedPng(
  capture: RecentCapture,
  annotations: Annotation[]
): Promise<string | null> {
  const suggested = suggestedPngName(capture);
  try {
    const dest = await pickPngSavePath(suggested);
    if (!dest) return null;
    const bytes = await renderFlattenedPng(capture, annotations);
    const result = await savePngBytesIpc(dest, bytes);
    if (result.status === "error") return result.error || "Export failed.";
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error || "Export failed.");
  }
}

// Write `bytes` into `dir` under the capture's slugified name, never
// overwriting an existing file. The backend writes with `create_new`, so a
// name that's already taken — by a pre-existing file on disk OR an earlier
// capture written in this same batch — comes back as "not written" and we bump
// `-2`, `-3`, ... until one sticks. Disk is the single source of truth, which
// is why there's no in-memory "used names" set. Returns an error message, or
// null on success. Forward slash is a valid path separator on Windows too, so
// the join works for the dialog-returned directory on every platform.
async function writeWithoutClobber(
  dir: string,
  capture: RecentCapture,
  bytes: Uint8Array
): Promise<string | null> {
  const base = suggestedPngName(capture).replace(/\.png$/i, "");
  for (let n = 1; n <= MAX_EXPORT_NAME_ATTEMPTS; n += 1) {
    const name = n === 1 ? `${base}.png` : `${base}-${n}.png`;
    const result = await savePngBytesNewIpc(`${dir}/${name}`, bytes);
    if (result.status === "error") return result.error || "Export failed.";
    if (result.data) return null; // wrote a fresh file
    // result.data === false: the name already exists — try the next suffix.
  }
  return `Too many files already named like "${base}".`;
}

// Batch "Save images as...": save several recent captures into a single
// user-chosen folder in one go (used by the Recent list's multi-selection
// context menu). Each capture is flattened with its annotations (resolved via
// `annotationsForCapture`, since the caller may not have the open document's
// live layer for a capture other than the one currently open) like the
// single-image export, named from its slugified title, and de-duplicated
// within the batch so two captures sharing a title don't overwrite each
// other. Returns a human-readable status to surface in the activity bar, or
// null when the user cancels the folder picker. Delegates to the single
// export (with its native save dialog) when only one capture is selected.
export async function exportRecentCaptures(
  captures: RecentCapture[],
  annotationsForCapture: (capture: RecentCapture) => Annotation[]
): Promise<string | null> {
  if (captures.length === 0) return null;
  if (captures.length === 1) {
    return saveFlattenedPng(captures[0], annotationsForCapture(captures[0]));
  }
  let dir: string | null;
  try {
    dir = await pickDirectory("Save images to folder");
  } catch (error) {
    return error instanceof Error ? error.message : String(error || "Export failed.");
  }
  if (!dir) return null;
  let saved = 0;
  const errors: string[] = [];
  for (const capture of captures) {
    try {
      const bytes = await renderFlattenedPng(capture, annotationsForCapture(capture));
      const error = await writeWithoutClobber(dir, capture, bytes);
      if (error) errors.push(error);
      else saved += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error || "Export failed."));
    }
  }
  if (errors.length === 0) return `Saved ${saved} images to ${dir}.`;
  if (saved === 0) return `Could not save images. ${errors[0]}`;
  return `Saved ${saved} of ${captures.length} images; ${errors.length} failed (${errors[0]}).`;
}

// Shared prelude for reveal/copy-path/copy-image: resolve the flattened
// current.png path (the annotated artifact these three hand out), persisting
// pending edits first when `isOpenDocument` is true so the on-disk file is
// current before it's revealed/copied. Falls back to the base path for an
// unpersisted capture. `isOpenDocument` / `persistOpenDocument` are supplied
// by the caller (EditorState), which owns the "is this the open document"
// check and the actual persist call. Extracted (N2 in the 2026-07 code
// review) so the three callers below can't drift on this identical prelude.
async function currentArtifactPath(
  capture: RecentCapture,
  isOpenDocument: boolean,
  persistOpenDocument: () => Promise<DocumentRecord | null>
): Promise<string> {
  let path = capture.currentPath ?? capture.path;
  if (isOpenDocument) {
    const saved = await persistOpenDocument();
    if (saved) path = saved.currentPath;
  }
  return path;
}

// Reveal the capture's flattened current.png (the annotated artifact copy-path
// hands out) in the OS file manager. Persists first when it's the open document
// so the on-disk file is current. Falls back to the base for an unpersisted
// capture. Returns an error message on failure, or null on success.
export async function revealCapture(
  capture: RecentCapture,
  isOpenDocument: boolean,
  persistOpenDocument: () => Promise<DocumentRecord | null>
): Promise<string | null> {
  const path = await currentArtifactPath(capture, isOpenDocument, persistOpenDocument);
  try {
    const result = await revealInDirIpc(path);
    if (result.status === "error") return result.error || "Could not reveal the file.";
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error || "Could not reveal the file.");
  }
}

// Copy the path to the capture's flattened image (the document's current.png,
// which bakes in the annotations) so the pasted path matches what the user
// sees. If this is the open document, persist any pending edits first so the
// file on disk is current at copy time. Falls back to the base path for an
// in-memory capture with no document yet. Returns an error message, or null.
export async function copyCapturePath(
  capture: RecentCapture,
  isOpenDocument: boolean,
  persistOpenDocument: () => Promise<DocumentRecord | null>
): Promise<string | null> {
  const path = await currentArtifactPath(capture, isOpenDocument, persistOpenDocument);
  try {
    await navigator.clipboard.writeText(path);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error || "Could not copy the path.");
  }
}

// Copy a Recent capture's flattened image (current.png — annotations baked in)
// to the OS clipboard, matching what copy-path / export hand out. Persists
// first when it's the open document so the bytes are current; falls back to the
// base image for an unpersisted capture. Returns an error message, or null.
export async function copyCaptureImage(
  capture: RecentCapture,
  isOpenDocument: boolean,
  persistOpenDocument: () => Promise<DocumentRecord | null>
): Promise<string | null> {
  const path = await currentArtifactPath(capture, isOpenDocument, persistOpenDocument);
  try {
    const result = await copyImageToClipboardIpc(path);
    if (result.status === "error") return result.error || "Could not copy the image.";
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error || "Could not copy the image.");
  }
}

// Start a native OS drag of one or more Recent captures so they can be dropped
// into other apps (a Claude Code session, a chat, Explorer) as real image
// files. Drags each capture's flattened `current.png` (annotations baked in,
// matching copy/export). Deliberately synchronous up to the IPC call:
// persisting first would await mid-gesture and drop the native drag, and edits
// autosave in the background, so `current.png` is already current.
//
// Caveat (unlike the batch export, which live-renders annotations): a capture
// that has annotations but hasn't persisted yet has no `currentPath`, so we
// fall back to the un-annotated base raster (`path`). That window is small —
// autosave produces `current.png` shortly after the first edit — but a drag in
// that instant drops the base image, not the annotated one.
//
// The first file doubles as the drag-cursor preview. No-op when nothing
// resolves to a usable path.
export function dragCaptures(captures: RecentCapture[]): void {
  const paths = captures
    .map((capture) => capture.currentPath ?? capture.path)
    .filter((path): path is string => Boolean(path));
  if (paths.length === 0) return;
  // startFileDrag rejects if the native drag can't start. Log but don't
  // surface it: a failed drag is a no-op gesture (nothing drops), and there's
  // no activity-bar context for a drag the way there is for a click action.
  void startFileDragIpc(paths, paths[0]).catch((error) => {
    logWarn("drag-out failed to start", error);
  });
}

// Copy the flattened capture (crop + annotations, exactly as shown) to the
// OS clipboard. Returns an error message on failure, or null on success.
export async function copyToClipboard(
  capture: RecentCapture,
  annotations: Annotation[]
): Promise<string | null> {
  try {
    const bytes = await renderFlattenedPng(capture, annotations);
    const result = await copyPngBytesToClipboardIpc(bytes);
    if (result.status === "error") return result.error || "Copy to clipboard failed.";
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error || "Copy to clipboard failed.");
  }
}
