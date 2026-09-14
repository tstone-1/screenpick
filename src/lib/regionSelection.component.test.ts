// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { annotationBounds, annotationsInPaintOrder, deserializeAnnotations, serializeAnnotations, translateAnnotation, type Annotation } from "./annotations";

vi.mock("./bindings", () => ({ commands: {} }));
vi.mock("./editorCommands", () => ({
  copyPngBytesToClipboard: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  toAssetUrl: (path: string) => path,
  loadImage: vi.fn()
}));
vi.mock("./annotationRendering", async (original) => ({
  ...await original<typeof import("./annotationRendering")>(),
  renderSelectionPng: vi.fn().mockResolvedValue("data:image/png;base64,AQID")
}));
const { EditorState } = await import("./editor.svelte");
const { renderSelectionPng } = await import("./annotationRendering");
const { copyPngBytesToClipboard } = await import("./editorCommands");

const rect = { x: 10, y: 20, width: 30, height: 40 };
function setup() {
  const state = new EditorState();
  state.openCapture({ mode: "region", title: "Synthetic", path: "/synthetic.png", assetUrl: "asset://synthetic.png", width: 200, height: 150 });
  state.activeTool = "region";
  state.regionRect = { ...rect };
  return state;
}

describe("rectangular selection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the client runtime with live state proxies", () => {
    const state = setup();
    state.regionRect = rect;
    expect(state.regionRect).not.toBe(rect);
  });

  it("copies the rendered rectangle to the clipboard and pastes a movable, persistent object", async () => {
    const state = setup();
    expect(await state.copyRegion()).toBeNull();
    expect(renderSelectionPng).toHaveBeenCalledWith(state.document!.capture, [], rect);
    expect(copyPngBytesToClipboard).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(state.annotations).toEqual([]);
    expect(state.pasteRegion()).toBeNull();
    expect(state.activeTool).toBe("select");
    expect(state.selectedAnnotationId).toBe(state.annotations[0].id);
    const restored = deserializeAnnotations(serializeAnnotations(state.annotations));
    expect(restored).toEqual(state.annotations);
    expect(annotationBounds(translateAnnotation(restored[0], 10, -5))).toEqual({ x: 36, y: 31, width: 30, height: 40 });
    state.undo();
    expect(state.annotations).toEqual([]);
    state.redo();
    expect(state.annotations).toEqual(restored);
  });

  it("cuts without resizing the screenshot and undoes paste and cut separately", async () => {
    const state = setup();
    await state.copyRegion(true);
    expect(state.annotations).toEqual([{ kind: "image", id: expect.any(Number), rect, dataUrl: null }]);
    expect(state.document!.capture.width).toBe(200);
    state.pasteRegion();
    expect(state.annotations).toHaveLength(2);
    state.undo();
    expect(state.annotations).toHaveLength(1);
    state.undo();
    expect(state.annotations).toEqual([]);
  });

  it("leaves source and history unchanged when the clipboard rejects the copy", async () => {
    const state = setup();
    vi.mocked(copyPngBytesToClipboard).mockResolvedValueOnce({ status: "error", error: "Clipboard busy" });
    expect(await state.copyRegion(true)).toBe("Clipboard busy");
    expect(state.annotations).toEqual([]);
    expect(state.historyPast).toEqual([]);
    expect(state.regionClipboard).toBeNull();
    expect(state.regionPending).toBe(false);
  });

  it.each(["switch", "edit", "escape"])("does not cut stale pixels after %s during rendering", async (change) => {
    const state = setup();
    let resolve!: (value: string) => void;
    vi.mocked(renderSelectionPng).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const work = state.copyRegion(true);
    if (change === "switch") state.openCapture({ ...state.document!.capture, path: "/other.png" });
    if (change === "edit") state.annotations = [{ kind: "blur", id: 99, rect, radius: 5 }];
    if (change === "escape") state.cancelActiveGesture();
    resolve("data:image/png;base64,AQID");
    expect(await work).toContain("cut was cancelled");
    expect(state.annotations.some((a) => a.kind === "image")).toBe(false);
  });

  it("rejects an oversized paste without changing history", () => {
    const state = setup();
    state.regionClipboard = { rect, dataUrl: "data:image/png;base64," + "A".repeat(8 * 1024 * 1024) };
    expect(state.pasteRegion()).toContain("too large");
    expect(state.annotations).toEqual([]);
    expect(state.historyPast).toEqual([]);
  });

  it("paints pasted pixels over old text and new annotations over the pasted pixels", () => {
    const text: Annotation = { kind: "text", id: 1, position: { x: 1, y: 1 }, text: "Synthetic", color: "#000000", fontSize: 12, background: false, backgroundOpacity: 0 };
    const image: Annotation = { kind: "image", id: 2, rect, dataUrl: "data:image/png;base64,AQID" };
    const pen: Annotation = { kind: "pen", id: 3, points: [{ x: 1, y: 1 }], color: "#ff0000", width: 2 };
    expect(annotationsInPaintOrder([text, image, pen]).map((a) => a.id)).toEqual([1, 2, 3]);
  });

  it.each(["https://example.invalid/image.png", "data:image/svg+xml;base64,AQID", undefined])("rejects non-PNG image sources on restore: %s", (dataUrl) => {
    expect(deserializeAnnotations(JSON.stringify([{ kind: "image", id: 1, rect, dataUrl }]))).toEqual([]);
  });
});
