import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RecentCapture } from "./editor.svelte";

// Full mocks. Unlike editor.svelte.test.ts (which keeps annotationRendering real
// for its text-measurement assertion), these batch-export/drag tests never need
// the real renderer — and the real `renderFlattenedPng` rasterises on a DOM
// canvas, which doesn't exist under the `node` test environment. Mocking the
// whole module also sidesteps the partial-mock-leak sharp edge where a spread of
// `importActual` lets the real module reach the code under test.
vi.mock("./editorCommands", () => ({
  copyImageToClipboard: vi.fn(),
  copyPngBytesToClipboard: vi.fn(),
  createDocument: vi.fn(),
  cropCapture: vi.fn(),
  cutoutCapture: vi.fn(),
  deleteDocument: vi.fn(),
  listDocuments: vi.fn(),
  loadImage: vi.fn(),
  pickDirectory: vi.fn(),
  pickPngSavePath: vi.fn(),
  replaceDocumentBase: vi.fn(),
  revealInDir: vi.fn(),
  saveDocument: vi.fn(),
  savePngBytes: vi.fn(),
  savePngBytesNew: vi.fn(),
  startFileDrag: vi.fn(),
  toAssetUrl: (path: string) => `asset://${path}`
}));

vi.mock("./annotationRendering", () => ({
  arrowGeometry: vi.fn(),
  measureTextWidth: vi.fn(() => 0),
  renderFlattenedPng: vi.fn(),
  strokePath: vi.fn(() => ""),
  textStyle: vi.fn(() => "")
}));

const { EditorState } = await import("./editor.svelte");
const { pickDirectory, savePngBytesNew, startFileDrag } = await import("./editorCommands");
const { renderFlattenedPng } = await import("./annotationRendering");
const pickDirectoryMock = vi.mocked(pickDirectory);
const savePngBytesNewMock = vi.mocked(savePngBytesNew);
const startFileDragMock = vi.mocked(startFileDrag);
const renderFlattenedPngMock = vi.mocked(renderFlattenedPng);

function capture(path: string, title = path): RecentCapture {
  return {
    mode: "region",
    title,
    path,
    width: 100,
    height: 100,
    assetUrl: `asset://${path}`
  };
}

// Stateful savePngBytesNew mock mirroring the backend's create_new write against
// a virtual disk: the first write of a path succeeds (data: true); a repeat
// reports the name is taken (data: false), so the caller bumps the suffix.
// Returns the set of paths "written" for assertions.
function virtualDisk(): Set<string> {
  const written = new Set<string>();
  savePngBytesNewMock.mockImplementation(async (dest: string) => {
    if (written.has(dest)) return { status: "ok", data: false };
    written.add(dest);
    return { status: "ok", data: true };
  });
  return written;
}

describe("batch export", () => {
  beforeEach(() => {
    pickDirectoryMock.mockReset();
    savePngBytesNewMock.mockReset();
    renderFlattenedPngMock.mockReset();
    renderFlattenedPngMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
  });

  it("de-duplicates colliding slugs within a batch by bumping the suffix", async () => {
    const state = new EditorState();
    pickDirectoryMock.mockResolvedValue("/out");
    const written = virtualDisk();

    const message = await state.exportRecentCaptures([
      capture("/a.png", "Shot"),
      capture("/b.png", "Shot")
    ]);

    expect(written.has("/out/shot.png")).toBe(true);
    expect(written.has("/out/shot-2.png")).toBe(true);
    expect(message).toBe("Saved 2 images to /out.");
  });

  it("does not overwrite a file that already exists on disk", async () => {
    const state = new EditorState();
    pickDirectoryMock.mockResolvedValue("/out");
    const written = virtualDisk();
    written.add("/out/shot.png"); // folder already contains this name

    await state.exportRecentCaptures([capture("/a.png", "Shot"), capture("/b.png", "Other")]);

    // The colliding capture lands as shot-2.png instead of clobbering shot.png.
    expect(written.has("/out/shot-2.png")).toBe(true);
  });

  it("falls back to a generic name when a title has no usable characters", async () => {
    const state = new EditorState();
    pickDirectoryMock.mockResolvedValue("/out");
    const written = virtualDisk();

    await state.exportRecentCaptures([capture("/a.png", "***"), capture("/b.png", "Region 1")]);

    expect(written.has("/out/screenpick-capture.png")).toBe(true);
  });

  it("strips filesystem-unsafe characters from the slug", async () => {
    const state = new EditorState();
    pickDirectoryMock.mockResolvedValue("/out");
    const written = virtualDisk();

    await state.exportRecentCaptures([
      capture("/a.png", "Region: 1280x720 <draft>"),
      capture("/b.png", "Other")
    ]);

    const names = [...written].map((path) => path.replace("/out/", ""));
    expect(names).toContain("region-1280x720-draft.png");
    expect(names.some((name) => /[:<>"|?*\\/]/.test(name))).toBe(false);
  });

  it("reports a partial-failure summary when some writes fail", async () => {
    const state = new EditorState();
    pickDirectoryMock.mockResolvedValue("/out");
    savePngBytesNewMock.mockImplementation(async (dest: string) =>
      dest.includes("bad")
        ? { status: "error", error: "disk full" }
        : { status: "ok", data: true }
    );

    const message = await state.exportRecentCaptures([
      capture("/a.png", "good-1"),
      capture("/b.png", "bad"),
      capture("/c.png", "good-2")
    ]);

    expect(message).toBe("Saved 2 of 3 images; 1 failed (disk full).");
  });

  it("returns null and writes nothing when the folder picker is cancelled", async () => {
    const state = new EditorState();
    pickDirectoryMock.mockResolvedValue(null);

    const message = await state.exportRecentCaptures([
      capture("/a.png", "a"),
      capture("/b.png", "b")
    ]);

    expect(message).toBeNull();
    expect(savePngBytesNewMock).not.toHaveBeenCalled();
  });
});

describe("drag-out", () => {
  beforeEach(() => {
    startFileDragMock.mockReset();
    startFileDragMock.mockResolvedValue(undefined);
  });

  it("starts a native drag of the captures' file paths", () => {
    const state = new EditorState();

    const withCurrent: RecentCapture = { ...capture("/base.png"), currentPath: "/flat.png" };
    state.dragCaptures([withCurrent, capture("/plain.png")]);

    // Uses the flattened currentPath when present, base path otherwise; the
    // first file doubles as the drag-cursor icon.
    expect(startFileDragMock).toHaveBeenCalledWith(["/flat.png", "/plain.png"], "/flat.png");
  });

  it("does not start a drag when given no captures", () => {
    const state = new EditorState();
    state.dragCaptures([]);
    expect(startFileDragMock).not.toHaveBeenCalled();
  });
});
