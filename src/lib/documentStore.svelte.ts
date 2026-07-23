// The document/session store: recents-strip state, per-capture workspace
// caching (annotations + view + undo/redo for documents opened this run),
// disk-restored ("seeded") annotation layers, retention/eviction of clean
// documents, and persistence orchestration (the actual document-record I/O).
//
// Split out of editor.svelte.ts (W5 in the 2026-07 code review) alongside
// editorExport.ts. `EditorState` composes a `DocumentStore` instance and
// keeps its own public surface (`editor.recentCaptures`, `editor.document`,
// `editor.openCapture(...)`, ...) unchanged via thin delegating
// getters/methods — see the "seam" comment in editor.svelte.ts for how the
// two halves divide the undo/redo snapshot contract and the live
// `document`/`currentCapture`/`annotations` state, which stays in
// EditorState because nearly every per-tool gesture method (out of scope for
// this split) reads and writes it directly.
import { commands, type CaptureResult, type DocumentRecord } from "./bindings";
import { saveDocument as saveDocumentIpc, toAssetUrl } from "./editorCommands";
import { logError } from "./diagnosticsLog";
import { renderFlattenedPng } from "./annotationRendering";
import { deserializeAnnotations, serializeAnnotations, type Annotation, type CropRect } from "./annotations";

// N9: cropCapture/cutoutCapture/copyImageToClipboard/revealInDir are pure
// `commands.*` pass-throughs used elsewhere (editor.svelte.ts's gesture code,
// editorExport.ts); only the document-record commands are re-aliased here.
const {
  createDocument: createDocumentIpc,
  deleteDocument: deleteDocumentIpc,
  listDocuments: listDocumentsIpc,
  replaceDocumentBase: replaceDocumentBaseIpc
} = commands;

export type { CaptureResult };

export type RecentCapture = CaptureResult & {
  assetUrl: string;
  // Identity of the persistent annotation document backing this capture. Set
  // once `create_document` resolves (asynchronously, after the capture is shown);
  // absent for in-memory-only captures (e.g. unit tests, or if persistence
  // failed). `path` is the working base raster; `currentPath` is the document's
  // flattened `current.png` — the artifact "copy path" / export point at.
  documentId?: string;
  currentPath?: string;
  dirty?: boolean;
};

// View state (zoom/pan/mode) wrapping the capture currently open in the
// editor — distinct from a persisted `DocumentRecord` (Rust, documents.rs),
// which is the on-disk annotation-document row this view may or may not be
// backed by. Named `EditorView`, not `EditorDocument` (N4 in the 2026-07 code
// review): "document" was overloaded three ways in this codebase (this type,
// the Rust `DocumentRecord`, and the DOM global `document`) and the
// EditorState.document PROPERTY keeps that name (renaming the field is a
// bigger, separate blast radius) — only the type name changes here.
//
// Lives here (not editor.svelte.ts) because CaptureWorkspaceState below
// embeds it, even though the live `document` $state field stays on
// EditorState — see the seam comment there.
export type EditorView = {
  capture: RecentCapture;
  zoom: number;
  fitZoom: number;
  mode: "fit" | "custom";
  // Pan offset in CSS pixels, applied as a translate to the image frame from
  // its centered position. Lets the user drag the preview around so content at
  // the edges (otherwise pinned against the frame border / under the rulers)
  // can be drawn on comfortably. Reset to 0 whenever we fit-to-screen.
  panX: number;
  panY: number;
};

// The COMMITTED half of the undo/redo contract (see #resetTransientState in
// editor.svelte.ts for the transient half) — only committed document state
// belongs here. Assembled and consumed by EditorState (#snapshot/#restore);
// DocumentStore only stores/retrieves these as opaque-ish values keyed by
// workspace, via CaptureWorkspaceState below.
export type EditorSnapshot = {
  document: EditorView | null;
  currentCapture: RecentCapture | null;
  cropRect: CropRect | null;
  annotations: Annotation[];
  nextAnnotationId: number;
};

export type CaptureWorkspaceState = EditorSnapshot & {
  historyPast: EditorSnapshot[];
  historyFuture: EditorSnapshot[];
};

// How many *clean* (un-annotated) documents to keep in the strip. Clean captures
// are throwaway-by-default, so the oldest beyond this are auto-evicted (deleted
// from disk). Dirty documents — those carrying annotation work — are never
// auto-evicted; closing one requires explicit user consent.
const CLEAN_DOCUMENT_RETENTION = 8;

// Identity under which a capture's session workspace is cached: its document id
// when persisted (stable across crop/cut, which change `path`), else the path
// (the in-memory/test case, preserving the original path-keyed behavior).
export function workspaceKeyFor(capture: RecentCapture): string {
  return capture.documentId ?? capture.path;
}

// Build the post-crop/cut capture: a new working raster (`next`) that stays the
// same document (carries `previous`'s id + current.png path). `currentPath` /
// `dirty` are refreshed by the follow-up persist; carrying them keeps the
// strip/copy-path correct in the gap before that resolves. Pure — no store
// state — so it's a standalone function rather than a DocumentStore method.
export function rebasedCapture(previous: RecentCapture, next: CaptureResult): RecentCapture {
  return {
    ...next,
    assetUrl: toAssetUrl(next.path),
    documentId: previous.documentId,
    currentPath: previous.currentPath,
    dirty: previous.dirty
  };
}

// Reflect a freshly persisted document's metadata (dirty flag, current.png
// path) onto an in-memory RecentCapture, leaving every other capture and every
// other field untouched. Deliberately does NOT patch title/width/height from
// `record` — the live in-memory capture (already updated by crop/cut or
// undo/redo) is the source of truth for the working raster's dimensions; see
// the fuller rationale on DocumentStore#persistDocument. Shared by
// DocumentStore.applyRecordToRecent (patches `recentCaptures`) and
// EditorState's #persistCurrentDocument wrapper (patches its own `document`/
// `currentCapture` fields with the same rule).
export function recentCapturePatchForRecord(
  record: DocumentRecord
): (capture: RecentCapture) => RecentCapture {
  return (capture) =>
    capture.documentId === record.id
      ? { ...capture, currentPath: record.currentPath, dirty: record.dirty }
      : capture;
}

export class DocumentStore {
  recentCaptures = $state<RecentCapture[]>([]);
  // User-visible signal that the most recent document-persistence attempt
  // (create, autosave, or crop/cut re-base) failed — sanitized message; full
  // detail always goes to the diagnostics log (console + the on-disk log
  // file, via logError) alongside it. Rendered as a status-bar badge
  // (+page.svelte) next to captureActivity, which plays the same role for
  // capture-side failures. Cleared on the next successful persist.
  persistError = $state<string | null>(null);

  // Session workspaces (annotations + view + undo/redo) for documents opened this
  // run, keyed by `workspaceKeyFor` (documentId when persisted, else path).
  #captureWorkspaces = new Map<string, CaptureWorkspaceState>();
  // Annotations loaded from disk for persisted documents not yet opened this
  // session (the restored strip). Seeded by `loadPersistedDocuments`, consumed by
  // EditorState.openCapture on first open, keyed by documentId.
  #seededAnnotations = new Map<string, Annotation[]>();
  // The base-image source path last successfully copied into a document's
  // base.png, keyed by documentId (not workspace-scoped, so it naturally
  // survives document switches and undo/redo within a session).
  // #persistDocument compares this against the live capture's path to
  // decide whether a re-base is needed even when the caller didn't ask for
  // one: undo/redo restores an old (or, on redo, a newer) capture via
  // EditorState#restore, which changes `path`/dims WITHOUT going through the
  // replaceBase=true call that produced them, so trusting only the caller's
  // flag can silently persist an annotation layer against the wrong raster.
  #lastPersistedBasePath = new Map<string, string>();

  // --- workspace cache ---

  getWorkspace(capture: RecentCapture): CaptureWorkspaceState | undefined {
    return this.#captureWorkspaces.get(workspaceKeyFor(capture));
  }

  saveWorkspace(capture: RecentCapture, workspace: CaptureWorkspaceState): void {
    this.#captureWorkspaces.set(workspaceKeyFor(capture), workspace);
  }

  // Migrate a workspace from its pre-identity key (an in-memory capture's path)
  // to its post-identity key (the freshly assigned documentId), used when
  // create_document resolves after the user may have already started editing.
  migrateWorkspaceKey(from: RecentCapture, toKey: string): void {
    const key = workspaceKeyFor(from);
    const workspace = this.#captureWorkspaces.get(key);
    if (!workspace) return;
    this.#captureWorkspaces.delete(key);
    this.#captureWorkspaces.set(toKey, workspace);
  }

  evictStaleWorkspaces(currentCapture: RecentCapture | null): void {
    const keep = new Set(this.recentCaptures.map((capture) => workspaceKeyFor(capture)));
    if (currentCapture) keep.add(workspaceKeyFor(currentCapture));
    for (const key of this.#captureWorkspaces.keys()) {
      if (!keep.has(key)) this.#captureWorkspaces.delete(key);
    }
  }

  // --- seeded (restored-from-disk, not-yet-opened) annotations ---

  seedAnnotations(documentId: string, annotations: Annotation[]): void {
    this.#seededAnnotations.set(documentId, annotations);
  }

  takeSeededAnnotations(documentId: string): Annotation[] | undefined {
    const seeded = this.#seededAnnotations.get(documentId);
    if (seeded) this.#seededAnnotations.delete(documentId);
    return seeded;
  }

  clearSeededAnnotations(): void {
    this.#seededAnnotations.clear();
  }

  // Best-known annotation layer for a capture: the live layer when it's the
  // open document (`openDocument`/`openAnnotations`, passed by the caller since
  // those remain EditorState-owned), otherwise its cached session workspace or
  // its restored-from-disk seeded layer (empty if none is known). Lets export/
  // flatten act on any strip entry, not just the open one.
  annotationsForCapture(
    capture: RecentCapture,
    openDocument: EditorView | null,
    openAnnotations: Annotation[]
  ): Annotation[] {
    if (openDocument && workspaceKeyFor(openDocument.capture) === workspaceKeyFor(capture)) {
      return openAnnotations;
    }
    const workspace = this.#captureWorkspaces.get(workspaceKeyFor(capture));
    if (workspace) return workspace.annotations;
    const seeded = capture.documentId ? this.#seededAnnotations.get(capture.documentId) : undefined;
    return seeded ?? [];
  }

  // Whether a capture carries annotation work — the predicate behind the
  // consent-on-close rule and clean-document eviction. Checks the persisted
  // dirty flag, the live layer (if `capture` is the open document — identified
  // by `openDocumentId`/`openAnnotationsLength`, EditorState-owned), an
  // in-session workspace, and the seeded layer of a restored-but-unopened
  // document, so a just-drawn annotation counts even before its debounced save
  // lands.
  isDocumentDirty(
    capture: RecentCapture,
    openDocumentId: string | undefined,
    openAnnotationsLength: number
  ): boolean {
    if (capture.dirty) return true;
    if (capture.documentId && capture.documentId === openDocumentId) {
      return openAnnotationsLength > 0;
    }
    const workspace = this.#captureWorkspaces.get(workspaceKeyFor(capture));
    if (workspace && workspace.annotations.length > 0) return true;
    const seeded = capture.documentId ? this.#seededAnnotations.get(capture.documentId) : undefined;
    return !!seeded && seeded.length > 0;
  }

  // --- recents strip / retention ---

  // Crop/cut re-base an existing document (same documentId, new image): replace
  // its strip entry in place rather than adding a duplicate. Distinct captures
  // (and in-memory ones without an id) are always prepended. `openCapture` /
  // `currentCapture` are EditorState's live `document?.capture` / `currentCapture`
  // — forwarded to enforceRetention (they're allowed to differ; see
  // evictStaleWorkspaces's own field).
  pushRecent(
    capture: RecentCapture,
    openCapture: RecentCapture | null,
    currentCapture: RecentCapture | null
  ): void {
    const rest = capture.documentId
      ? this.recentCaptures.filter((entry) => entry.documentId !== capture.documentId)
      : this.recentCaptures;
    this.recentCaptures = [capture, ...rest];
    this.enforceRetention(openCapture, currentCapture);
  }

  removeFromRecents(capture: RecentCapture): void {
    this.recentCaptures = this.recentCaptures.filter(
      (entry) => workspaceKeyFor(entry) !== workspaceKeyFor(capture)
    );
  }

  // Keep every dirty document plus the most-recent clean ones; auto-evict (delete
  // from disk) clean documents beyond the retention limit. The open document and
  // not-yet-persisted in-memory captures are always kept. Strip order is MRU
  // (newest first), so retained clean docs are the freshest.
  enforceRetention(openCapture: RecentCapture | null, currentCapture: RecentCapture | null): void {
    const currentKey = openCapture ? workspaceKeyFor(openCapture) : null;
    let cleanKept = 0;
    const survivors: RecentCapture[] = [];
    const evicted: RecentCapture[] = [];
    for (const entry of this.recentCaptures) {
      const isCurrent = workspaceKeyFor(entry) === currentKey;
      // `isCurrent` always short-circuits before isDocumentDirty's "live
      // document" branch would matter here (an entry reaching that branch is
      // never the open one), so passing undefined/0 for the open-document
      // params is safe and avoids a second, near-duplicate dirty predicate.
      if (isCurrent || !entry.documentId || this.isDocumentDirty(entry, undefined, 0)) {
        survivors.push(entry);
        continue;
      }
      cleanKept += 1;
      if (cleanKept <= CLEAN_DOCUMENT_RETENTION) survivors.push(entry);
      else evicted.push(entry);
    }
    this.recentCaptures = survivors;
    for (const entry of evicted) this.discardDocument(entry);
    this.evictStaleWorkspaces(currentCapture);
  }

  // Delete a document's persisted files + session caches (workspace, seeded
  // layer). Does NOT touch `recentCaptures` — callers handle the strip so they
  // can batch (retention) or branch on the open document (close).
  //
  // Fire-and-forget from the caller's perspective (retention evicts a whole
  // batch synchronously; close-document doesn't block on disk I/O either), but
  // the result is still checked (N1 in the 2026-07 code review): an ignored
  // failure here silently resurrects a discarded document at next launch,
  // since nothing else would ever retry or even notice the delete didn't
  // happen.
  discardDocument(capture: RecentCapture): void {
    this.#captureWorkspaces.delete(workspaceKeyFor(capture));
    if (capture.documentId) {
      const id = capture.documentId;
      this.#seededAnnotations.delete(id);
      this.#lastPersistedBasePath.delete(id);
      deleteDocumentIpc(id)
        .then((result) => {
          if (result.status !== "ok") {
            logError(`Failed to delete discarded document ${id}:`, result.error);
          }
        })
        .catch((error) => {
          logError(`Failed to delete discarded document ${id}:`, error);
        });
    }
  }

  // Upgrade every `recentCaptures` entry matched by `matches` (typically an
  // object-identity check against the pre-identity in-memory capture) via
  // `upgrade`. Used by EditorState's #attachDocumentIdentity, which also has to
  // upgrade its own `document`/`currentCapture` fields with the same closures.
  upgradeRecentCapture(
    matches: (capture: RecentCapture) => boolean,
    upgrade: (capture: RecentCapture) => RecentCapture
  ): void {
    this.recentCaptures = this.recentCaptures.map((capture) => (matches(capture) ? upgrade(capture) : capture));
  }

  applyRecordToRecent(record: DocumentRecord): void {
    this.recentCaptures = this.recentCaptures.map(recentCapturePatchForRecord(record));
  }

  recordLastPersistedBasePath(documentId: string, path: string): void {
    this.#lastPersistedBasePath.set(documentId, path);
  }

  recentFromRecord(record: DocumentRecord): RecentCapture {
    // Restored from disk: `path` IS `record.basePath` (the document's own
    // base raster), so the base is trivially already in sync with it — record
    // that up front, same as create-document identity attachment does for a
    // freshly created document (#persistDocument reads this back).
    this.recordLastPersistedBasePath(record.id, record.basePath);
    return {
      mode: record.mode,
      title: record.title,
      path: record.basePath,
      width: record.width,
      height: record.height,
      assetUrl: toAssetUrl(record.basePath),
      documentId: record.id,
      currentPath: record.currentPath,
      dirty: record.dirty
    };
  }

  // --- persistence orchestration ---

  // Create the persistent document backing a freshly captured image. Runs in the
  // background so capture stays instant: the capture is shown immediately as an
  // in-memory entry, then "upgraded" with its document identity once this
  // resolves (by the caller). A failure leaves the capture usable but
  // unpersisted; returns null so the caller skips identity attachment.
  async createDocumentFor(capture: RecentCapture): Promise<DocumentRecord | null> {
    try {
      const result = await createDocumentIpc(
        capture.path,
        capture.mode,
        capture.title,
        capture.width,
        capture.height
      );
      if (result.status !== "ok") return null;
      return result.data;
    } catch (error) {
      logError("Failed to persist capture as a document:", error);
      this.persistError = "Could not save this screenshot as a document.";
      return null;
    }
  }

  // Populate the strip from persisted documents at startup. The editor opens
  // empty; clicking a tab opens that document with its saved annotations (their
  // layers are seeded here, applied on first open).
  async loadPersistedDocuments(
    openCapture: RecentCapture | null,
    currentCapture: RecentCapture | null
  ): Promise<void> {
    try {
      const result = await listDocumentsIpc();
      if (result.status !== "ok") return;
      const records = result.data;
      this.clearSeededAnnotations();
      const recordDerived = records.map((record) => {
        this.seedAnnotations(record.id, deserializeAnnotations(record.annotations));
        return this.recentFromRecord(record);
      });
      // Merge, don't replace (N3 in the 2026-07 code review): a hotkey capture
      // that completes while this load is still in flight (e.g. `listDocuments`
      // is slow, or create_document raced ahead of it) has already pushed an
      // in-memory entry onto `recentCaptures` — the disk snapshot predates it,
      // so wholesale-replacing the array would silently drop its strip entry.
      // Disk records win for any key they carry (they're the authoritative,
      // freshly-seeded state); an in-memory entry survives only for a key no
      // record has. It's kept ahead of the disk-derived list — the same
      // position `pushRecent`'s MRU-newest-first prepend would have put it,
      // since nothing on disk is newer than a capture still being ingested.
      const recordKeys = new Set(records.map((record) => record.id));
      const inMemoryOnly = this.recentCaptures.filter(
        (entry) => !entry.documentId || !recordKeys.has(entry.documentId)
      );
      this.recentCaptures = [...inMemoryOnly, ...recordDerived];
      // Apply the clean-document retention policy to the restored strip (the
      // dirty flag is persisted, so dirty docs are correctly retained here).
      this.enforceRetention(openCapture, currentCapture);
    } catch (error) {
      logError("Failed to load persisted documents:", error);
      this.persistError = "Could not load your saved screenshots.";
    }
  }

  // Write `capture`'s annotation layer + a freshly flattened current.png to the
  // store, and reflect the returned dirty/currentPath back onto `recentCaptures`.
  // `options.replaceBase` additionally copies the (new) working raster into the
  // document — used after crop/cut, which change the base image.
  //
  // `options.replaceBase` alone is not trusted as the sole signal for whether a
  // re-base is needed. `capture.path` can legitimately diverge from the
  // document's on-disk base.png without the caller asking for a re-base —
  // undo/redo restores an old (or, on redo, a newer) capture via EditorState's
  // #restore, changing `path`/dims without going through the `{ replaceBase:
  // true }` call that produced them. Comparing against #lastPersistedBasePath
  // catches that drift regardless of which caller triggered this save, so the
  // annotation layer/flattened render below is always written against the
  // raster actually on disk.
  //
  // Called by EditorState's debounced-save machinery (the timer itself stays
  // there, since it needs to re-read the live `document`/`annotations` at fire
  // time — see the seam comment in editor.svelte.ts). The caller is
  // responsible for patching its own `document`/`currentCapture` from the
  // returned record with `recentCapturePatchForRecord`; this method only
  // patches `recentCaptures`.
  async persistDocument(
    capture: RecentCapture,
    annotations: Annotation[],
    options: { replaceBase?: boolean } = {}
  ): Promise<DocumentRecord | null> {
    if (!capture.documentId) return null;
    const id = capture.documentId;
    const dirty = annotations.length > 0;
    const needsRebase = options.replaceBase || this.#lastPersistedBasePath.get(id) !== capture.path;
    try {
      if (needsRebase) {
        const based = await replaceDocumentBaseIpc(
          id,
          capture.path,
          capture.title,
          capture.width,
          capture.height
        );
        if (based.status !== "ok") {
          this.persistError = based.error || "Could not save this screenshot's changes.";
          return null;
        }
        this.recordLastPersistedBasePath(id, capture.path);
      }
      const bytes = await renderFlattenedPng(capture, annotations);
      const saved = await saveDocumentIpc(id, serializeAnnotations(annotations), bytes, dirty);
      if (saved.status !== "ok") {
        this.persistError = saved.error || "Could not save this screenshot's changes.";
        return null;
      }
      this.applyRecordToRecent(saved.data);
      this.persistError = null;
      return saved.data;
    } catch (error) {
      logError("Failed to persist document:", error);
      this.persistError =
        error instanceof Error ? error.message : "Could not save this screenshot's changes.";
      return null;
    }
  }
}
