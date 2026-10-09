import { beforeEach, describe, expect, it, vi } from "vitest";

// A selection too large to be embedded in the document can still go to the OS
// clipboard. The size limit belongs to pasting into the screenshot, where the
// pixels become part of the saved document; copying out has no such limit.

vi.mock("./bindings", () => ({ commands: {} }));
vi.mock("./editorCommands", () => ({
  copyPngBytesToClipboard: vi.fn(),
  toAssetUrl: (path: string) => path,
  loadImage: vi.fn()
}));
vi.mock("./annotationRendering", async (original) => ({
  ...(await original<typeof import("./annotationRendering")>()),
  renderSelectionPng: vi.fn()
}));
const { EditorState } = await import("./editor.svelte");
const { renderSelectionPng } = await import("./annotationRendering");
const { copyPngBytesToClipboard } = await import("./editorCommands");

const rect = { x: 10, y: 20, width: 30, height: 40 };
// Valid base64 above the 7 MiB embed limit ("AAAA" decodes to three zero bytes).
const LARGE = "data:image/png;base64," + "AAAA".repeat(2 * 1024 * 1024);

function setup() {
  const state = new EditorState();
  state.openCapture({ mode: "region", title: "Synthetic", path: "/synthetic.png", assetUrl: "asset://synthetic.png", width: 200, height: 150 });
  state.activeTool = "region";
  state.regionRect = { ...rect };
  return state;
}

describe("copying a large selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(copyPngBytesToClipboard).mockResolvedValue({ status: "ok", data: null });
    vi.mocked(renderSelectionPng).mockResolvedValue(LARGE);
  });

  it("control: the fixture is above the embed limit", () => {
    expect(LARGE.length).toBeGreaterThan(7 * 1024 * 1024);
  });

  it("puts it on the OS clipboard", async () => {
    const state = setup();

    expect(await state.copyRegion()).toBeNull();

    expect(copyPngBytesToClipboard).toHaveBeenCalledOnce();
    const bytes = vi.mocked(copyPngBytesToClipboard).mock.calls[0][0];
    expect(bytes.length).toBe(6 * 1024 * 1024);
  });

  it("still refuses to paste it into the screenshot", async () => {
    const state = setup();
    await state.copyRegion();

    expect(state.pasteRegion()).toContain("too large");
    expect(state.annotations).toEqual([]);
    expect(state.historyPast).toEqual([]);
  });

  // A cut removes the pixels from the screenshot. If they could not be pasted
  // back, the cut would lose them, so it copies and leaves the image alone.
  it("copies but does not cut", async () => {
    const state = setup();

    expect(await state.copyRegion(true)).toContain("too large to cut");

    expect(copyPngBytesToClipboard).toHaveBeenCalledOnce();
    expect(state.annotations).toEqual([]);
    expect(state.historyPast).toEqual([]);
  });
});
