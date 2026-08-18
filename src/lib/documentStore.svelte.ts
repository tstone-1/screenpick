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
import {
  annotationLayerForBase,
  deserializeAnnotationLayer,
  serializeAnnotations,
  type Annotation,
  type CropRect
} from "./annotations";

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
  // Cache-busting revision for the Recent-strip thumbnail. `currentPath` keeps
  // the same file name (`current.png`) while its bytes are rewritten on every
  // save, and the webview caches by URL — so without a component that changes
  // per save, an <img> pointed at it renders the first version forever. Bumped
  // by `nextThumbnailRevision` from every persisted DocumentRecord; consumed by
  // `recentThumbnailUrl`. Absent for a capture that has never been persisted.
  thumbnailRevision?: number;
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
    dirty: previous.dirty,
    thumbnailRevision: previous.thumbnailRevision
  };
}

// The next cache-busting revision for a document's `current.png`, given the
// capture's previous one and the record just written.
//
// `record.updatedAt` is the natural key — Rust's save_document sets it to
// `now_millis()` on every write, so it tracks the file's content exactly — but
// it is not sufficient alone: it is nullable in the record type, and two saves
// landing inside the same millisecond would repeat it, which would pin the
// thumbnail on the older render with nothing left to correct it. Taking
// `max(updatedAt, previous + 1)` keeps the timestamp's meaning on the normal
// path while guaranteeing the value STRICTLY increases on every save, so the
// URL provably changes whenever the bytes do.
export function nextThumbnailRevision(
  previous: number | undefined,
  record: DocumentRecord
): number {
  const floor = (previous ?? 0) + 1;
  const stamp = record.updatedAt ?? 0;
  return stamp > floor ? stamp : floor;
}

// The image URL for a capture's Recent-strip thumbnail: the document's
// flattened `current.png` (annotations baked in — the same artifact copy/
// export/drag hand out) when one has been persisted, else the un-annotated
// base raster exactly as before. The strip is therefore accurate "as of the
// last save": an edit made since the debounced save fired is not in the
// thumbnail until that save lands. Deliberately not live-rendered — the strip
// would then re-rasterise every capture on every stroke.
//
// The revision is appended as a query component. Tauri's asset protocol reads
// only `uri().path()` (tauri/src/protocol/asset.rs) and `convertFileSrc`
// percent-encodes the whole path, so a query can neither collide with the file
// name nor reach the file lookup — it changes only the webview's cache key.
// The CORS/asset-boundary discipline documented at `toAssetUrl`/`loadImage` in
// editorCommands.ts is untouched: the origin is unchanged, and this URL is only
// ever fed to a plain <img> (no canvas readback), so it needs no crossOrigin.
export function recentThumbnailUrl(capture: RecentCapture): string {
  if (!capture.currentPath) return capture.assetUrl;
  const url = toAssetUrl(capture.currentPath);
  if (capture.thumbnailRevision === undefined) return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${capture.thumbnailRevision}`;
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
      ? {
          ...capture,
          currentPath: record.currentPath,
          dirty: record.dirty,
          // The save just rewrote current.png in place; bump the thumbnail's
          // cache key so the strip repaints from the new bytes rather than the
          // webview's copy of the previous render (see nextThumbnailRevision).
          thumbnailRevision: nextThumbnailRevision(capture.thumbnailRevision, record)
        }
      : capture;
}

// The base raster's file name out of a record's `basePath` — the identity an
// annotation layer is stamped with (see `StoredAnnotationLayer` in
// annotations.ts for why the name, not the path). Splits on both separators
// because Rust builds the path with `PathBuf::join`, so it arrives with the
// host's separator: `\` on Windows, `/` on macOS. Stamp and comparison both go
// through here, so the two can never disagree about where the name starts.
export function baseFileNameOf(basePath: string): string {
  const separator = Math.max(basePath.lastIndexOf("/"), basePath.lastIndexOf("\\"));
  return separator === -1 ? basePath : basePath.slice(separator + 1);
}

// The annotation layer to restore a persisted document with, and the stamp that
// was refused if its layer had to be dropped (see `annotationLayerForBase`).
// Pure — takes only the record — so the drop decision is testable without a
// store or an IPC layer.
export function restoredAnnotationLayer(record: DocumentRecord): {
  annotations: Annotation[];
  droppedFrom: string | null;
} {
  return annotationLayerForBase(
    deserializeAnnotationLayer(record.annotations),
    baseFileNameOf(record.basePath)
  );
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
  // The file name of the base raster each document currently holds inside its
  // own folder, keyed by documentId — distinct from #lastPersistedBasePath,
  // which holds the SOURCE path the raster was copied from. This is what an
  // annotation layer gets stamped with on save, so the restore path can tell
  // whether the layer and the base image on disk still belong together (see
  // serializeAnnotations). Learned from every DocumentRecord the store sees:
  // create, re-base, save, and restore all return the current base path.
  // A document whose base file we have never seen is saved un-stamped rather
  // than stamped with a guess — an un-stamped layer restores exactly as it
  // does today, a wrong stamp would throw the layer away.
  #documentBaseFile = new Map<string, string>();
  // Tail of the in-flight persist chain for each document (see #enqueuePersist),
  // keyed by documentId. An entry exists only while that document has work
  // queued or running — the chain deletes its own key once it drains — so
  // `settlePersists` can treat an empty map as "everything is on disk".
  #persistQueues = new Map<string, Promise<void>>();

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
      this.#documentBaseFile.delete(id);
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

  // Note which base raster a document holds, from any record that reports it,
  // and hand the name back for immediate use as an annotation-layer stamp.
  #rememberBaseFile(record: DocumentRecord): string {
    const baseFile = baseFileNameOf(record.basePath);
    this.#documentBaseFile.set(record.id, baseFile);
    return baseFile;
  }

  recentFromRecord(record: DocumentRecord): RecentCapture {
    // Restored from disk: `path` IS `record.basePath` (the document's own
    // base raster), so the base is trivially already in sync with it — record
    // that up front, same as create-document identity attachment does for a
    // freshly created document (#persistDocument reads this back).
    this.recordLastPersistedBasePath(record.id, record.basePath);
    this.#rememberBaseFile(record);
    return {
      mode: record.mode,
      title: record.title,
      path: record.basePath,
      width: record.width,
      height: record.height,
      assetUrl: toAssetUrl(record.basePath),
      documentId: record.id,
      currentPath: record.currentPath,
      dirty: record.dirty,
      // Seed the thumbnail cache key from the record's own write timestamp, so
      // a document restored at launch is keyed to the bytes actually on disk
      // (a stale cache entry from a previous run is keyed to an older save).
      thumbnailRevision: nextThumbnailRevision(undefined, record)
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
      this.#rememberBaseFile(result.data);
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
        // A layer stamped with a base raster the document no longer holds is
        // dropped, not applied: the crop/cut re-base committed and the matching
        // save_document did not, so these annotations were drawn on the
        // pre-crop image and would land offset by the crop origin on this one.
        // The base image survives; only the overlay is lost, and the next save
        // rewrites annotations.json against the raster that is actually there.
        const { annotations, droppedFrom } = restoredAnnotationLayer(record);
        if (droppedFrom !== null) {
          logError(
            `Discarded the annotation layer of document ${record.id}: it was saved against base raster ` +
              `${droppedFrom}, but the document now holds ${baseFileNameOf(record.basePath)}. ` +
              "The screenshot itself is intact; its annotations could not be placed and were dropped."
          );
        }
        this.seedAnnotations(record.id, annotations);
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
  //
  // Calls for the same document are serialized (#enqueuePersist); calls for
  // different documents still run concurrently, since they share no disk state.
  async persistDocument(
    capture: RecentCapture,
    annotations: Annotation[],
    options: { replaceBase?: boolean } = {}
  ): Promise<DocumentRecord | null> {
    const id = capture.documentId;
    if (!id) return null;
    return this.#enqueuePersist(id, () =>
      this.#persistDocumentNow(id, capture, annotations, options)
    );
  }

  // Run `task` only after every persist already queued for `id` has finished.
  //
  // Persists for one document overlap freely: the debounce timer, the exit
  // flush, crop/cut's `{ replaceBase: true }` write, and the persist-first rule
  // behind copy-path/reveal can all be in flight at once. Each one carries the
  // capture and annotation layer it was called with, so without ordering an
  // older call's `save_document` can land after a newer one's and leave the
  // stale layer on disk — with nothing scheduled to correct it, since the newer
  // call already considers itself done. Same shape (and same reason) as
  // `#enqueueShortcutTask` in settingsState.svelte.ts: strict call order.
  //
  // Deliberately does NOT re-read a live annotation layer at execution time. A
  // queued persist is bound to the raster it was called for — crop/cut pass the
  // transformed survivors that belong to their *new* base — so pairing one
  // call's raster with another call's layer would write a document whose
  // annotations were never drawn against its image. Correctness rests on order
  // instead: the newest call runs last, so disk ends on the newest state.
  #enqueuePersist(
    id: string,
    task: () => Promise<DocumentRecord | null>
  ): Promise<DocumentRecord | null> {
    const previous = this.#persistQueues.get(id) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.#persistQueues.set(id, tail);
    void tail.then(() => {
      // Only the current tail may clear the slot: a later enqueue has already
      // replaced it and owns the key until its own tail settles.
      if (this.#persistQueues.get(id) === tail) this.#persistQueues.delete(id);
    });
    return run;
  }

  // Resolve once every persist in flight has finished writing. The exit
  // handshake needs this and cannot get it from the debounce timer alone: that
  // timer is nulled the moment it fires, so a persist started half a second ago
  // leaves nothing behind for `flushPendingSave` to find (see the comment
  // there). Drains rather than awaiting a single snapshot of the queues, so a
  // persist enqueued while we wait is covered too; it terminates because a
  // persist never enqueues another one.
  async settlePersists(): Promise<void> {
    let pending = [...this.#persistQueues.values()];
    while (pending.length > 0) {
      await Promise.all(pending);
      const awaited = new Set(pending);
      pending = [...this.#persistQueues.values()].filter((entry) => !awaited.has(entry));
    }
  }

  async #persistDocumentNow(
    id: string,
    capture: RecentCapture,
    annotations: Annotation[],
    options: { replaceBase?: boolean }
  ): Promise<DocumentRecord | null> {
    const dirty = annotations.length > 0;
    const needsRebase = options.replaceBase || this.#lastPersistedBasePath.get(id) !== capture.path;
    // The base raster this layer is about to be written against. Read before
    // the re-base and replaced by the re-base's own record, so the stamp names
    // the raster save_document actually pairs the layer with — never the one it
    // superseded. `undefined` (a document the store has no record for) is
    // carried through as "no stamp"; see #documentBaseFile.
    let baseFile = this.#documentBaseFile.get(id) ?? null;
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
        baseFile = this.#rememberBaseFile(based.data);
      }
      const bytes = await renderFlattenedPng(capture, annotations);
      const saved = await saveDocumentIpc(
        id,
        serializeAnnotations(annotations, baseFile),
        bytes,
        dirty
      );
      if (saved.status !== "ok") {
        this.persistError = saved.error || "Could not save this screenshot's changes.";
        return null;
      }
      this.#rememberBaseFile(saved.data);
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
