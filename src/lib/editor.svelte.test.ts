import { beforeEach, describe, expect, it, vi } from "vitest";

import { annotationsInPaintOrder } from "./annotations";
import { measureTextWidth } from "./annotationRendering";
import type {
  Annotation,
  ArrowAnnotation,
  BlurAnnotation,
  HighlightAnnotation,
  PenStroke,
  RecentCapture,
  ShapeAnnotation,
  TextAnnotation
} from "./editor.svelte";

// N9: cropCapture/cutoutCapture/createDocument/replaceDocumentBase/
// deleteDocument/listDocuments are pure `commands.*` pass-throughs the editor
// now calls directly (see editorCommands.ts's header comment) — mocked here on
// `./bindings`, not `./editorCommands`. `saveDocument` stays on
// `./editorCommands` (it carries the Uint8Array-as-number[] shim).
const commandsMock = vi.hoisted(() => ({
  cropCapture: vi.fn(),
  cutoutCapture: vi.fn(),
  createDocument: vi.fn(),
  replaceDocumentBase: vi.fn(),
  deleteDocument: vi.fn(),
  listDocuments: vi.fn(),
  copyImageToClipboard: vi.fn(),
  revealInDir: vi.fn()
}));

vi.mock("./bindings", () => ({
  commands: commandsMock
}));

vi.mock("./editorCommands", () => ({
  copyPngBytesToClipboard: vi.fn(),
  loadImage: vi.fn(),
  pickPngSavePath: vi.fn(),
  saveDocument: vi.fn(),
  savePngBytes: vi.fn(),
  toAssetUrl: (path: string) => `asset://${path}`
}));

// renderFlattenedPng needs a real <canvas> (document.createElement), which
// this suite's node environment doesn't provide. Every other export
// (measureTextWidth, arrowGeometry, strokePath, textStyle) is real — only
// renderFlattenedPng is stubbed, so the persisted-document tests can exercise
// the real #persistCurrentDocument/save_document call sequence without a DOM.
vi.mock("./annotationRendering", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./annotationRendering")>();
  return { ...actual, renderFlattenedPng: vi.fn().mockResolvedValue(new Uint8Array()) };
});

const { EditorState, slugifyCaptureTitle } = await import("./editor.svelte");
const { saveDocument } = await import("./editorCommands");
const cropCaptureMock = commandsMock.cropCapture;
const cutoutCaptureMock = commandsMock.cutoutCapture;
const replaceDocumentBaseMock = commandsMock.replaceDocumentBase;
const saveDocumentMock = vi.mocked(saveDocument);

function capture(path: string, width = 100, height = 100): RecentCapture {
  return {
    mode: "region",
    title: path.replace(/[\\/]/g, "-"),
    path,
    width,
    height,
    assetUrl: `asset://${path}`
  };
}

function textDraft(id: number, text: string): TextAnnotation {
  return {
    kind: "text",
    id,
    position: { x: 10, y: 12 },
    text,
    color: "#000000",
    fontSize: 20,
    background: true,
    backgroundOpacity: 0.72
  };
}

function shapeAnnotation(id: number, patch: Partial<ShapeAnnotation> = {}): ShapeAnnotation {
  return {
    kind: "shape",
    id,
    shape: "rectangle",
    rect: { x: 10, y: 10, width: 20, height: 20 },
    color: "#000000",
    width: 2,
    fill: false,
    fillOpacity: 0.2,
    ...patch
  };
}

function arrowAnnotation(id: number, patch: Partial<ArrowAnnotation> = {}): ArrowAnnotation {
  return {
    kind: "arrow",
    id,
    start: { x: 10, y: 10 },
    end: { x: 30, y: 30 },
    color: "#000000",
    width: 2,
    ...patch
  };
}

function penAnnotation(id: number, patch: Partial<PenStroke> = {}): PenStroke {
  return {
    kind: "pen",
    id,
    points: [
      { x: 10, y: 10 },
      { x: 20, y: 20 }
    ],
    color: "#000000",
    width: 2,
    ...patch
  };
}

function highlightAnnotation(
  id: number,
  patch: Partial<HighlightAnnotation> = {}
): HighlightAnnotation {
  return {
    kind: "highlight",
    id,
    rect: { x: 10, y: 10, width: 20, height: 20 },
    color: "#f0b429",
    opacity: 0.35,
    ...patch
  };
}

function blurAnnotation(id: number, patch: Partial<BlurAnnotation> = {}): BlurAnnotation {
  return {
    kind: "blur",
    id,
    rect: { x: 10, y: 10, width: 20, height: 20 },
    radius: 10,
    ...patch
  };
}

function imageFrame(): HTMLDivElement {
  return {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
  } as unknown as HTMLDivElement;
}

function pointer(clientX: number, clientY: number): PointerEvent {
  return {
    button: 0,
    clientX,
    clientY,
    pointerId: 1,
    preventDefault: vi.fn()
  } as unknown as PointerEvent;
}

function canvasStage(width = 800, height = 600): HTMLDivElement {
  return { clientWidth: width, clientHeight: height } as unknown as HTMLDivElement;
}

function annotationIds(annotations: Annotation[]): number[] {
  return annotations.map((annotation) => annotation.id);
}

describe("EditorState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("commitTextDraft stamps measuredWidth, records one history entry, and undo removes it", () => {
    const state = new EditorState();
    state.openCapture(capture("/a.png"));
    state.textDraft = textDraft(1, "  label  ");

    state.commitTextDraft();

    expect(state.annotations).toHaveLength(1);
    const committed = state.annotations[0] as TextAnnotation;
    expect(committed.text).toBe("label");
    expect(committed.measuredWidth).toBeCloseTo("label".length * 20 * 0.58);
    expect(state.historyPast).toHaveLength(1);

    state.undo();

    expect(state.annotations).toEqual([]);
    expect(state.canRedo).toBe(true);
  });

  it("caps undo history at 50 snapshots", () => {
    const state = new EditorState();
    state.openCapture(capture("/history.png"));

    for (let id = 1; id <= 55; id += 1) {
      state.textDraft = textDraft(id, `note ${id}`);
      state.commitTextDraft();
    }

    expect(state.annotations).toHaveLength(55);
    expect(state.historyPast).toHaveLength(50);
  });

  it("deleteSelectedAnnotation clears a stale selection without recording history", () => {
    const state = new EditorState();
    const annotation: Annotation = textDraft(1, "kept");
    state.openCapture(capture("/delete.png"));
    state.annotations = [annotation];
    state.selectedAnnotationId = 99;

    state.deleteSelectedAnnotation();

    expect(state.annotations).toEqual([annotation]);
    expect(state.selectedAnnotationId).toBeNull();
    expect(state.historyPast).toHaveLength(0);
  });

  it("updateSelectedAnnotation patches the selected shape and leaves other annotations untouched", () => {
    const state = new EditorState();
    const selected = shapeAnnotation(1);
    const untouched = shapeAnnotation(2, {
      rect: { x: 40, y: 40, width: 10, height: 10 },
      color: "#d73535"
    });
    state.openCapture(capture("/shape-fill.png"));
    state.annotations = [selected, untouched];
    state.selectedAnnotationId = selected.id;

    state.updateSelectedAnnotation({ fill: true });

    expect(state.annotations[0]).toEqual({ ...selected, fill: true });
    expect(state.annotations[1]).toEqual(untouched);
  });

  it("updateSelectedAnnotation is a no-op when nothing is selected", () => {
    const state = new EditorState();
    const shape = shapeAnnotation(1);
    const text = textDraft(2, "kept");
    state.openCapture(capture("/shape-noop.png"));
    state.annotations = [shape, text];

    state.updateSelectedAnnotation({ fill: true });

    expect(state.annotations).toEqual([shape, text]);
    expect(state.historyPast).toHaveLength(0);
  });

  it("updateSelectedAnnotation records history only for committed edits", () => {
    const state = new EditorState();
    const shape = shapeAnnotation(1);
    state.openCapture(capture("/shape-history.png"));
    state.annotations = [shape];
    state.selectedAnnotationId = shape.id;

    state.updateSelectedAnnotation({ fill: true }, false);
    expect(state.historyPast).toHaveLength(0);

    state.updateSelectedAnnotation({ width: 6 }, true);
    expect(state.historyPast).toHaveLength(1);
  });

  it("beginSelectionEdit groups continuous selected-shape updates into one undo step", () => {
    const state = new EditorState();
    const shape = shapeAnnotation(1, { fill: true, fillOpacity: 0.2 });
    state.openCapture(capture("/shape-gesture.png"));
    state.annotations = [shape];
    state.selectedAnnotationId = shape.id;

    state.beginSelectionEdit();
    state.updateSelectedAnnotation({ fillOpacity: 0.3 }, false);
    state.updateSelectedAnnotation({ fillOpacity: 0.4 }, false);
    state.updateSelectedAnnotation({ fillOpacity: 0.5 }, false);
    state.endSelectionEdit();

    expect(state.historyPast).toHaveLength(1);
    expect((state.annotations[0] as ShapeAnnotation).fillOpacity).toBe(0.5);

    state.undo();

    expect(state.annotations).toEqual([shape]);
  });

  it("draws new shapes from the global fill defaults after editing a selected shape", () => {
    const state = new EditorState();
    const existing = shapeAnnotation(1, { fill: false, fillOpacity: 0.2 });
    state.openCapture(capture("/shape-defaults.png"));
    state.imageFrame = imageFrame();
    state.annotations = [existing];
    state.selectedAnnotationId = existing.id;
    state.updateSelectedAnnotation({ fill: true, fillOpacity: 0.5 });

    state.shapeFill = false;
    state.shapeFillOpacity = 0.35;
    state.activeTool = "shape";
    state.startShapeDrag(pointer(40, 40));
    state.updateShapeDrag(pointer(70, 70));
    state.finishShapeDrag(pointer(70, 70));

    expect(state.annotations[0]).toMatchObject({ fill: true, fillOpacity: 0.5 });
    expect(state.annotations[1]).toMatchObject({ fill: false, fillOpacity: 0.35 });
  });

  it("selects a freshly placed shape and switches to the select tool", () => {
    const state = new EditorState();
    state.openCapture(capture("/auto-select.png"));
    state.imageFrame = imageFrame();
    state.activeTool = "shape";
    state.startShapeDrag(pointer(40, 40));
    state.updateShapeDrag(pointer(80, 80));
    state.finishShapeDrag(pointer(80, 80));

    const placed = state.annotations.at(-1)!;
    expect(state.selectedAnnotationId).toBe(placed.id);
    expect(state.activeTool).toBe("select");
  });

  it("does not select or switch tool when a too-small shape never commits", () => {
    const state = new EditorState();
    state.openCapture(capture("/too-small.png"));
    state.imageFrame = imageFrame();
    state.activeTool = "shape";
    state.startShapeDrag(pointer(40, 40));
    state.updateShapeDrag(pointer(41, 41));
    state.finishShapeDrag(pointer(41, 41));

    expect(state.annotations).toHaveLength(0);
    expect(state.selectedAnnotationId).toBeNull();
    expect(state.activeTool).toBe("shape");
  });

  it("selects a freshly committed text annotation and switches to the select tool", () => {
    const state = new EditorState();
    state.openCapture(capture("/auto-select-text.png"));
    state.imageFrame = imageFrame();
    state.activeTool = "text";
    state.startTextDraft(pointer(30, 30));
    state.updateTextDraft("hi");
    state.commitTextDraft();

    const placed = state.annotations.at(-1)!;
    expect(state.selectedAnnotationId).toBe(placed.id);
    expect(state.activeTool).toBe("select");
  });

  it("keeps the pen tool armed after a stroke and does not auto-select", () => {
    const state = new EditorState();
    state.openCapture(capture("/pen-rapid.png"));
    state.imageFrame = imageFrame();
    state.activeTool = "pen";
    state.startPenStroke(pointer(10, 10));
    state.updatePenStroke(pointer(30, 30));
    state.finishPenStroke(pointer(30, 30));

    expect(state.annotations).toHaveLength(1);
    expect(state.selectedAnnotationId).toBeNull();
    expect(state.activeTool).toBe("pen");
  });

  it("commits a multi-point erase-area stroke and records one history entry", () => {
    const state = new EditorState();
    state.openCapture(capture("/erase-area.png"));
    state.imageFrame = imageFrame();
    state.activeTool = "erase-area";
    state.startEraseArea(pointer(10, 10));
    state.updateEraseArea(pointer(40, 40));
    state.finishEraseArea(pointer(40, 40));

    expect(state.annotations).toHaveLength(1);
    expect(state.annotations[0].kind).toBe("erase");
    expect(state.eraseAreaDraft).toBeNull();
    expect(state.historyPast).toHaveLength(1);

    state.undo();
    expect(state.annotations).toHaveLength(0);
  });

  it("discards a single-click erase-area stroke without touching history", () => {
    const state = new EditorState();
    state.openCapture(capture("/erase-area-click.png"));
    state.imageFrame = imageFrame();
    state.activeTool = "erase-area";
    state.startEraseArea(pointer(10, 10));
    state.finishEraseArea(pointer(10, 10));

    expect(state.annotations).toHaveLength(0);
    expect(state.eraseAreaDraft).toBeNull();
    expect(state.historyPast).toHaveLength(0);
  });

  it("snapshots the fill mode at stroke-start: transparent -> null, color -> hex", () => {
    const state = new EditorState();
    state.openCapture(capture("/erase-area-fill.png"));
    state.imageFrame = imageFrame();
    state.activeTool = "erase-area";

    state.startEraseArea(pointer(10, 10));
    state.updateEraseArea(pointer(40, 40));
    state.finishEraseArea(pointer(40, 40));
    const transparentStroke = state.annotations.at(-1);
    expect(transparentStroke?.kind === "erase" ? transparentStroke.color : "unset").toBeNull();

    state.eraseAreaTransparent = false;
    state.eraseAreaColor = "#123456";
    state.startEraseArea(pointer(10, 10));
    state.updateEraseArea(pointer(40, 40));
    state.finishEraseArea(pointer(40, 40));
    const colorStroke = state.annotations.at(-1);
    expect(colorStroke?.kind === "erase" ? colorStroke.color : "unset").toBe("#123456");
  });

  it("updateSelectedAnnotation flips arrow, pen, and highlight color independently", () => {
    const state = new EditorState();
    const arrow = arrowAnnotation(1);
    const pen = penAnnotation(2);
    const highlight = highlightAnnotation(3);
    state.openCapture(capture("/style-colors.png"));
    state.annotations = [arrow, pen, highlight];

    state.selectedAnnotationId = arrow.id;
    state.updateSelectedAnnotation({ color: "#d73535" });
    state.selectedAnnotationId = pen.id;
    state.updateSelectedAnnotation({ color: "#1c7c6d" });
    state.selectedAnnotationId = highlight.id;
    state.updateSelectedAnnotation({ color: "#2f6fed" });

    expect(state.annotations).toEqual([
      { ...arrow, color: "#d73535" },
      { ...pen, color: "#1c7c6d" },
      { ...highlight, color: "#2f6fed" }
    ]);
  });

  it("updateSelectedAnnotation remeasures text width only when font size changes", () => {
    const state = new EditorState();
    const text: TextAnnotation = {
      ...textDraft(1, "resize me"),
      measuredWidth: 123
    };
    state.openCapture(capture("/text-style.png"));
    state.annotations = [text];
    state.selectedAnnotationId = text.id;

    state.updateSelectedAnnotation({ color: "#d73535" });
    expect((state.annotations[0] as TextAnnotation).measuredWidth).toBe(123);

    state.updateSelectedAnnotation({ fontSize: 32 });

    const updated = state.annotations[0] as TextAnnotation;
    expect(updated.fontSize).toBe(32);
    expect(updated.measuredWidth).toBeCloseTo(measureTextWidth(text.text, 32));
  });

  it("updateSelectedAnnotation patches blur radius", () => {
    const state = new EditorState();
    const blur = blurAnnotation(1);
    state.openCapture(capture("/blur-style.png"));
    state.annotations = [blur];
    state.selectedAnnotationId = blur.id;

    state.updateSelectedAnnotation({ radius: 18 });

    expect(state.annotations).toEqual([{ ...blur, radius: 18 }]);
  });

  it("beginSelectionEdit groups continuous non-shape updates into one undo step", () => {
    const state = new EditorState();
    const arrow = arrowAnnotation(1, { width: 2 });
    state.openCapture(capture("/arrow-gesture.png"));
    state.annotations = [arrow];
    state.selectedAnnotationId = arrow.id;

    state.beginSelectionEdit();
    state.updateSelectedAnnotation({ width: 4 }, false);
    state.updateSelectedAnnotation({ width: 6 }, false);
    state.updateSelectedAnnotation({ width: 8 }, false);
    state.endSelectionEdit();

    expect(state.historyPast).toHaveLength(1);
    expect((state.annotations[0] as ArrowAnnotation).width).toBe(8);

    state.undo();

    expect(state.annotations).toEqual([arrow]);
  });

  it("endSelectionEdit lets the next selection edit record its own undo step", () => {
    const state = new EditorState();
    const arrow = arrowAnnotation(1, { width: 2 });
    state.openCapture(capture("/arrow-repeat-gesture.png"));
    state.annotations = [arrow];
    state.selectedAnnotationId = arrow.id;

    state.beginSelectionEdit();
    state.updateSelectedAnnotation({ width: 4 }, false);
    state.endSelectionEdit();
    state.beginSelectionEdit();
    state.updateSelectedAnnotation({ width: 6 }, false);
    state.endSelectionEdit();

    expect(state.historyPast).toHaveLength(2);

    state.undo();
    expect((state.annotations[0] as ArrowAnnotation).width).toBe(4);

    state.undo();
    expect(state.annotations).toEqual([arrow]);
  });

  it("reorders selected annotations within their layer", () => {
    const state = new EditorState();
    const a = shapeAnnotation(1);
    const b = shapeAnnotation(2);
    const c = shapeAnnotation(3);
    state.openCapture(capture("/shape-order.png"));
    state.annotations = [a, b, c];

    state.selectedAnnotationId = a.id;
    expect(state.selectionCanBringForward).toBe(true);
    expect(state.selectionCanSendBackward).toBe(false);
    state.bringSelectedToFront();
    expect(annotationIds(state.annotations)).toEqual([2, 3, 1]);

    state.selectedAnnotationId = c.id;
    state.sendSelectedToBack();
    expect(annotationIds(state.annotations)).toEqual([3, 2, 1]);

    state.selectedAnnotationId = b.id;
    state.bringSelectedForward();
    expect(annotationIds(state.annotations)).toEqual([3, 1, 2]);

    state.sendSelectedBackward();
    expect(annotationIds(state.annotations)).toEqual([3, 2, 1]);
  });

  it("reordering respects fixed layer boundaries", () => {
    const state = new EditorState();
    const blur = blurAnnotation(1);
    const shapeA = shapeAnnotation(2);
    const text = textDraft(3, "front");
    const shapeB = shapeAnnotation(4);
    state.openCapture(capture("/layer-order.png"));
    state.annotations = [blur, shapeA, text, shapeB];
    state.selectedAnnotationId = shapeA.id;

    state.bringSelectedToFront();

    expect(annotationIds(state.annotations)).toEqual([blur.id, shapeB.id, text.id, shapeA.id]);
    expect(annotationIds(annotationsInPaintOrder(state.annotations))).toEqual([
      blur.id,
      shapeB.id,
      shapeA.id,
      text.id
    ]);
  });

  it("no-op reorders at layer ends record no history", () => {
    const state = new EditorState();
    const a = shapeAnnotation(1);
    const b = shapeAnnotation(2);
    state.openCapture(capture("/order-noop.png"));
    state.annotations = [a, b];

    state.selectedAnnotationId = b.id;
    expect(state.selectionCanBringForward).toBe(false);
    expect(state.selectionCanSendBackward).toBe(true);
    state.bringSelectedToFront();

    expect(state.annotations).toEqual([a, b]);
    expect(state.historyPast).toHaveLength(0);

    state.selectedAnnotationId = a.id;
    state.sendSelectedToBack();

    expect(state.annotations).toEqual([a, b]);
    expect(state.historyPast).toHaveLength(0);
  });

  it("undo restores a real reorder in one step", () => {
    const state = new EditorState();
    const a = shapeAnnotation(1);
    const b = shapeAnnotation(2);
    const c = shapeAnnotation(3);
    state.openCapture(capture("/order-undo.png"));
    state.annotations = [a, b, c];
    state.selectedAnnotationId = a.id;

    state.bringSelectedForward();

    expect(annotationIds(state.annotations)).toEqual([2, 1, 3]);
    expect(state.historyPast).toHaveLength(1);

    state.undo();

    expect(state.annotations).toEqual([a, b, c]);
  });

  it("clamps selection movement to the capture bounds and records history once", () => {
    const state = new EditorState();
    const annotation: Annotation = shapeAnnotation(1, {
      rect: { x: 80, y: 10, width: 10, height: 10 }
    });
    state.openCapture(capture("/move.png", 100, 100));
    state.imageFrame = imageFrame();
    state.activeTool = "select";
    state.annotations = [annotation];
    state.selectionDrag = { id: 1, last: { x: 80, y: 10 }, historyRecorded: false };

    state.updateSelectionDrag(pointer(120, 10));

    expect(state.annotations[0]).toMatchObject({
      rect: { x: 90, y: 10, width: 10, height: 10 }
    });
    expect(state.historyPast).toHaveLength(1);
    expect(state.selectionDrag?.historyRecorded).toBe(true);
  });

  it("clamps panBy to the centered position plus the edge overscroll", () => {
    const state = new EditorState();
    state.canvasStage = canvasStage(800, 600);
    state.openCapture(capture("/pan.png", 100, 100));

    // zoom is 1 (fits), frame 100x100 in an 800x600 stage:
    // maxX = |800-100|/2 + 80 = 430, maxY = |600-100|/2 + 80 = 330.
    state.panBy(1000, -1000);

    expect(state.document?.panX).toBe(430);
    expect(state.document?.panY).toBe(-330);
  });

  it("lets an overflowing frame pan until an edge reaches the viewport center", () => {
    const state = new EditorState();
    state.canvasStage = canvasStage(800, 600);
    state.openCapture(capture("/pan-overflow.png", 300, 300));
    // Zoom 4x: frame 1200x1200 overflows the 800x600 stage on both axes, so the
    // overscroll is half the stage and the clamp reaches frame/2 (edge->center).
    state.setEditorZoom(4);
    state.panBy(-5000, -5000);
    expect(state.document?.panX).toBe(-600);
    expect(state.document?.panY).toBe(-600);
    // Symmetric the other way too.
    state.panBy(10000, 10000);
    expect(state.document?.panX).toBe(600);
    expect(state.document?.panY).toBe(600);
  });

  it("setFitZoom recenters the preview by clearing the pan offset", () => {
    const state = new EditorState();
    state.canvasStage = canvasStage(800, 600);
    state.openCapture(capture("/recenter.png", 100, 100));
    state.panBy(120, 60);
    expect(state.document?.panX).toBe(120);

    state.setFitZoom();

    expect(state.document).toMatchObject({ mode: "fit", panX: 0, panY: 0 });
  });

  it("startPan/updatePan translate by the pointer delta and toggle the panning flag", () => {
    const state = new EditorState();
    state.canvasStage = canvasStage(800, 600);
    state.openCapture(capture("/drag.png", 100, 100));

    state.startPan(pointer(100, 100));
    expect(state.panning).toBe(true);
    state.updatePan(pointer(130, 90));

    expect(state.document?.panX).toBe(30);
    expect(state.document?.panY).toBe(-10);

    state.finishPan();
    expect(state.panning).toBe(false);
  });

  it("pans the view on an empty-canvas Select drag once the zoomed frame overflows the stage", () => {
    const state = new EditorState();
    state.canvasStage = canvasStage(800, 600);
    state.openCapture(capture("/select-pan.png", 300, 300));
    state.imageFrame = imageFrame();

    // At fit (zoom 1, 300x300 frame in an 800x600 stage) the whole image is
    // visible, so grabbing empty canvas must not start a pan.
    state.startSelectionDrag(pointer(50, 50));
    expect(state.panning).toBe(false);

    // Zoomed to the 4x max, the frame (1200x1200) overflows the stage: the same
    // empty-canvas drag now pans, and reaches the bottom-right clamp.
    state.setEditorZoom(4);
    state.startSelectionDrag(pointer(50, 50));
    expect(state.panning).toBe(true);
    state.updatePan(pointer(-5000, -5000));
    // Overflowing both axes, so overscroll is half the stage and each edge can
    // reach the viewport center: maxX = |800-1200|/2 + 800/2 = 600,
    // maxY = |600-1200|/2 + 600/2 = 600 (both = frame/2).
    expect(state.document?.panX).toBe(-600);
    expect(state.document?.panY).toBe(-600);
    state.finishPan();
  });

  it("moves a hit annotation on a Select drag instead of panning", () => {
    const state = new EditorState();
    state.canvasStage = canvasStage(800, 600);
    state.openCapture(capture("/select-move.png", 300, 300));
    state.imageFrame = imageFrame();
    state.setEditorZoom(4);
    state.annotations = [highlightAnnotation(1)];

    // Client (60,60) maps to image-space ~15,15 at zoom 4, landing on the
    // annotation (rect 10,10,20,20): the drag selects and moves it, and must
    // not hijack the gesture into a pan.
    state.startSelectionDrag(pointer(60, 60));
    expect(state.selectedAnnotationId).toBe(1);
    expect(state.panning).toBe(false);
  });

  it("restores annotations and history when switching back to a recent capture", () => {
    const state = new EditorState();
    const first = capture("/first.png");
    const second = capture("/second.png");

    state.openCapture(first);
    state.textDraft = textDraft(1, "first note");
    state.commitTextDraft();
    state.openCapture(second);
    expect(state.annotations).toEqual([]);

    state.openCapture(first);

    expect(state.annotations).toHaveLength(1);
    expect((state.annotations[0] as TextAnnotation).text).toBe("first note");
    expect(state.historyPast).toHaveLength(1);
  });

  it("applyCrop keeps intersecting annotations translated and drops outside annotations", async () => {
    const state = new EditorState();
    const inside: Annotation = {
      kind: "highlight",
      id: 1,
      rect: { x: 12, y: 23, width: 10, height: 10 },
      color: "#ffff00",
      opacity: 0.35
    };
    const outside: Annotation = {
      kind: "shape",
      id: 2,
      shape: "rectangle",
      rect: { x: 90, y: 90, width: 10, height: 10 },
      color: "#000000",
      width: 2,
      fill: false,
      fillOpacity: 0.2
    };
    state.openCapture(capture("/source.png", 100, 100));
    state.annotations = [inside, outside];
    state.cropRect = { x: 10.4, y: 20.4, width: 50.4, height: 40.4 };
    cropCaptureMock.mockResolvedValue({
      status: "ok",
      data: capture("/source-cropped.png", 50, 40)
    });

    await expect(state.applyCrop()).resolves.toBe("-source-cropped.png created.");

    expect(cropCaptureMock).toHaveBeenCalledWith("/source.png", 10, 20, 50, 40);
    expect(state.currentCapture?.path).toBe("/source-cropped.png");
    expect(state.annotations).toEqual([
      {
        ...inside,
        rect: { x: 2, y: 3, width: 10, height: 10 }
      }
    ]);
  });

  it("undo after applyCrop restores the previous capture and original annotations", async () => {
    const state = new EditorState();
    const originalAnnotations: Annotation[] = [
      {
        kind: "highlight",
        id: 1,
        rect: { x: 12, y: 23, width: 10, height: 10 },
        color: "#ffff00",
        opacity: 0.35
      },
      {
        kind: "shape",
        id: 2,
        shape: "rectangle",
        rect: { x: 90, y: 90, width: 10, height: 10 },
        color: "#000000",
        width: 2,
        fill: false,
        fillOpacity: 0.2
      }
    ];
    state.openCapture(capture("/undo-source.png", 100, 100));
    state.annotations = originalAnnotations;
    state.cropRect = { x: 10, y: 20, width: 50, height: 40 };
    cropCaptureMock.mockResolvedValue({
      status: "ok",
      data: capture("/undo-cropped.png", 50, 40)
    });

    await state.applyCrop();
    state.undo();

    expect(state.currentCapture?.path).toBe("/undo-source.png");
    expect(state.annotations).toEqual(originalAnnotations);
  });

  // applyCrop re-bases the persisted document (replaceBase=true) to the
  // cropped raster. Before the fix, undo's debounced save ran
  // #persistCurrentDocument with the default replaceBase=false, so it wrote
  // the pre-crop annotation layer WITHOUT copying the pre-crop raster back
  // into base.png — base.png/manifest dims stayed cropped while
  // annotations.json (and the live in-memory capture) went back to pre-crop,
  // corrupting the on-disk document and squashing subsequent renders. The fix
  // tracks the base path last actually persisted per document and re-bases
  // whenever the live capture disagrees with it, regardless of the caller's
  // replaceBase flag.
  it("undo across a crop re-bases the persisted document", async () => {
    const state = new EditorState();
    const persisted: RecentCapture = {
      ...capture("/doc/base.png", 100, 100),
      documentId: "doc-1",
      currentPath: "/doc/current.png",
      dirty: false
    };
    state.openCapture(persisted);

    let nextUpdatedAt = 1;
    replaceDocumentBaseMock.mockImplementation(
      async (id: string, _sourcePath: string, title: string, width: number, height: number) => ({
        status: "ok",
        data: {
          id,
          mode: "region",
          title,
          width,
          height,
          createdAt: 0,
          updatedAt: nextUpdatedAt++,
          dirty: false,
          basePath: "/doc/base.png",
          currentPath: "/doc/current.png",
          annotations: "[]"
        }
      })
    );
    saveDocumentMock.mockImplementation(async (id, annotations, _bytes, dirty) => ({
      status: "ok",
      data: {
        id,
        mode: "region",
        title: "Region",
        width: 0,
        height: 0,
        createdAt: 0,
        updatedAt: nextUpdatedAt++,
        dirty,
        basePath: "/doc/base.png",
        currentPath: "/doc/current.png",
        annotations
      }
    }));

    state.cropRect = { x: 10, y: 10, width: 50, height: 40 };
    cropCaptureMock.mockResolvedValue({
      status: "ok",
      data: capture("/doc/cropped.png", 50, 40)
    });

    await state.applyCrop();
    // applyCrop's own persist (replaceBase=true) is fire-and-forget; wait for
    // it to actually land before asserting on it.
    await vi.waitFor(() => expect(saveDocumentMock).toHaveBeenCalled());

    expect(replaceDocumentBaseMock).toHaveBeenLastCalledWith(
      "doc-1",
      "/doc/cropped.png",
      expect.any(String),
      50,
      40
    );
    expect(state.currentCapture?.width).toBe(50);
    expect(state.currentCapture?.height).toBe(40);

    replaceDocumentBaseMock.mockClear();
    saveDocumentMock.mockClear();

    vi.useFakeTimers();
    try {
      state.undo();

      // #restore is synchronous: the live capture is back to the pre-crop
      // raster immediately, before the debounced persist even fires.
      expect(state.currentCapture?.path).toBe("/doc/base.png");
      expect(state.currentCapture?.width).toBe(100);
      expect(state.currentCapture?.height).toBe(100);

      // Flush DOCUMENT_SAVE_DEBOUNCE_MS (500ms, not exported).
      await vi.advanceTimersByTimeAsync(500);
    } finally {
      vi.useRealTimers();
    }

    expect(replaceDocumentBaseMock).toHaveBeenCalledWith(
      "doc-1",
      "/doc/base.png",
      expect.any(String),
      100,
      100
    );
    expect(saveDocumentMock).toHaveBeenCalledOnce();
    // The re-base must land before the annotation/current.png write, or the
    // save could describe a document whose base.png is still the wrong image.
    const rebaseOrder = replaceDocumentBaseMock.mock.invocationCallOrder[0];
    const saveOrder = saveDocumentMock.mock.invocationCallOrder[0];
    expect(rebaseOrder).toBeLessThan(saveOrder);

    // The live capture still matches the pre-crop raster once the undo's
    // persist has resolved — #applyRecordToRecent must not have clobbered it.
    expect(state.currentCapture?.width).toBe(100);
    expect(state.currentCapture?.height).toBe(100);

    // Redo back across the crop re-bases to the cropped path again.
    replaceDocumentBaseMock.mockClear();
    saveDocumentMock.mockClear();

    vi.useFakeTimers();
    try {
      state.redo();
      expect(state.currentCapture?.path).toBe("/doc/cropped.png");
      await vi.advanceTimersByTimeAsync(500);
    } finally {
      vi.useRealTimers();
    }

    expect(replaceDocumentBaseMock).toHaveBeenCalledWith(
      "doc-1",
      "/doc/cropped.png",
      expect.any(String),
      50,
      40
    );
    expect(state.currentCapture?.width).toBe(50);
    expect(state.currentCapture?.height).toBe(40);
  });

  it("applyCut installs the cut capture, shifts annotations, inserts a seam, and undo restores", async () => {
    const state = new EditorState();
    const above = shapeAnnotation(1, { rect: { x: 10, y: 10, width: 20, height: 10 } });
    const below = shapeAnnotation(2, { rect: { x: 10, y: 80, width: 20, height: 10 } });
    state.openCapture(capture("/cut-source.png", 100, 100));
    state.annotations = [above, below];
    state.cutBand = { x: 0, y: 40, width: 100, height: 20 };
    cutoutCaptureMock.mockResolvedValue({
      status: "ok",
      data: { ...capture("/cut-source-cutout.png", 100, 80), title: "Cut - 100 x 80" }
    });

    await expect(state.applyCut()).resolves.toBe("Cut - 100 x 80 created.");

    expect(cutoutCaptureMock).toHaveBeenCalledWith("/cut-source.png", "horizontal", 40, 20);
    expect(state.currentCapture?.path).toBe("/cut-source-cutout.png");
    expect(state.activeTool).toBe("select");
    expect(state.historyPast).toHaveLength(1);
    expect(state.annotations).toHaveLength(3);
    expect(state.annotations[0]).toMatchObject({
      kind: "cut",
      orientation: "horizontal",
      position: 40,
      span: 100
    });
    expect(state.annotations.slice(1)).toEqual([
      above,
      { ...below, rect: { x: 10, y: 60, width: 20, height: 10 } }
    ]);

    state.undo();

    expect(state.currentCapture?.path).toBe("/cut-source.png");
    expect(state.annotations).toEqual([above, below]);
  });

  it("applyCut is a no-op without a band and records no history on IPC error", async () => {
    const state = new EditorState();
    state.openCapture(capture("/cut-error-source.png", 100, 100));

    await expect(state.applyCut()).resolves.toBeNull();
    expect(cutoutCaptureMock).not.toHaveBeenCalled();

    state.cutBand = { x: 0, y: 40, width: 100, height: 20 };
    cutoutCaptureMock.mockResolvedValue({ status: "error", error: "cut failed" });

    await expect(state.applyCut()).resolves.toBe("cut failed");

    expect(state.historyPast).toHaveLength(0);
    expect(state.currentCapture?.path).toBe("/cut-error-source.png");
    expect(state.annotations).toEqual([]);
  });

  it("annotations added after a crop do not reuse surviving annotation ids", async () => {
    const state = new EditorState();
    state.openCapture(capture("/ids-source.png", 100, 100));
    state.imageFrame = imageFrame();
    state.activeTool = "text";
    state.startTextDraft(pointer(20, 25));
    state.updateTextDraft("inside");
    state.commitTextDraft();
    expect(state.annotations[0]?.id).toBe(1);

    state.cropRect = { x: 10, y: 20, width: 50, height: 40 };
    cropCaptureMock.mockResolvedValue({
      status: "ok",
      data: capture("/ids-cropped.png", 50, 40)
    });
    await state.applyCrop();

    state.activeTool = "text";
    state.startTextDraft(pointer(30, 30));
    state.updateTextDraft("new");
    state.commitTextDraft();

    expect(state.annotations.map((annotation) => annotation.id)).toEqual([1, 2]);
  });
});

describe("slugifyCaptureTitle", () => {
  it("lowercases and hyphenates non-alphanumeric runs", () => {
    expect(slugifyCaptureTitle("Region - Display 1")).toBe("region-display-1");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugifyCaptureTitle("--Window--")).toBe("window");
  });

  it("falls back to a generic name when nothing usable remains", () => {
    expect(slugifyCaptureTitle("!!!")).toBe("screenpick-capture");
    expect(slugifyCaptureTitle("")).toBe("screenpick-capture");
  });

  // A title that slugifies down to a Windows reserved device name (a
  // window literally titled "Con", or a serial-port app named "COM1") used to
  // produce e.g. "con.png", which fails to create on Windows and made a batch
  // export fail loudly instead of just disambiguating the one name.
  it("disambiguates Windows reserved device names", () => {
    expect(slugifyCaptureTitle("Con")).toBe("con-capture");
    expect(slugifyCaptureTitle("PRN")).toBe("prn-capture");
    expect(slugifyCaptureTitle("aux")).toBe("aux-capture");
    expect(slugifyCaptureTitle("NUL")).toBe("nul-capture");
    expect(slugifyCaptureTitle("com1")).toBe("com1-capture");
    expect(slugifyCaptureTitle("LPT9")).toBe("lpt9-capture");
  });

  it("does not touch names that merely contain a reserved word", () => {
    expect(slugifyCaptureTitle("Console Window")).toBe("console-window");
    expect(slugifyCaptureTitle("COM1 Settings")).toBe("com1-settings");
  });
});

describe("persistError", () => {
  const revealInDirMock = commandsMock.revealInDir;

  function persistedDocument(): RecentCapture {
    return {
      ...capture("/w3/base.png", 100, 100),
      documentId: "doc-w3",
      currentPath: "/w3/current.png",
      dirty: false
    };
  }

  function replaceDocumentBaseRecord(updatedAt: number) {
    return {
      status: "ok" as const,
      data: {
        id: "doc-w3",
        mode: "region",
        title: "Region",
        width: 100,
        height: 100,
        createdAt: 0,
        updatedAt,
        dirty: false,
        basePath: "/w3/base.png",
        currentPath: "/w3/current.png",
        annotations: "[]"
      }
    };
  }

  it("surfaces a failed document save, then clears once a save succeeds again", async () => {
    const state = new EditorState();
    const persisted = persistedDocument();
    state.openCapture(persisted);
    revealInDirMock.mockResolvedValue({ status: "ok", data: null });
    replaceDocumentBaseMock.mockResolvedValue(replaceDocumentBaseRecord(1));

    expect(state.persistError).toBeNull();

    saveDocumentMock.mockRejectedValueOnce(new Error("disk full"));
    await state.revealCapture(persisted);

    expect(state.persistError).toBe("disk full");

    saveDocumentMock.mockResolvedValueOnce(replaceDocumentBaseRecord(2));
    await state.revealCapture(persisted);

    expect(state.persistError).toBeNull();
  });
});
