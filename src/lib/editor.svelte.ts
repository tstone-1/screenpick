import { commands, type CaptureResult, type DocumentRecord } from "./bindings";
import { loadImage, toAssetUrl } from "./editorCommands";

// Pure one-line pass-throughs called directly on `commands` (see the N9 note
// in editorCommands.ts) — locally re-aliased to the `*Ipc` naming this module
// uses for every IPC call, so call sites don't need to know which of the two
// modules a given command came from. Only the crop/cut commands live here now
// — the document-record commands moved to documentStore.svelte.ts, and the
// clipboard/reveal commands moved to editorExport.ts, alongside the rest of
// their respective responsibilities (see the module-split seam comment below
// class EditorState).
const { cropCapture: cropCaptureIpc, cutoutCapture: cutoutCaptureIpc } = commands;
import {
  annotationBounds,
  annotationHitTest,
  annotationLayer,
  annotationsInVisualHitOrder,
  cropAnnotations,
  cutoutAnnotations,
  cutSeamPoints,
  nextAnnotationIdFor,
  normalizeHexColor,
  rgbToHex,
  translateAnnotation,
  type Annotation,
  type AnnotationBounds,
  type ArrowAnnotation,
  type BlurAnnotation,
  type CropRect,
  type CutSeamAnnotation,
  type EraseStroke,
  type HighlightAnnotation,
  type PenStroke,
  type Point,
  type ShapeAnnotation,
  type ShapeKind,
  type TextAnnotation
} from "./annotations";
import {
  arrowGeometry as buildArrowGeometry,
  measureTextWidth,
  strokePath as buildStrokePath,
  textStyle as buildTextStyle,
  type ArrowGeometry
} from "./annotationRendering";
import {
  DocumentStore,
  rebasedCapture,
  recentCapturePatchForRecord,
  workspaceKeyFor,
  type CaptureWorkspaceState,
  type EditorSnapshot,
  type EditorView,
  type RecentCapture
} from "./documentStore.svelte";
import {
  copyCaptureImage as copyCaptureImageOp,
  copyCapturePath as copyCapturePathOp,
  copyToClipboard as copyToClipboardOp,
  dragCaptures as dragCapturesOp,
  exportRecentCaptures as exportRecentCapturesOp,
  revealCapture as revealCaptureOp,
  saveFlattenedPng,
  slugifyCaptureTitle
} from "./editorExport";

export type { CaptureResult };
export type { RecentCapture, EditorView };
export type {
  Annotation,
  AnnotationBounds,
  ArrowAnnotation,
  BlurAnnotation,
  CropRect,
  CutSeamAnnotation,
  EraseStroke,
  HighlightAnnotation,
  PenStroke,
  Point,
  ShapeAnnotation,
  ShapeKind,
  TextAnnotation
};
export { slugifyCaptureTitle };

export type AnnotationStylePatch =
  | Partial<Pick<PenStroke, "color" | "width">>
  | Partial<Pick<ArrowAnnotation, "color" | "width">>
  | Partial<Pick<ShapeAnnotation, "color" | "width" | "fill" | "fillOpacity">>
  | Partial<Pick<TextAnnotation, "color" | "fontSize" | "background" | "backgroundOpacity">>
  | Partial<Pick<HighlightAnnotation, "color" | "opacity">>
  | Partial<Pick<BlurAnnotation, "radius">>;

type SelectionDrag = {
  id: number;
  last: Point;
  historyRecorded: boolean;
};

type EraserDrag = {
  erasedIds: Set<number>;
  historyRecorded: boolean;
};

export const RECENT_COLOR_LIMIT = 8;

// How long after the last annotation change to persist the document (annotations
// JSON + a freshly flattened current.png). Coalesces rapid edits into one write.
const DOCUMENT_SAVE_DEBOUNCE_MS = 500;

export const ERASER_RADIUS_MIN = 4;
export const ERASER_RADIUS_MAX = 48;
export const ERASER_RADIUS_DEFAULT = 16;

// Image-eraser brush diameter (the "Erase area" tool that removes screenshot
// pixels), distinct from the object eraser's hit-test radius above.
export const ERASE_AREA_WIDTH_MIN = 6;
export const ERASE_AREA_WIDTH_MAX = 120;
export const ERASE_AREA_WIDTH_DEFAULT = 28;
// Default solid color offered when the user switches the image eraser out of
// transparent mode. Black is the conventional redaction fill.
export const ERASE_AREA_COLOR_DEFAULT = "#000000";

export type SampledColor = {
  point: Point;
  color: string;
};

type SampleCanvas = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
};

export const PEN_COLORS = ["#d73535", "#f0b429", "#1c7c6d", "#2f6fed", "#222831"] as const;
export const PEN_WIDTH_MIN = 1;
export const PEN_WIDTH_MAX = 20;

// Shared misclick threshold: drags smaller than this on the relevant axis are
// discarded instead of committed to history.
const MIN_COMMITTED_ANNOTATION_PX = 4;

export const SHAPE_FILL_OPACITY_MIN = 0;
export const SHAPE_FILL_OPACITY_MAX = 1;
export const SHAPE_FILL_OPACITY_STEP = 0.05;
export const SHAPE_FILL_OPACITY_DEFAULT = 0.2;

// Single source of truth for the selectable shapes: drives the picker buttons
// (order shown), the selection-panel label, and keeps the union exhaustive.
export const SHAPE_LABELS: Record<ShapeKind, string> = {
  rectangle: "Rectangle",
  ellipse: "Ellipse",
  triangle: "Triangle",
  diamond: "Diamond"
};
export const SHAPE_KINDS = Object.keys(SHAPE_LABELS) as ShapeKind[];

export const HIGHLIGHT_OPACITY_MIN = 0.1;
export const HIGHLIGHT_OPACITY_MAX = 0.8;
export const HIGHLIGHT_OPACITY_STEP = 0.05;
export const HIGHLIGHT_OPACITY_DEFAULT = 0.35;

export const BLUR_RADIUS_MIN = 4;
export const BLUR_RADIUS_MAX = 32;
export const BLUR_RADIUS_DEFAULT = 10;

export const TEXT_FONT_SIZE_MIN = 12;
export const TEXT_FONT_SIZE_MAX = 72;
export const TEXT_BACKGROUND_OPACITY_MIN = 0.1;
export const TEXT_BACKGROUND_OPACITY_MAX = 1;
export const TEXT_BACKGROUND_OPACITY_STEP = 0.05;

export const CUT_SEAM_AMPLITUDE_DEFAULT = 6;
export const CUT_SEAM_PERIOD_DEFAULT = 16;
export const CUT_SEAM_WIDTH_DEFAULT = 2;
export const CUT_SEAM_COLOR_DEFAULT = "#ffffff";
// CUT_SEAM_CASING_COLOR / CUT_SEAM_CASING_EXTRA_WIDTH moved to annotations.ts
// (N3 in the 2026-07 code review — they were the one thing making
// annotationRendering.ts import back from this module). Import them from
// "./annotations" directly.

export type Tool =
  | "select"
  | "crop"
  | "cut"
  | "pen"
  | "arrow"
  | "shape"
  | "highlight"
  | "blur"
  | "text"
  | "erase"
  | "erase-area"
  | "color"
  | "hand";

// How far past the centered position the frame may be dragged. Keeps a comfort
// margin so the user can pull a frame edge clear of the rulers / window border
// to draw on it, without letting the frame be flung entirely out of view.
export const PAN_EDGE_OVERSCROLL = 80;

// Per-tool pointer-event lifecycle. Each tool owns its drag handlers; the
// editor exposes a `tools` registry keyed by `Tool` so call sites
// (`EditorStage.svelte`) can dispatch with a single map lookup instead of
// maintaining parallel pointerDown/Move/Up/Cancel tables that drift each
// time a tool is added.
export interface ToolHandlers {
  onPointerDown?(event: PointerEvent): void | Promise<void>;
  onPointerMove?(event: PointerEvent): void | Promise<void>;
  onPointerUp?(event: PointerEvent): void;
  onPointerCancel?(): void;
}

// --- Module split (W5 in the 2026-07 code review) ---
//
// `EditorState` used to own eight distinct responsibilities in one ~2450-line
// class. Two of them are now separate modules that `EditorState` composes:
//
//   - documentStore.svelte.ts: the recents strip, workspace caching, seeded
//     (restored-from-disk) annotations, retention/eviction, and the actual
//     document-record I/O (create/persist/load/delete).
//   - editorExport.ts: export/clipboard/reveal/drag-out — plain functions,
//     no state of their own, taking the capture/annotations they need as
//     parameters.
//
// Per-tool gesture code (crop, cut, pen, arrow, shape, ...) is explicitly OUT
// of scope for this pass and stays below, unchanged.
//
// THE SEAM: `document`, `currentCapture`, `annotations`, `cropRect`,
// `historyPast`/`historyFuture`, and the undo/redo snapshot contract
// (#snapshot/#restore/#recordHistory/undo/redo) all stay right here on
// EditorState, rather than moving into DocumentStore. Every per-tool gesture
// method reads and writes these directly (`this.annotations = [...]`, `this.
// cropRect`, ...), and per-tool gesture modules are out of scope this pass —
// moving this state out from under them would mean rewriting nearly every
// gesture method just to reach through an extra layer. DocumentStore instead
// receives the values it needs to persist/cache as plain parameters (see
// #persistCurrentDocument, #pushRecent, openCapture, ... below) and hands
// back plain values (a DocumentRecord, a cached CaptureWorkspaceState) for
// EditorState to fold back onto its own fields. `recentCaptures` and
// `persistError` DO live on DocumentStore (nothing here mutates document
// identity/persistence-status data directly), so EditorState exposes them via
// thin delegating getters below — preserving `editor.recentCaptures` /
// `editor.persistError` as before for every consumer.
export class EditorState {
  document = $state<EditorView | null>(null);
  currentCapture = $state<RecentCapture | null>(null);
  activeTool = $state<Tool>("select");
  cropRect = $state<CropRect | null>(null);
  cropDraft = $state<CropRect | null>(null);
  cropDragStart = $state<{ x: number; y: number } | null>(null);
  cropPending = $state(false);
  cutAxis = $state<"horizontal" | "vertical">("horizontal");
  cutBand = $state<CropRect | null>(null);
  cutDraft = $state<CropRect | null>(null);
  cutDragStart = $state<Point | null>(null);
  cutPending = $state(false);
  exportPending = $state(false);
  copyPending = $state(false);
  annotations = $state<Annotation[]>([]);
  penDraft = $state<PenStroke | null>(null);
  arrowDraft = $state<ArrowAnnotation | null>(null);
  shapeDraft = $state<ShapeAnnotation | null>(null);
  shapeKind = $state<ShapeKind>("rectangle");
  shapeDragStart = $state<Point | null>(null);
  shapeFill = $state(false);
  shapeFillOpacity = $state(SHAPE_FILL_OPACITY_DEFAULT);
  highlightDraft = $state<HighlightAnnotation | null>(null);
  highlightOpacity = $state(HIGHLIGHT_OPACITY_DEFAULT);
  highlightDragStart = $state<Point | null>(null);
  blurDraft = $state<BlurAnnotation | null>(null);
  blurRadius = $state(BLUR_RADIUS_DEFAULT);
  blurDragStart = $state<Point | null>(null);
  textDraft = $state<TextAnnotation | null>(null);
  textFontSize = $state(24);
  textBackground = $state(true);
  textBackgroundOpacity = $state(0.72);
  selectedAnnotationId = $state<number | null>(null);
  selectionDrag = $state<SelectionDrag | null>(null);
  eraserRadius = $state(ERASER_RADIUS_DEFAULT);
  eraserPointer = $state<Point | null>(null);
  eraserDrag = $state<EraserDrag | null>(null);
  // Image eraser ("Erase area"): a brush that removes screenshot pixels.
  // `eraseAreaTransparent` toggles between punching a transparent hole (default)
  // and painting `eraseAreaColor`. The in-flight stroke is `eraseAreaDraft`;
  // `eraseAreaPointer` drives the brush-size cursor preview.
  eraseAreaWidth = $state(ERASE_AREA_WIDTH_DEFAULT);
  eraseAreaTransparent = $state(true);
  eraseAreaColor = $state<string>(ERASE_AREA_COLOR_DEFAULT);
  eraseAreaDraft = $state<EraseStroke | null>(null);
  eraseAreaPointer = $state<Point | null>(null);
  penColor = $state<string>(PEN_COLORS[0]);
  penWidth = $state(4);
  colorSample = $state<SampledColor | null>(null);
  recentColors = $state<string[]>([]);
  historyPast = $state<EditorSnapshot[]>([]);
  historyFuture = $state<EditorSnapshot[]>([]);
  canUndo = $derived(this.historyPast.length > 0);
  canRedo = $derived(this.historyFuture.length > 0);
  selectedAnnotation = $derived(
    this.annotations.find((annotation) => annotation.id === this.selectedAnnotationId) ?? null
  );
  selectedAnnotationBounds = $derived(
    this.selectedAnnotation ? annotationBounds(this.selectedAnnotation) : null
  );
  selectionCanBringForward = $derived.by(() => this.#selectionLayerIndex().forward);
  selectionCanSendBackward = $derived.by(() => this.#selectionLayerIndex().backward);
  canvasStage = $state<HTMLDivElement | null>(null);
  imageFrame = $state<HTMLDivElement | null>(null);
  // True while a pan drag is in flight; drives the grab/grabbing cursor.
  panning = $state(false);

  // The document/session store — recents, workspace cache, seeded
  // annotations, retention, and persistence I/O. See the seam comment above.
  #documentStore = new DocumentStore();

  get recentCaptures(): RecentCapture[] {
    return this.#documentStore.recentCaptures;
  }

  // User-visible signal that the most recent document-persistence attempt
  // (create, autosave, or crop/cut re-base) failed — sanitized message; full
  // detail always goes to console.error alongside it. Rendered as a status-bar
  // badge (+page.svelte) next to captureActivity, which plays the same role
  // for capture-side failures. Cleared on the next successful persist. Lives
  // on DocumentStore (every write that can set it happens there); this getter
  // preserves `editor.persistError` for existing consumers.
  get persistError(): string | null {
    return this.#documentStore.persistError;
  }

  #panLast: { x: number; y: number } | null = null;
  #panPointerId: number | null = null;
  #resizeObserver: ResizeObserver | null = null;
  #toolHandlers: Record<Tool, ToolHandlers> | null = null;
  #nextAnnotationId = 1;
  #sampleCanvas: HTMLCanvasElement | null = null;
  #sampleContext: CanvasRenderingContext2D | null = null;
  #sampleCanvasCapturePath: string | null = null;
  #sampleRequestId = 0;
  #selectionEditDirty = false;
  // Debounce handle for persisting the current document's annotations + render.
  // Stays here (not on DocumentStore) because scheduling needs to re-read the
  // LIVE `this.document`/`this.annotations` at fire time, not a value snapshot
  // taken when the timer was armed — see #scheduleDocumentSave.
  #saveTimer: ReturnType<typeof setTimeout> | null = null;

  setupResize() {
    if (typeof ResizeObserver === "undefined") return;
    this.#resizeObserver = new ResizeObserver(() => this.refreshFitZoom());
    if (this.canvasStage) this.#resizeObserver.observe(this.canvasStage);
  }

  teardownResize() {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
  }

  openCapture(capture: RecentCapture) {
    this.#saveCurrentWorkspace();
    const saved = this.#documentStore.getWorkspace(capture);
    if (saved) {
      this.#restoreWorkspace(saved);
      return;
    }
    this.historyPast = [];
    this.historyFuture = [];
    this.#nextAnnotationId = 1;
    this.#installCapture(capture);
    // First open of a persisted document restored from disk: seed its saved
    // annotation layer (history starts fresh — undo stacks are session-only).
    const seeded = capture.documentId
      ? this.#documentStore.takeSeededAnnotations(capture.documentId)
      : undefined;
    if (seeded) {
      this.annotations = seeded;
      this.#nextAnnotationId = nextAnnotationIdFor(seeded);
    }
  }

  // Null every mid-gesture / transient field. Shared by #installCapture (new
  // capture) and #restore (undo/redo) so the two can't drift as tools are added
  // — a new tool's draft field only needs adding here, in one place.
  //
  // This is the TRANSIENT half; #snapshot is the COMMITTED half, and the two
  // deliberately enumerate different fields. Committed tool output lives in
  // `annotations` (which #snapshot persists), so a new tool needs a #snapshot
  // entry ONLY if it commits state outside `annotations` — otherwise adding it
  // here is enough.
  #resetTransientState() {
    this.cropDraft = null;
    this.cropDragStart = null;
    this.cutBand = null;
    this.cutDraft = null;
    this.cutDragStart = null;
    this.penDraft = null;
    this.arrowDraft = null;
    this.shapeDraft = null;
    this.shapeDragStart = null;
    this.highlightDraft = null;
    this.highlightDragStart = null;
    this.blurDraft = null;
    this.blurDragStart = null;
    this.textDraft = null;
    this.selectedAnnotationId = null;
    this.selectionDrag = null;
    this.eraserPointer = null;
    this.eraserDrag = null;
    this.eraseAreaDraft = null;
    this.eraseAreaPointer = null;
    this.colorSample = null;
    this.#selectionEditDirty = false;
  }

  #installCapture(capture: RecentCapture) {
    this.currentCapture = capture;
    this.cropRect = null;
    this.cutBand = null;
    this.annotations = [];
    this.#resetTransientState();
    // New capture path: the cached sample canvas belongs to the old image.
    this.#sampleCanvas = null;
    this.#sampleContext = null;
    this.#sampleCanvasCapturePath = null;
    this.#sampleRequestId += 1;
    const fitZoom = this.#fitZoomFor(capture);
    this.document = {
      capture,
      zoom: fitZoom,
      fitZoom,
      mode: "fit",
      panX: 0,
      panY: 0
    };
  }

  ingestCompleted(payload: CaptureResult): RecentCapture {
    const capture = { ...payload, assetUrl: toAssetUrl(payload.path) };
    this.#saveCurrentWorkspace();
    this.openCapture(capture);
    this.#pushRecent(capture);
    void this.#createDocumentFor(capture);
    return capture;
  }

  ingestWithoutOpening(payload: CaptureResult): RecentCapture {
    const capture = { ...payload, assetUrl: toAssetUrl(payload.path) };
    this.#pushRecent(capture);
    void this.#createDocumentFor(capture);
    return capture;
  }

  // Create the persistent document backing a freshly captured image. Runs in the
  // background so capture stays instant: the capture is shown immediately as an
  // in-memory entry, then "upgraded" with its document identity once the store
  // write resolves (DocumentStore.createDocumentFor). A failure leaves the
  // capture usable but unpersisted (DocumentStore already recorded persistError).
  async #createDocumentFor(capture: RecentCapture): Promise<void> {
    const record = await this.#documentStore.createDocumentFor(capture);
    if (record) this.#attachDocumentIdentity(capture, record);
  }

  // Fold a newly-created document's identity onto the in-memory capture across
  // every place it is referenced (recents, the open document, current), and
  // migrate its session workspace from the path key to the document-id key so
  // subsequent saves/lookups line up. If annotations were drawn during the
  // create window, persist them now.
  #attachDocumentIdentity(original: RecentCapture, record: DocumentRecord) {
    // Match by object identity, not path: a crop/cut landing inside this
    // async create round-trip installs a brand-new capture object at a new
    // path (#installCapture), while `original` still points at the exact
    // object this document was created for. Path equality could otherwise
    // re-match a stale recentCaptures entry the user has already moved past —
    // silently upgrading a "ghost" entry nothing displays with a documentId,
    // rather than the capture actually on screen.
    const matches = (capture: RecentCapture) => capture === original;
    const upgrade = (capture: RecentCapture): RecentCapture => ({
      ...capture,
      documentId: record.id,
      currentPath: record.currentPath,
      dirty: record.dirty
    });

    this.#documentStore.upgradeRecentCapture(matches, upgrade);
    if (this.document && matches(this.document.capture)) {
      this.document = { ...this.document, capture: upgrade(this.document.capture) };
    }
    if (this.currentCapture && matches(this.currentCapture)) {
      this.currentCapture = upgrade(this.currentCapture);
    }

    this.#documentStore.migrateWorkspaceKey(original, record.id);

    // create_document copied `original.path` into base.png — the document's
    // base is already in sync with it, so record that as the last-persisted
    // base rather than leaving it untracked (which would force a redundant
    // re-base on the very first save).
    this.#documentStore.recordLastPersistedBasePath(record.id, original.path);

    // Capture the user may have annotated before the document existed.
    if (this.document?.capture.documentId === record.id && this.annotations.length > 0) {
      this.#scheduleDocumentSave();
    }
  }

  // Populate the strip from persisted documents at startup. The editor opens
  // empty; clicking a tab opens that document with its saved annotations (their
  // layers are seeded here, applied on first open). Delegates entirely to
  // DocumentStore.loadPersistedDocuments — this class only supplies the live
  // `document`/`currentCapture` retention needs (typically both null at
  // startup, but forwarded live for correctness regardless).
  async loadPersistedDocuments(): Promise<void> {
    await this.#documentStore.loadPersistedDocuments(
      this.document?.capture ?? null,
      this.currentCapture
    );
  }

  // Queue a debounced persist of the current document. No-op when the current
  // capture isn't a persisted document (in-memory/test captures), so the editor's
  // core stays free of IPC in those paths.
  #scheduleDocumentSave() {
    if (!this.document?.capture.documentId) return;
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      void this.#persistCurrentDocument();
    }, DOCUMENT_SAVE_DEBOUNCE_MS);
  }

  // Persist any pending debounced save immediately. Called before switching away
  // from a document so a reschedule for the next document can't cancel the
  // outgoing one's write (run while `this.document` still points at the outgoing
  // document, inside `#saveCurrentWorkspace`).
  #flushDocumentSave() {
    if (!this.#saveTimer) return;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    void this.#persistCurrentDocument();
  }

  // Write the current document's annotation layer + a freshly flattened
  // current.png to the store (DocumentStore.persistDocument does the actual
  // IPC/recents-patch work — see the rebase-tracking rationale there), and
  // reflect the returned dirty/currentPath back onto `document`/`currentCapture`
  // — the two fields DocumentStore can't reach itself (see the seam comment
  // above class EditorState).
  async #persistCurrentDocument(replaceBase = false): Promise<DocumentRecord | null> {
    const capture = this.document?.capture;
    if (!capture?.documentId) return null;
    const saved = await this.#documentStore.persistDocument(capture, this.annotations, replaceBase);
    if (saved) {
      const patch = recentCapturePatchForRecord(saved);
      // Deliberately does NOT patch title/width/height from `saved` — the
      // live in-memory capture (already updated by #installCapture at
      // crop/cut time, or restored by undo/redo's #restore) is the source of
      // truth for the working raster's dimensions. `saved`'s title/width/
      // height were themselves derived from the live capture at the moment
      // persistDocument called replaceDocumentBase above, so on the happy
      // path they already agree; overwriting from `saved` only matters on a
      // race where a further crop/undo landed between that call and this one
      // resolving — and in that race the in-memory value is the newer,
      // correct one, not `saved`'s. (recentCapturePatchForRecord enforces
      // this by construction: it only ever touches currentPath/dirty.)
      if (this.document && this.document.capture.documentId === saved.id) {
        this.document = { ...this.document, capture: patch(this.document.capture) };
      }
      if (this.currentCapture?.documentId === saved.id) {
        this.currentCapture = patch(this.currentCapture);
      }
    }
    return saved;
  }

  setEditorZoom(zoom: number) {
    if (!this.document) return;
    this.cropDraft = null;
    this.cropDragStart = null;
    const rounded = this.#roundZoom(zoom);
    // Changing zoom changes the frame size, so the existing pan may now exceed
    // its allowed range — re-clamp against the new dimensions.
    const pan = this.#clampPan(this.document.panX, this.document.panY, rounded);
    this.document = {
      ...this.document,
      zoom: rounded,
      panX: pan.x,
      panY: pan.y,
      mode: "custom"
    };
  }

  setFitZoom() {
    if (!this.document) return;
    const fitZoom = this.#fitZoomFor(this.document.capture);
    this.document = {
      ...this.document,
      fitZoom,
      zoom: fitZoom,
      mode: "fit",
      panX: 0,
      panY: 0
    };
  }

  // Translate the preview by a screen-space delta, clamped so the frame can't
  // be dragged fully out of view. View-only — deliberately not recorded in
  // undo history.
  panBy(dx: number, dy: number) {
    if (!this.document) return;
    const pan = this.#clampPan(this.document.panX + dx, this.document.panY + dy, this.document.zoom);
    this.document = { ...this.document, panX: pan.x, panY: pan.y };
  }

  startPan(event: PointerEvent) {
    if (!this.document) return;
    this.#panLast = { x: event.clientX, y: event.clientY };
    this.#panPointerId = event.pointerId;
    this.panning = true;
    this.imageFrame?.setPointerCapture?.(event.pointerId);
  }

  updatePan(event: PointerEvent) {
    if (this.#panLast === null || !this.document) return;
    const dx = event.clientX - this.#panLast.x;
    const dy = event.clientY - this.#panLast.y;
    this.#panLast = { x: event.clientX, y: event.clientY };
    this.panBy(dx, dy);
  }

  finishPan() {
    if (this.#panPointerId !== null && this.imageFrame?.hasPointerCapture?.(this.#panPointerId)) {
      this.imageFrame.releasePointerCapture(this.#panPointerId);
    }
    this.#panLast = null;
    this.#panPointerId = null;
    this.panning = false;
  }

  undo() {
    const previous = this.historyPast.at(-1);
    if (!previous) return;
    this.historyPast = this.historyPast.slice(0, -1);
    this.historyFuture = [this.#snapshot(), ...this.historyFuture].slice(0, 50);
    this.#restore(previous);
    this.#scheduleDocumentSave();
  }

  redo() {
    const next = this.historyFuture[0];
    if (!next) return;
    this.historyFuture = this.historyFuture.slice(1);
    this.historyPast = [...this.historyPast, this.#snapshot()].slice(-50);
    this.#restore(next);
    this.#scheduleDocumentSave();
  }

  refreshFitZoom() {
    if (!this.document) return;
    const fitZoom = this.#fitZoomFor(this.document.capture);
    const zoom = this.document.mode === "fit" ? fitZoom : this.document.zoom;
    // The stage was resized, so the centered position (and thus the pan clamp)
    // shifted. Fit mode stays centered; custom mode re-clamps its pan.
    const pan =
      this.document.mode === "fit"
        ? { x: 0, y: 0 }
        : this.#clampPan(this.document.panX, this.document.panY, zoom);
    this.document = {
      ...this.document,
      fitZoom,
      zoom,
      panX: pan.x,
      panY: pan.y
    };
  }

  async exportCapture(): Promise<string | null> {
    if (!this.document || this.exportPending) return null;
    const capture = this.document.capture;
    const annotations = [...this.annotations];
    this.exportPending = true;
    try {
      return await saveFlattenedPng(capture, annotations);
    } finally {
      this.exportPending = false;
    }
  }

  // Save a recent capture to a user-chosen PNG, flattening its annotations over
  // the base so "Save image as..." matches what the user sees (consistent with
  // copy-path). Annotations come from the live layer if it's the open document,
  // else its session workspace or restored layer. Returns an error, or null.
  async exportRecentCapture(capture: RecentCapture): Promise<string | null> {
    return saveFlattenedPng(capture, this.#annotationsForCapture(capture));
  }

  // Batch "Save images as...": save several recent captures into a single
  // user-chosen folder in one go (used by the Recent list's multi-selection
  // context menu). See editorExport.ts's exportRecentCaptures for the naming/
  // de-dup/error-summary behavior; this just supplies the live annotation
  // lookup.
  async exportRecentCaptures(captures: RecentCapture[]): Promise<string | null> {
    return exportRecentCapturesOp(captures, (capture) => this.#annotationsForCapture(capture));
  }

  // Best-known annotation layer for a capture: the live layer when it's the open
  // document, otherwise its cached session workspace or its restored-from-disk
  // seeded layer (empty if none is known). Lets export/flatten act on any strip
  // entry, not just the open one.
  #annotationsForCapture(capture: RecentCapture): Annotation[] {
    return this.#documentStore.annotationsForCapture(capture, this.document, this.annotations);
  }

  // Whether `capture` is the currently open document — the shared condition
  // behind reveal/copy-path/copy-image's "persist first" rule (see
  // editorExport.ts's currentArtifactPath).
  #isOpenDocument(capture: RecentCapture): boolean {
    return capture.documentId != null && capture.documentId === this.document?.capture.documentId;
  }

  // Reveal the capture's flattened current.png (the annotated artifact copy-path
  // hands out) in the OS file manager. Persists first when it's the open document
  // so the on-disk file is current. Falls back to the base for an unpersisted
  // capture. Returns an error message on failure, or null on success.
  async revealCapture(capture: RecentCapture): Promise<string | null> {
    return revealCaptureOp(capture, this.#isOpenDocument(capture), () => this.#persistCurrentDocument());
  }

  // Copy the path to the capture's flattened image (the document's current.png,
  // which bakes in the annotations) so the pasted path matches what the user
  // sees. If this is the open document, persist any pending edits first so the
  // file on disk is current at copy time. Falls back to the base path for an
  // in-memory capture with no document yet. Returns an error message, or null.
  async copyCapturePath(capture: RecentCapture): Promise<string | null> {
    return copyCapturePathOp(capture, this.#isOpenDocument(capture), () => this.#persistCurrentDocument());
  }

  // Copy a Recent capture's flattened image (current.png — annotations baked in)
  // to the OS clipboard, matching what copy-path / export hand out. Persists
  // first when it's the open document so the bytes are current; falls back to the
  // base image for an unpersisted capture. Returns an error message, or null.
  async copyCaptureImage(capture: RecentCapture): Promise<string | null> {
    return copyCaptureImageOp(capture, this.#isOpenDocument(capture), () => this.#persistCurrentDocument());
  }

  // Start a native OS drag of one or more Recent captures so they can be
  // dropped into other apps as real image files. See editorExport.ts.
  dragCaptures(captures: RecentCapture[]): void {
    dragCapturesOp(captures);
  }

  // Copy the flattened capture (crop + annotations, exactly as shown) to the
  // OS clipboard. Returns an error message on failure, or null on success.
  async copyToClipboard(): Promise<string | null> {
    if (!this.document || this.copyPending) return null;
    const capture = this.document.capture;
    const annotations = [...this.annotations];
    this.copyPending = true;
    try {
      return await copyToClipboardOp(capture, annotations);
    } finally {
      this.copyPending = false;
    }
  }

  startCropDrag(event: PointerEvent) {
    if (!this.document || this.activeTool !== "crop") return;
    if (event.button !== 0) return;
    const start = this.#pointInImage(event);
    if (!start) return;
    event.preventDefault();
    this.imageFrame?.setPointerCapture(event.pointerId);
    this.cropDragStart = start;
    this.cropDraft = { x: start.x, y: start.y, width: 0, height: 0 };
    this.cropRect = null;
  }

  updateCropDrag(event: PointerEvent) {
    if (!this.cropDragStart || this.activeTool !== "crop") return;
    const point = this.#pointInImage(event);
    if (!point) return;
    this.cropDraft = this.#rectFromPoints(this.cropDragStart, point);
  }

  finishCropDrag(event: PointerEvent) {
    if (!this.cropDragStart || this.activeTool !== "crop") return;
    const start = this.cropDragStart;
    const point = this.#pointInImage(event);
    this.imageFrame?.releasePointerCapture(event.pointerId);
    this.cropDragStart = null;
    if (!point) {
      this.cropDraft = null;
      return;
    }
    const rect = this.#rectFromPoints(start, point);
    this.cropRect = rect.width >= 2 && rect.height >= 2 ? rect : null;
    this.cropDraft = null;
  }

  cancelCrop() {
    this.cropRect = null;
    this.cropDraft = null;
    this.cropDragStart = null;
  }

  startCutDrag(event: PointerEvent) {
    if (!this.document || this.activeTool !== "cut") return;
    if (event.button !== 0) return;
    const start = this.#pointInImage(event);
    if (!start) return;
    event.preventDefault();
    this.imageFrame?.setPointerCapture(event.pointerId);
    this.cutDragStart = start;
    this.cutDraft = this.#cutBandFromPoints(start, start);
    this.cutBand = null;
  }

  updateCutDrag(event: PointerEvent) {
    if (!this.cutDragStart || this.activeTool !== "cut") return;
    const point = this.#pointInImage(event);
    if (!point) return;
    this.cutDraft = this.#cutBandFromPoints(this.cutDragStart, point);
  }

  finishCutDrag(event: PointerEvent) {
    if (!this.cutDragStart || this.activeTool !== "cut") return;
    const start = this.cutDragStart;
    const point = this.#pointInImage(event);
    this.imageFrame?.releasePointerCapture(event.pointerId);
    this.cutDragStart = null;
    if (!point) {
      this.cutDraft = null;
      return;
    }
    const band = this.#cutBandFromPoints(start, point);
    const thickness = this.cutAxis === "horizontal" ? band.height : band.width;
    this.cutBand = thickness >= 2 ? band : null;
    this.cutDraft = null;
  }

  cancelCut() {
    this.cutBand = null;
    this.cutDraft = null;
    this.cutDragStart = null;
  }

  // Cancel whatever mid-gesture state the editor is currently holding and
  // return whether anything was actually cancelled. Lets the route's global
  // keydown handler ask "did the editor have a draft to drop?" without
  // reaching into nine internal `$state` fields by name.
  cancelActiveGesture(): boolean {
    if (
      this.activeTool === "crop" &&
      (this.cropRect || this.cropDraft || this.cropDragStart)
    ) {
      this.cancelCrop();
      return true;
    }
    if (
      this.activeTool === "cut" &&
      (this.cutBand || this.cutDraft || this.cutDragStart)
    ) {
      this.cancelCut();
      return true;
    }
    if (this.penDraft) {
      this.cancelPenStroke();
      return true;
    }
    if (this.arrowDraft) {
      this.cancelArrowDrag();
      return true;
    }
    if (this.shapeDraft) {
      this.cancelShapeDrag();
      return true;
    }
    if (this.highlightDraft) {
      this.cancelHighlightDrag();
      return true;
    }
    if (this.blurDraft) {
      this.cancelBlurDrag();
      return true;
    }
    if (this.eraserDrag) {
      this.cancelErase();
      return true;
    }
    if (this.eraseAreaDraft) {
      this.cancelEraseArea();
      return true;
    }
    if (this.textDraft) {
      this.cancelTextDraft();
      return true;
    }
    if (this.activeTool === "color" && this.colorSample) {
      this.clearColorSample();
      return true;
    }
    if (this.activeTool === "select" && this.selectedAnnotationId !== null) {
      this.clearSelection();
      return true;
    }
    return false;
  }

  // Pointer-event handlers per tool, keyed by tool id. Lets EditorStage
  // route most pointer events with a single map lookup. Text and color have
  // pointer-down behavior owned by EditorStage because they need caller-side
  // focus and activity-message routing.
  get tools(): Record<Tool, ToolHandlers> {
    // Built once and cached: the handlers close over `this` (stable), so there
    // is no need to reallocate the 10-entry table on every pointer event.
    this.#toolHandlers ??= this.#buildToolHandlers();
    return this.#toolHandlers;
  }

  #buildToolHandlers(): Record<Tool, ToolHandlers> {
    return {
      select: {
        onPointerDown: (e) => this.startSelectionDrag(e),
        onPointerMove: (e) => this.updateSelectionDrag(e),
        onPointerUp: (e) => this.finishSelectionDrag(e),
        onPointerCancel: () => this.cancelSelectionDrag()
      },
      crop: {
        onPointerDown: (e) => this.startCropDrag(e),
        onPointerMove: (e) => this.updateCropDrag(e),
        onPointerUp: (e) => this.finishCropDrag(e),
        onPointerCancel: () => this.cancelCrop()
      },
      cut: {
        onPointerDown: (e) => this.startCutDrag(e),
        onPointerMove: (e) => this.updateCutDrag(e),
        onPointerUp: (e) => this.finishCutDrag(e),
        onPointerCancel: () => this.cancelCut()
      },
      pen: {
        onPointerDown: (e) => this.startPenStroke(e),
        onPointerMove: (e) => this.updatePenStroke(e),
        onPointerUp: (e) => this.finishPenStroke(e),
        onPointerCancel: () => this.cancelPenStroke()
      },
      arrow: {
        onPointerDown: (e) => this.startArrowDrag(e),
        onPointerMove: (e) => this.updateArrowDrag(e),
        onPointerUp: (e) => this.finishArrowDrag(e),
        onPointerCancel: () => this.cancelArrowDrag()
      },
      shape: {
        onPointerDown: (e) => this.startShapeDrag(e),
        onPointerMove: (e) => this.updateShapeDrag(e),
        onPointerUp: (e) => this.finishShapeDrag(e),
        onPointerCancel: () => this.cancelShapeDrag()
      },
      highlight: {
        onPointerDown: (e) => this.startHighlightDrag(e),
        onPointerMove: (e) => this.updateHighlightDrag(e),
        onPointerUp: (e) => this.finishHighlightDrag(e),
        onPointerCancel: () => this.cancelHighlightDrag()
      },
      blur: {
        onPointerDown: (e) => this.startBlurDrag(e),
        onPointerMove: (e) => this.updateBlurDrag(e),
        onPointerUp: (e) => this.finishBlurDrag(e),
        onPointerCancel: () => this.cancelBlurDrag()
      },
      erase: {
        onPointerDown: (e) => this.startErase(e),
        onPointerMove: (e) => this.updateErase(e),
        onPointerUp: (e) => this.finishErase(e),
        onPointerCancel: () => this.cancelErase()
      },
      "erase-area": {
        onPointerDown: (e) => this.startEraseArea(e),
        onPointerMove: (e) => this.updateEraseArea(e),
        onPointerUp: (e) => this.finishEraseArea(e),
        onPointerCancel: () => this.cancelEraseArea()
      },
      text: {
        onPointerCancel: () => this.cancelTextDraft()
      },
      color: {
        onPointerMove: (e) => this.previewColorSample(e),
        onPointerCancel: () => this.clearColorSample()
      },
      hand: {
        onPointerDown: (e) => {
          if (e.button === 0) this.startPan(e);
        },
        onPointerMove: (e) => this.updatePan(e),
        onPointerUp: () => this.finishPan(),
        onPointerCancel: () => this.finishPan()
      }
    };
  }

  startPenStroke(event: PointerEvent) {
    if (!this.document || this.activeTool !== "pen") return;
    if (event.button !== 0) return;
    const start = this.#pointInImage(event);
    if (!start) return;
    event.preventDefault();
    this.imageFrame?.setPointerCapture(event.pointerId);
    this.penDraft = {
      kind: "pen",
      id: this.#nextAnnotationId++,
      points: [start],
      color: this.penColor,
      width: this.penWidth
    };
  }

  updatePenStroke(event: PointerEvent) {
    if (!this.penDraft || this.activeTool !== "pen") return;
    const point = this.#pointInImage(event);
    if (!point) return;
    const last = this.penDraft.points.at(-1);
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < 1) return;
    this.penDraft = {
      ...this.penDraft,
      points: [...this.penDraft.points, point]
    };
  }

  finishPenStroke(event: PointerEvent) {
    if (!this.penDraft || this.activeTool !== "pen") return;
    this.imageFrame?.releasePointerCapture(event.pointerId);
    const stroke = this.penDraft;
    this.penDraft = null;
    if (stroke.points.length < 2) return;
    this.#recordHistory();
    this.annotations = [...this.annotations, stroke];
  }

  cancelPenStroke() {
    this.penDraft = null;
  }

  startArrowDrag(event: PointerEvent) {
    if (!this.document || this.activeTool !== "arrow") return;
    if (event.button !== 0) return;
    const start = this.#pointInImage(event);
    if (!start) return;
    event.preventDefault();
    this.imageFrame?.setPointerCapture(event.pointerId);
    this.arrowDraft = {
      kind: "arrow",
      id: this.#nextAnnotationId++,
      start,
      end: start,
      color: this.penColor,
      width: this.penWidth
    };
  }

  updateArrowDrag(event: PointerEvent) {
    if (!this.arrowDraft || this.activeTool !== "arrow") return;
    const end = this.#pointInImage(event);
    if (!end) return;
    this.arrowDraft = { ...this.arrowDraft, end };
  }

  finishArrowDrag(event: PointerEvent) {
    if (!this.arrowDraft || this.activeTool !== "arrow") return;
    this.imageFrame?.releasePointerCapture(event.pointerId);
    const arrow = this.arrowDraft;
    this.arrowDraft = null;
    if (
      Math.hypot(arrow.end.x - arrow.start.x, arrow.end.y - arrow.start.y) <
      MIN_COMMITTED_ANNOTATION_PX
    )
      return;
    this.#recordHistory();
    this.annotations = [...this.annotations, arrow];
    this.#selectPlacedAnnotation(arrow.id);
  }

  cancelArrowDrag() {
    this.arrowDraft = null;
  }

  startShapeDrag(event: PointerEvent) {
    if (!this.document || this.activeTool !== "shape") return;
    if (event.button !== 0) return;
    const start = this.#pointInImage(event);
    if (!start) return;
    event.preventDefault();
    this.imageFrame?.setPointerCapture(event.pointerId);
    this.shapeDragStart = start;
    this.shapeDraft = {
      kind: "shape",
      id: this.#nextAnnotationId++,
      shape: this.shapeKind,
      rect: { x: start.x, y: start.y, width: 0, height: 0 },
      color: this.penColor,
      width: this.penWidth,
      fill: this.shapeFill,
      fillOpacity: this.shapeFillOpacity
    };
  }

  updateShapeDrag(event: PointerEvent) {
    if (!this.shapeDraft || !this.shapeDragStart || this.activeTool !== "shape") return;
    const point = this.#pointInImage(event);
    if (!point) return;
    this.shapeDraft = {
      ...this.shapeDraft,
      rect: this.#rectFromPoints(this.shapeDragStart, point)
    };
  }

  finishShapeDrag(event: PointerEvent) {
    if (!this.shapeDraft || this.activeTool !== "shape") return;
    this.imageFrame?.releasePointerCapture(event.pointerId);
    const shape = this.shapeDraft;
    this.shapeDraft = null;
    this.shapeDragStart = null;
    if (
      shape.rect.width < MIN_COMMITTED_ANNOTATION_PX ||
      shape.rect.height < MIN_COMMITTED_ANNOTATION_PX
    )
      return;
    this.#recordHistory();
    this.annotations = [...this.annotations, shape];
    this.#selectPlacedAnnotation(shape.id);
  }

  cancelShapeDrag() {
    this.shapeDraft = null;
    this.shapeDragStart = null;
  }

  startHighlightDrag(event: PointerEvent) {
    if (!this.document || this.activeTool !== "highlight") return;
    if (event.button !== 0) return;
    const start = this.#pointInImage(event);
    if (!start) return;
    event.preventDefault();
    this.imageFrame?.setPointerCapture(event.pointerId);
    this.highlightDragStart = start;
    this.highlightDraft = {
      kind: "highlight",
      id: this.#nextAnnotationId++,
      rect: { x: start.x, y: start.y, width: 0, height: 0 },
      color: this.penColor,
      opacity: this.highlightOpacity
    };
  }

  updateHighlightDrag(event: PointerEvent) {
    if (!this.highlightDraft || !this.highlightDragStart || this.activeTool !== "highlight") return;
    const point = this.#pointInImage(event);
    if (!point) return;
    this.highlightDraft = {
      ...this.highlightDraft,
      rect: this.#rectFromPoints(this.highlightDragStart, point)
    };
  }

  finishHighlightDrag(event: PointerEvent) {
    if (!this.highlightDraft || this.activeTool !== "highlight") return;
    this.imageFrame?.releasePointerCapture(event.pointerId);
    const highlight = this.highlightDraft;
    this.highlightDraft = null;
    this.highlightDragStart = null;
    if (
      highlight.rect.width < MIN_COMMITTED_ANNOTATION_PX ||
      highlight.rect.height < MIN_COMMITTED_ANNOTATION_PX
    )
      return;
    this.#recordHistory();
    this.annotations = [...this.annotations, highlight];
  }

  cancelHighlightDrag() {
    this.highlightDraft = null;
    this.highlightDragStart = null;
  }

  startBlurDrag(event: PointerEvent) {
    if (!this.document || this.activeTool !== "blur") return;
    if (event.button !== 0) return;
    const start = this.#pointInImage(event);
    if (!start) return;
    event.preventDefault();
    this.imageFrame?.setPointerCapture(event.pointerId);
    this.blurDragStart = start;
    this.blurDraft = {
      kind: "blur",
      id: this.#nextAnnotationId++,
      rect: { x: start.x, y: start.y, width: 0, height: 0 },
      radius: this.blurRadius
    };
  }

  updateBlurDrag(event: PointerEvent) {
    if (!this.blurDraft || !this.blurDragStart || this.activeTool !== "blur") return;
    const point = this.#pointInImage(event);
    if (!point) return;
    this.blurDraft = {
      ...this.blurDraft,
      rect: this.#rectFromPoints(this.blurDragStart, point)
    };
  }

  finishBlurDrag(event: PointerEvent) {
    if (!this.blurDraft || this.activeTool !== "blur") return;
    this.imageFrame?.releasePointerCapture(event.pointerId);
    const blur = this.blurDraft;
    this.blurDraft = null;
    this.blurDragStart = null;
    if (
      blur.rect.width < MIN_COMMITTED_ANNOTATION_PX ||
      blur.rect.height < MIN_COMMITTED_ANNOTATION_PX
    )
      return;
    this.#recordHistory();
    this.annotations = [...this.annotations, blur];
  }

  cancelBlurDrag() {
    this.blurDraft = null;
    this.blurDragStart = null;
  }

  startTextDraft(event: PointerEvent) {
    if (!this.document || this.activeTool !== "text") return;
    if (event.button !== 0) return;
    const position = this.#pointInImage(event);
    if (!position) return;
    event.preventDefault();
    if (this.textDraft) {
      if (this.textDraft.text.trim().length > 0) {
        // Commit the existing draft before placing a new one. Inlined rather than
        // calling commitTextDraft() so we record history once for the whole click.
        const draft = this.textDraft;
        const text = draft.text.trim();
        this.#recordHistory();
        this.annotations = [...this.annotations, this.#commitText(draft, text)];
      } else {
        // Reuse the empty draft and just move it to the new click location.
        this.textDraft = { ...this.textDraft, position };
        return;
      }
    }
    this.textDraft = {
      kind: "text",
      id: this.#nextAnnotationId++,
      position,
      text: "",
      color: this.penColor,
      fontSize: this.textFontSize,
      background: this.textBackground,
      backgroundOpacity: this.textBackgroundOpacity
    };
  }

  updateTextDraft(value: string) {
    if (!this.textDraft) return;
    this.textDraft = { ...this.textDraft, text: value };
  }

  commitTextDraft() {
    if (!this.textDraft) return;
    const draft = this.textDraft;
    const text = draft.text.trim();
    this.textDraft = null;
    if (text.length === 0) return;
    this.#recordHistory();
    this.annotations = [...this.annotations, this.#commitText(draft, text)];
    this.#selectPlacedAnnotation(draft.id);
  }

  // Finalize a text draft: trim already applied, stamp the real measured glyph
  // width so the committed annotation's bounds/hit box match the rendered text.
  #commitText(draft: TextAnnotation, text: string): TextAnnotation {
    return { ...draft, text, measuredWidth: measureTextWidth(text, draft.fontSize) };
  }

  cancelTextDraft() {
    this.textDraft = null;
  }

  startSelectionDrag(event: PointerEvent) {
    if (!this.document || this.activeTool !== "select") return;
    if (event.button !== 0) return;
    const point = this.#pointInImage(event);
    if (!point) return;
    event.preventDefault();
    const hit = this.#annotationAt(point);
    this.selectedAnnotationId = hit?.id ?? null;
    if (!hit) {
      this.selectionDrag = null;
      // Grabbing empty canvas pans the zoomed-in view, so the default Select
      // tool can reach an off-screen edge without discovering the Hand tool /
      // hold-Space / middle-drag. Only when the frame overflows the stage —
      // otherwise the whole image is already visible and this would just shove
      // it around. EditorStage routes the ensuing move/up through the panning
      // branch (it checks editor.panning before the tool handlers), so no
      // change is needed there. Annotation drags (hit != null) are unaffected.
      if (this.#frameOverflowsStage()) this.startPan(event);
      return;
    }
    this.imageFrame?.setPointerCapture(event.pointerId);
    this.selectionDrag = {
      id: hit.id,
      last: point,
      historyRecorded: false
    };
  }

  updateSelectionDrag(event: PointerEvent) {
    if (!this.document || !this.selectionDrag || this.activeTool !== "select") return;
    const point = this.#pointInImage(event);
    if (!point) return;
    const drag = this.selectionDrag;
    const dx = point.x - drag.last.x;
    const dy = point.y - drag.last.y;
    if (dx === 0 && dy === 0) return;
    const annotation = this.annotations.find((entry) => entry.id === drag.id);
    if (!annotation) {
      this.selectionDrag = null;
      return;
    }
    const delta = this.#boundedAnnotationDelta(annotation, dx, dy);
    if (delta.x === 0 && delta.y === 0) {
      this.selectionDrag = { ...drag, last: point };
      return;
    }
    if (!drag.historyRecorded) {
      this.#recordHistory();
    }
    this.annotations = this.annotations.map((entry) =>
      entry.id === drag.id ? translateAnnotation(entry, delta.x, delta.y) : entry
    );
    this.selectionDrag = {
      ...drag,
      last: point,
      historyRecorded: true
    };
  }

  finishSelectionDrag(event: PointerEvent) {
    if (!this.selectionDrag || this.activeTool !== "select") return;
    this.imageFrame?.releasePointerCapture(event.pointerId);
    this.selectionDrag = null;
  }

  cancelSelectionDrag() {
    this.selectionDrag = null;
  }

  clearSelection() {
    this.selectedAnnotationId = null;
    this.selectionDrag = null;
  }

  // Select a freshly placed annotation and switch to the select tool, so the
  // thing the user just drew becomes the target of the Properties panel (fill,
  // color, width, opacity, ...) without an extra click. Matches the placement
  // behavior of Figma/PowerPoint. Called only by the one-shot tool finishers
  // (shape, arrow, text) on a successful commit (a too-small or empty draft
  // never selects). The repetitive tools (pen, highlight, blur) intentionally
  // stay armed for rapid drawing and do not call this.
  #selectPlacedAnnotation(id: number) {
    this.selectedAnnotationId = id;
    this.selectionDrag = null;
    this.activeTool = "select";
  }

  deleteSelectedAnnotation() {
    if (this.selectedAnnotationId === null) return;
    const exists = this.annotations.some((annotation) => annotation.id === this.selectedAnnotationId);
    if (!exists) {
      this.clearSelection();
      return;
    }
    this.#recordHistory();
    this.annotations = this.annotations.filter((annotation) => annotation.id !== this.selectedAnnotationId);
    this.clearSelection();
  }

  #selectionLayerIndex(): { forward: boolean; backward: boolean } {
    const target = this.selectedAnnotation;
    if (!target) return { forward: false, backward: false };
    const layer = annotationLayer(target);
    const siblings = this.annotations.filter((annotation) => annotationLayer(annotation) === layer);
    const index = siblings.findIndex((annotation) => annotation.id === target.id);
    return {
      forward: index >= 0 && index < siblings.length - 1,
      backward: index > 0
    };
  }

  #reorderSelectedWithinLayer(mutateSiblings: (siblings: Annotation[], index: number) => void) {
    const target = this.selectedAnnotation;
    if (!target) return;
    const layer = annotationLayer(target);
    const positions: number[] = [];
    const siblings: Annotation[] = [];
    this.annotations.forEach((annotation, index) => {
      if (annotationLayer(annotation) === layer) {
        positions.push(index);
        siblings.push(annotation);
      }
    });
    const index = siblings.findIndex((annotation) => annotation.id === target.id);
    if (index === -1) return;

    const reordered = siblings.slice();
    mutateSiblings(reordered, index);
    if (reordered.every((annotation, siblingIndex) => annotation.id === siblings[siblingIndex].id)) {
      return;
    }

    this.#recordHistory();
    const next = this.annotations.slice();
    positions.forEach((position, siblingIndex) => {
      next[position] = reordered[siblingIndex];
    });
    this.annotations = next;
  }

  bringSelectedToFront() {
    this.#reorderSelectedWithinLayer((siblings, index) => {
      const [item] = siblings.splice(index, 1);
      siblings.push(item);
    });
  }

  sendSelectedToBack() {
    this.#reorderSelectedWithinLayer((siblings, index) => {
      const [item] = siblings.splice(index, 1);
      siblings.unshift(item);
    });
  }

  bringSelectedForward() {
    this.#reorderSelectedWithinLayer((siblings, index) => {
      if (index >= siblings.length - 1) return;
      [siblings[index], siblings[index + 1]] = [siblings[index + 1], siblings[index]];
    });
  }

  sendSelectedBackward() {
    this.#reorderSelectedWithinLayer((siblings, index) => {
      if (index <= 0) return;
      [siblings[index], siblings[index - 1]] = [siblings[index - 1], siblings[index]];
    });
  }

  updateSelectedAnnotation(patch: AnnotationStylePatch, commitHistory = true) {
    const target = this.selectedAnnotation;
    if (!target) return;
    if (commitHistory) this.#recordHistory();
    this.annotations = this.annotations.map((annotation) => {
      if (annotation.id !== target.id) return annotation;
      // Call sites narrow on selectedAnnotation.kind before passing patches.
      const next = { ...annotation, ...(patch as Record<string, unknown>) } as Annotation;
      if (next.kind === "text" && "fontSize" in patch) {
        return { ...next, measuredWidth: measureTextWidth(next.text, next.fontSize) };
      }
      return next;
    });
  }

  beginSelectionEdit() {
    if (this.#selectionEditDirty) return;
    if (!this.selectedAnnotation) return;
    this.#recordHistory();
    this.#selectionEditDirty = true;
  }

  endSelectionEdit() {
    this.#selectionEditDirty = false;
    // Live slider/drag edits commit with history off; the begin recorded one
    // history entry, but persist the final value once the gesture settles.
    this.#scheduleDocumentSave();
  }

  startErase(event: PointerEvent) {
    if (!this.document || this.activeTool !== "erase") return;
    if (event.button !== 0) return;
    const point = this.#pointInImage(event);
    if (!point) return;
    event.preventDefault();
    this.imageFrame?.setPointerCapture(event.pointerId);
    this.eraserPointer = point;
    this.eraserDrag = { erasedIds: new Set(), historyRecorded: false };
    this.#eraseAt(point);
  }

  updateErase(event: PointerEvent) {
    if (this.activeTool !== "erase") return;
    const point = this.#pointInImage(event);
    if (!point) return;
    this.eraserPointer = point;
    if (this.eraserDrag) this.#eraseAt(point);
  }

  finishErase(event: PointerEvent) {
    if (this.activeTool !== "erase") return;
    this.imageFrame?.releasePointerCapture(event.pointerId);
    this.eraserDrag = null;
  }

  cancelErase() {
    this.eraserDrag = null;
    this.eraserPointer = null;
  }

  clearEraserPointer() {
    // Keep the preview visible during an active captured drag; only clear it
    // once the gesture ends.
    if (this.eraserDrag) return;
    this.eraserPointer = null;
  }

  // One history entry per continuous erase gesture: record once, immediately
  // before the first removal. A gesture that removes nothing records nothing.
  #eraseAt(point: Point) {
    if (!this.eraserDrag) return;
    const hit = this.#annotationAt(point, this.eraserRadius);
    if (!hit || this.eraserDrag.erasedIds.has(hit.id)) return;

    if (!this.eraserDrag.historyRecorded) {
      this.#recordHistory();
      this.eraserDrag.historyRecorded = true;
    }

    this.eraserDrag.erasedIds.add(hit.id);
    this.annotations = this.annotations.filter((annotation) => annotation.id !== hit.id);
    if (this.selectedAnnotationId === hit.id) this.selectedAnnotationId = null;
  }

  // Image eraser ("Erase area"): a freehand brush that removes screenshot
  // content. Mirrors the pen-stroke lifecycle but commits an `erase` annotation
  // whose `color` is null (punch a transparent hole) or a solid fill.
  startEraseArea(event: PointerEvent) {
    if (!this.document || this.activeTool !== "erase-area") return;
    if (event.button !== 0) return;
    const start = this.#pointInImage(event);
    if (!start) return;
    event.preventDefault();
    this.imageFrame?.setPointerCapture(event.pointerId);
    this.eraseAreaPointer = start;
    this.eraseAreaDraft = {
      kind: "erase",
      id: this.#nextAnnotationId++,
      points: [start],
      width: this.eraseAreaWidth,
      color: this.eraseAreaTransparent ? null : this.eraseAreaColor
    };
  }

  updateEraseArea(event: PointerEvent) {
    if (this.activeTool !== "erase-area") return;
    const point = this.#pointInImage(event);
    if (!point) return;
    this.eraseAreaPointer = point;
    if (!this.eraseAreaDraft) return;
    const last = this.eraseAreaDraft.points.at(-1);
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < 1) return;
    this.eraseAreaDraft = {
      ...this.eraseAreaDraft,
      points: [...this.eraseAreaDraft.points, point]
    };
  }

  finishEraseArea(event: PointerEvent) {
    if (this.activeTool !== "erase-area") return;
    this.imageFrame?.releasePointerCapture(event.pointerId);
    const stroke = this.eraseAreaDraft;
    this.eraseAreaDraft = null;
    if (!stroke || stroke.points.length < 2) return;
    this.#recordHistory();
    this.annotations = [...this.annotations, stroke];
  }

  cancelEraseArea() {
    this.eraseAreaDraft = null;
  }

  clearEraseAreaPointer() {
    // Keep the brush preview while a captured stroke is in flight; only clear it
    // once the gesture ends (mirrors clearEraserPointer).
    if (this.eraseAreaDraft) return;
    this.eraseAreaPointer = null;
  }

  annotationTypeLabel(annotation: Annotation): string {
    switch (annotation.kind) {
      case "pen":
        return "Pen";
      case "erase":
        return "Erase area";
      case "arrow":
        return "Arrow";
      case "shape":
        return SHAPE_LABELS[annotation.shape];
      case "text":
        return "Text";
      case "highlight":
        return "Highlight";
      case "blur":
        return "Blur";
      case "cut":
        return "Cut";
    }
  }

  textStyle(text: TextAnnotation): string {
    return buildTextStyle(text, this.document?.zoom ?? 1);
  }

  strokePath(stroke: PenStroke): string {
    return buildStrokePath(stroke);
  }

  arrowGeometry(arrow: ArrowAnnotation, zoomOverride?: number): ArrowGeometry {
    return buildArrowGeometry(arrow, zoomOverride ?? this.document?.zoom ?? 1);
  }

  cutPreviewSeamPoints(band: CropRect, edge: "start" | "end"): Point[] {
    const position =
      this.cutAxis === "horizontal"
        ? edge === "start"
          ? band.y
          : band.y + band.height
        : edge === "start"
          ? band.x
          : band.x + band.width;
    return cutSeamPoints({
      kind: "cut",
      id: -1,
      orientation: this.cutAxis,
      position,
      start: 0,
      span: this.cutAxis === "horizontal" ? band.width : band.height,
      color: CUT_SEAM_COLOR_DEFAULT,
      width: CUT_SEAM_WIDTH_DEFAULT,
      amplitude: CUT_SEAM_AMPLITUDE_DEFAULT,
      period: CUT_SEAM_PERIOD_DEFAULT
    });
  }

  async applyCrop(): Promise<string | null> {
    if (!this.document || !this.cropRect || this.cropPending) return null;
    // Snapshot taken before the IPC; pushed to past only on success so a failed
    // crop doesn't pollute history with a "before failed crop" entry.
    const beforeCrop = this.#snapshot();
    const capturePath = this.document.capture.path;
    const cropRect = this.cropRect;
    const cropX = Math.round(cropRect.x);
    const cropY = Math.round(cropRect.y);
    this.cropPending = true;
    try {
      const result = await cropCaptureIpc(
        capturePath,
        cropX,
        cropY,
        Math.round(cropRect.width),
        Math.round(cropRect.height)
      );
      if (result.status === "error") {
        return result.error || "Crop failed.";
      }
      const survivors = cropAnnotations(
        this.annotations,
        cropX,
        cropY,
        result.data.width,
        result.data.height
      );
      const capture = rebasedCapture(this.document.capture, result.data);
      this.historyPast = [...this.historyPast, beforeCrop].slice(-50);
      this.historyFuture = [];
      this.#installCapture(capture);
      this.annotations = survivors;
      this.#pushRecent(capture);
      this.activeTool = "select";
      // Crop changed the working raster: copy the new base into the document and
      // re-render its flattened current.png alongside the transformed annotations.
      void this.#persistCurrentDocument(true);
      return `${capture.title} created.`;
    } catch (error) {
      return error instanceof Error ? error.message : String(error || "Crop failed.");
    } finally {
      this.cropPending = false;
    }
  }

  // Crop/cut re-base an existing document (same documentId, new image): replace
  // its strip entry in place rather than adding a duplicate. Distinct captures
  // (and in-memory ones without an id) are always prepended. Thin wrapper so
  // applyCrop/applyCut/ingestCompleted/ingestWithoutOpening don't each have to
  // supply DocumentStore.pushRecent's `openCapture`/`currentCapture` params by
  // hand (they can differ — see the seam comment above class EditorState).
  #pushRecent(capture: RecentCapture) {
    this.#documentStore.pushRecent(capture, this.document?.capture ?? null, this.currentCapture);
  }

  // Whether a capture carries annotation work — the predicate behind the
  // consent-on-close rule and clean-document eviction. See
  // DocumentStore.isDocumentDirty for the full rule; this just supplies the
  // live open-document identity/annotation-count it needs.
  isDocumentDirty(capture: RecentCapture): boolean {
    return this.#documentStore.isDocumentDirty(
      capture,
      this.document?.capture.documentId,
      this.annotations.length
    );
  }

  // Close a document: drop it from the strip and delete it from disk. Consent for
  // dirty documents is enforced at the call site (the UI confirms before calling
  // this). Closing the open document clears the editor back to empty.
  closeDocument(capture: RecentCapture) {
    const isCurrent = this.document
      ? workspaceKeyFor(this.document.capture) === workspaceKeyFor(capture)
      : false;
    this.#documentStore.removeFromRecents(capture);
    this.#documentStore.discardDocument(capture);
    if (isCurrent) this.#clearEditor();
  }

  // Reset the editor to the empty state (no open document). Used when the open
  // document is closed.
  #clearEditor() {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    this.document = null;
    this.currentCapture = null;
    this.cropRect = null;
    this.annotations = [];
    this.historyPast = [];
    this.historyFuture = [];
    this.#nextAnnotationId = 1;
    this.#resetTransientState();
  }

  #recordHistory() {
    this.historyPast = [...this.historyPast, this.#snapshot()].slice(-50);
    this.historyFuture = [];
    // Every committed annotation change funnels through here, so this is the one
    // place to trigger persistence (the debounce reads the post-mutation state).
    this.#scheduleDocumentSave();
  }

  // Snapshots reference the same array/object values as the live state. This
  // is safe because every mutation in this class uses immutable-update style
  // (`this.X = [...this.X, ...]`, `this.X = { ...this.X, ... }`), so any value
  // a snapshot points to is effectively frozen at the time of capture.
  //
  // recentCaptures, activeTool, penColor/penWidth, and DOM refs are intentionally
  // NOT snapshotted — recents is a file-history view that persists across undo;
  // activeTool / pen settings are UI state that shouldn't flip on undo.
  //
  // This is the COMMITTED half (see #resetTransientState for the transient half
  // and why they differ): only committed document state belongs here. If a
  // future tool commits output OUTSIDE `annotations`, snapshot that field here
  // too — otherwise undo/redo will silently drop it.
  #snapshot(): EditorSnapshot {
    return {
      document: this.document,
      currentCapture: this.currentCapture,
      cropRect: this.cropRect,
      annotations: this.annotations,
      nextAnnotationId: this.#nextAnnotationId
    };
  }

  #restore(snapshot: EditorSnapshot) {
    this.document = snapshot.document;
    this.currentCapture = snapshot.currentCapture;
    this.cropRect = snapshot.cropRect;
    // Undo/redo stays on the same capture, so the cached sample canvas remains
    // valid and is deliberately not cleared here.
    this.#resetTransientState();
    this.annotations = snapshot.annotations;
    this.#nextAnnotationId = snapshot.nextAnnotationId;
  }

  #saveCurrentWorkspace() {
    if (!this.document) return;
    this.#documentStore.saveWorkspace(this.document.capture, {
      ...this.#snapshot(),
      historyPast: this.historyPast,
      historyFuture: this.historyFuture
    });
    // Flush before the caller switches documents so the outgoing document's
    // pending write isn't cancelled by the next document's reschedule.
    this.#flushDocumentSave();
  }

  async applyCut(): Promise<string | null> {
    if (!this.document || !this.cutBand || this.cutPending) return null;
    const beforeCut = this.#snapshot();
    const capturePath = this.document.capture.path;
    const axis = this.cutAxis;
    const band = this.cutBand;
    const start = Math.round(axis === "horizontal" ? band.y : band.x);
    const length = Math.round(axis === "horizontal" ? band.height : band.width);
    this.cutPending = true;
    try {
      const result = await cutoutCaptureIpc(capturePath, axis, start, length);
      if (result.status === "error") {
        return result.error || "Cut failed.";
      }
      const survivors = cutoutAnnotations(
        this.annotations,
        axis,
        start,
        length,
        result.data.width,
        result.data.height
      );
      const seam: CutSeamAnnotation = {
        kind: "cut",
        id: this.#nextAnnotationId++,
        orientation: axis,
        position: start,
        start: 0,
        span: axis === "horizontal" ? result.data.width : result.data.height,
        color: CUT_SEAM_COLOR_DEFAULT,
        width: CUT_SEAM_WIDTH_DEFAULT,
        amplitude: CUT_SEAM_AMPLITUDE_DEFAULT,
        period: CUT_SEAM_PERIOD_DEFAULT
      };
      const capture = rebasedCapture(this.document.capture, result.data);
      this.historyPast = [...this.historyPast, beforeCut].slice(-50);
      this.historyFuture = [];
      this.#installCapture(capture);
      this.annotations = [seam, ...survivors];
      this.#pushRecent(capture);
      this.activeTool = "select";
      this.cutBand = null;
      void this.#persistCurrentDocument(true);
      return `${capture.title} created.`;
    } catch (error) {
      return error instanceof Error ? error.message : String(error || "Cut failed.");
    } finally {
      this.cutPending = false;
    }
  }

  #restoreWorkspace(workspace: CaptureWorkspaceState) {
    this.#restore(workspace);
    this.historyPast = workspace.historyPast;
    this.historyFuture = workspace.historyFuture;
    this.#sampleCanvas = null;
    this.#sampleContext = null;
    this.#sampleCanvasCapturePath = null;
    this.#sampleRequestId += 1;
  }

  #roundZoom(value: number): number {
    return Math.max(0.05, Math.min(4, Math.round(value * 100) / 100));
  }

  #fitZoomFor(capture: RecentCapture): number {
    if (!this.canvasStage) return 1;
    const availableWidth = Math.max(120, this.canvasStage.clientWidth - 112);
    const availableHeight = Math.max(120, this.canvasStage.clientHeight - 112);
    return this.#roundZoom(
      Math.min(1, availableWidth / capture.width, availableHeight / capture.height)
    );
  }

  #clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  // Bound the pan offset so the frame stays reachable. `|stage - frame| / 2` is
  // exactly the shift needed to bring a frame edge to the stage edge from the
  // centered position — for a zoomed-in frame it lets every edge be reached,
  // for a smaller frame it lets the frame be nudged to either side. The
  // overscroll margin on top lets an edge be pulled clear of the rulers.
  #clampPan(panX: number, panY: number, zoom: number): { x: number; y: number } {
    if (!this.canvasStage || !this.document) return { x: panX, y: panY };
    const stageWidth = this.canvasStage.clientWidth;
    const stageHeight = this.canvasStage.clientHeight;
    const frameWidth = this.document.capture.width * zoom;
    const frameHeight = this.document.capture.height * zoom;
    // When the frame overflows the stage, allow enough overscroll that any edge
    // can be pulled to the *center* of the viewport (overscroll = half the
    // stage), so an off-screen corner can be parked in the middle to work on it
    // — otherwise the clamp jams it ~80px from the edge, right under the
    // Properties pane. When the frame fits, keep the small fixed nudge so a
    // whole-image view can't be shoved far off-center.
    const overscrollX = frameWidth > stageWidth ? stageWidth / 2 : PAN_EDGE_OVERSCROLL;
    const overscrollY = frameHeight > stageHeight ? stageHeight / 2 : PAN_EDGE_OVERSCROLL;
    const maxX = Math.abs(stageWidth - frameWidth) / 2 + overscrollX;
    const maxY = Math.abs(stageHeight - frameHeight) / 2 + overscrollY;
    return {
      x: this.#clamp(panX, -maxX, maxX),
      y: this.#clamp(panY, -maxY, maxY)
    };
  }

  // True when the zoomed frame is larger than the stage in either axis, i.e.
  // some of the image sits off-screen and panning would reveal more of it. Used
  // to decide whether an empty-canvas left-drag with the Select tool should pan
  // (see startSelectionDrag) — at or below fit the whole image is already
  // visible, so grabbing empty space there would only shove it around pointlessly.
  #frameOverflowsStage(): boolean {
    if (!this.canvasStage || !this.document) return false;
    const frameWidth = this.document.capture.width * this.document.zoom;
    const frameHeight = this.document.capture.height * this.document.zoom;
    return frameWidth > this.canvasStage.clientWidth || frameHeight > this.canvasStage.clientHeight;
  }

  #pointInImage(event: PointerEvent): { x: number; y: number } | null {
    if (!this.document || !this.imageFrame) return null;
    const bounds = this.imageFrame.getBoundingClientRect();
    return {
      x: this.#clamp(
        Math.round((event.clientX - bounds.left) / this.document.zoom),
        0,
        this.document.capture.width
      ),
      y: this.#clamp(
        Math.round((event.clientY - bounds.top) / this.document.zoom),
        0,
        this.document.capture.height
      )
    };
  }

  #rectFromPoints(start: { x: number; y: number }, end: { x: number; y: number }): CropRect {
    return {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y)
    };
  }

  #cutBandFromPoints(start: Point, end: Point): CropRect {
    const capture = this.document?.capture;
    if (!capture) return { x: 0, y: 0, width: 0, height: 0 };
    if (this.cutAxis === "horizontal") {
      return {
        x: 0,
        y: Math.min(start.y, end.y),
        width: capture.width,
        height: Math.abs(end.y - start.y)
      };
    }
    return {
      x: Math.min(start.x, end.x),
      y: 0,
      width: Math.abs(end.x - start.x),
      height: capture.height
    };
  }

  // Visual top-to-bottom hit order so Select and Erase both target the visible
  // topmost annotation when several overlap, not merely the last one added.
  #annotationAt(
    point: Point,
    tolerance = Math.max(4, 7 / (this.document?.zoom ?? 1))
  ): Annotation | null {
    for (const annotation of annotationsInVisualHitOrder(this.annotations)) {
      if (annotationHitTest(annotation, point, tolerance)) return annotation;
    }
    return null;
  }

  #boundedAnnotationDelta(annotation: Annotation, dx: number, dy: number): Point {
    if (!this.document) return { x: dx, y: dy };
    const bounds = annotationBounds(annotation);
    const minDx = Math.min(0, -bounds.x);
    const maxDx = Math.max(0, this.document.capture.width - (bounds.x + bounds.width));
    const minDy = Math.min(0, -bounds.y);
    const maxDy = Math.max(0, this.document.capture.height - (bounds.y + bounds.height));
    return {
      x: this.#clamp(dx, minDx, maxDx),
      y: this.#clamp(dy, minDy, maxDy)
    };
  }

  async #ensureSampleCanvas(): Promise<SampleCanvas> {
    if (!this.document) throw new Error("No capture loaded.");
    const capture = this.document.capture;
    if (this.#sampleCanvas && this.#sampleContext && this.#sampleCanvasCapturePath === capture.path) {
      return { canvas: this.#sampleCanvas, context: this.#sampleContext };
    }

    const image = await loadImage(capture.assetUrl);
    const canvas = document.createElement("canvas");
    canvas.width = capture.width;
    canvas.height = capture.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas 2D context unavailable.");
    ctx.drawImage(image, 0, 0, capture.width, capture.height);

    this.#sampleCanvas = canvas;
    this.#sampleContext = ctx;
    this.#sampleCanvasCapturePath = capture.path;
    return { canvas, context: ctx };
  }

  async #sampleColorAt(point: Point): Promise<SampledColor> {
    const { canvas, context } = await this.#ensureSampleCanvas();
    const x = Math.max(0, Math.min(canvas.width - 1, Math.round(point.x)));
    const y = Math.max(0, Math.min(canvas.height - 1, Math.round(point.y)));
    const [r, g, b] = context.getImageData(x, y, 1, 1).data;
    return { point: { x, y }, color: rgbToHex(r, g, b) };
  }

  // Apply an arbitrary color from the custom picker / hex field. Validates and
  // canonicalizes the input, sets it as the active color, and adds it to
  // recents so it stays reachable across tools. Returns true when applied.
  chooseColor(color: string): boolean {
    const normalized = normalizeHexColor(color);
    if (!normalized) return false;
    this.penColor = normalized;
    this.#rememberColor(normalized);
    return true;
  }

  #rememberColor(color: string) {
    this.recentColors = [color, ...this.recentColors.filter((c) => c !== color)].slice(
      0,
      RECENT_COLOR_LIMIT
    );
  }

  previewColorSample(event: PointerEvent) {
    if (!this.document || this.activeTool !== "color") return;
    const capturePath = this.document.capture.path;
    const requestId = ++this.#sampleRequestId;
    const point = this.#pointInImage(event);
    if (!point) {
      this.colorSample = null;
      return;
    }
    void this.#sampleColorAt(point)
      .then((sample) => {
        if (
          this.activeTool !== "color" ||
          this.document?.capture.path !== capturePath ||
          this.#sampleRequestId !== requestId
        ) {
          return;
        }
        this.colorSample = sample;
      })
      .catch(() => {
        if (this.#sampleRequestId === requestId) this.colorSample = null;
      });
  }

  async commitColorSample(event: PointerEvent): Promise<string | null> {
    if (!this.document || this.activeTool !== "color") return null;
    if (event.button !== 0) return null;
    event.preventDefault();
    const capturePath = this.document.capture.path;
    this.#sampleRequestId += 1;
    const point = this.#pointInImage(event);
    if (!point) return "Could not read image coordinates.";
    try {
      const sample = await this.#sampleColorAt(point);
      if (this.document?.capture.path !== capturePath || this.activeTool !== "color") return null;
      this.penColor = sample.color;
      this.#rememberColor(sample.color);
      this.colorSample = sample;
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Color sampling failed.";
    }
  }

  clearColorSample() {
    this.#sampleRequestId += 1;
    this.colorSample = null;
  }

  async copyCurrentColor(): Promise<string | null> {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      return "Clipboard API is not available.";
    }
    try {
      await navigator.clipboard.writeText(this.penColor);
      return "Copied " + this.penColor;
    } catch {
      return "Clipboard write failed.";
    }
  }
}

export const editor = new EditorState();
