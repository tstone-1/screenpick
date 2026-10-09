import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Annotation, RecentCapture } from "./editor.svelte";

// What undo and redo leave behind outside the annotation layer: the Recent
// strip entry of the open document, and the view (zoom and pan).
//
// Every match in here is by documentId or path, never by object identity, so
// the default node environment is enough (see AGENTS.md on `$state` proxies).

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

vi.mock("./bindings", () => ({ commands: commandsMock }));

vi.mock("./editorCommands", () => ({
  copyPngBytesToClipboard: vi.fn(),
  loadImage: vi.fn(),
  pickDirectory: vi.fn(),
  pickPngSavePath: vi.fn(),
  saveDocument: vi.fn(),
  savePngBytes: vi.fn(),
  savePngBytesNew: vi.fn(),
  startFileDrag: vi.fn(),
  toAssetUrl: (path: string) => `asset://${path}`
}));

vi.mock("./annotationRendering", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./annotationRendering")>();
  return { ...actual, renderFlattenedPng: vi.fn() };
});

const { EditorState } = await import("./editor.svelte");
const { pickDirectory, pickPngSavePath, saveDocument, savePngBytes, savePngBytesNew } =
  await import("./editorCommands");
const { renderFlattenedPng } = await import("./annotationRendering");
const renderMock = vi.mocked(renderFlattenedPng);
const saveDocumentMock = vi.mocked(saveDocument);

const BASE = "/doc/base.png";
const CROPPED = "/doc/cropped.png";
const CUT = "/doc/cut.png";

function persisted(): RecentCapture {
  return {
    mode: "region",
    title: "Original",
    path: BASE,
    width: 100,
    height: 100,
    assetUrl: `asset://${BASE}`,
    documentId: "doc-1",
    currentPath: "/doc/current.png",
    dirty: false
  };
}

const highlight: Annotation = {
  kind: "highlight",
  id: 1,
  rect: { x: 60, y: 60, width: 10, height: 10 },
  color: "#ffff00",
  opacity: 0.35
};

function record(id: string, annotations: string, dirty: boolean, updatedAt: number) {
  return {
    id,
    mode: "region",
    title: "Region",
    width: 0,
    height: 0,
    createdAt: 0,
    updatedAt,
    dirty,
    basePath: BASE,
    currentPath: "/doc/current.png",
    annotations
  };
}

async function settle(state: InstanceType<typeof EditorState>) {
  await state.flushPendingSave();
}

beforeEach(() => {
  vi.clearAllMocks();
  let updatedAt = 1;
  commandsMock.replaceDocumentBase.mockImplementation(async (id: string) => ({
    status: "ok",
    data: record(id, "[]", false, updatedAt++)
  }));
  saveDocumentMock.mockImplementation(
    async (id: string, annotations: string, _bytes: unknown, dirty: boolean) =>
      ({ status: "ok", data: record(id, annotations, dirty, updatedAt++) }) as never
  );
  renderMock.mockResolvedValue(new Uint8Array());
  commandsMock.cropCapture.mockResolvedValue({
    status: "ok",
    data: { mode: "region", title: "Cropped", path: CROPPED, width: 50, height: 40 }
  });
  commandsMock.cutoutCapture.mockResolvedValue({
    status: "ok",
    data: { mode: "region", title: "Cut", path: CUT, width: 100, height: 80 }
  });
  vi.mocked(pickPngSavePath).mockResolvedValue("/out.png");
  vi.mocked(savePngBytes).mockResolvedValue({ status: "ok", data: null } as never);
  vi.mocked(pickDirectory).mockResolvedValue("/out");
  vi.mocked(savePngBytesNew).mockResolvedValue({ status: "ok", data: true } as never);
});

async function croppedState() {
  const state = new EditorState();
  await seedStrip(state);
  state.annotations = [highlight];
  state.cropRect = { x: 50, y: 50, width: 50, height: 40 };
  await state.applyCrop();
  await settle(state);
  return state;
}

// Strip order after seeding: [Original, Other]. Both are persisted documents,
// loaded the way startup loads them.
async function seedStrip(state: InstanceType<typeof EditorState>) {
  commandsMock.listDocuments.mockResolvedValue({
    status: "ok",
    data: [
      { ...record("doc-1", "[]", false, 2), title: "Original", width: 100, height: 100 },
      {
        ...record("doc-2", "[]", false, 1),
        title: "Other",
        width: 30,
        height: 30,
        basePath: "/other/base.png",
        currentPath: "/other/current.png"
      }
    ]
  });
  await state.loadPersistedDocuments();
  const original = state.recentCaptures.find((entry) => entry.documentId === "doc-1");
  if (!original) throw new Error("seeding did not produce doc-1");
  state.openCapture(original);
}

function stripEntry(state: InstanceType<typeof EditorState>, documentId = "doc-1"): RecentCapture {
  const entry = state.recentCaptures.find((candidate) => candidate.documentId === documentId);
  if (!entry) throw new Error(`no strip entry for ${documentId}`);
  return entry;
}

describe("Recent strip entry across undo and redo", () => {
  it("control: a crop puts the cropped image into the strip entry", async () => {
    const state = await croppedState();

    expect(stripEntry(state).path).toBe(CROPPED);
    expect(state.recentCaptures.filter((entry) => entry.documentId === "doc-1")).toHaveLength(1);
  });

  it("undo across a crop puts the pre-crop image back into the strip entry", async () => {
    const state = await croppedState();
    const orderBefore = state.recentCaptures.map((entry) => entry.documentId);

    state.undo();

    const entry = stripEntry(state);
    expect(entry.path).toBe(state.currentCapture?.path);
    expect([entry.width, entry.height, entry.title]).toEqual([
      state.currentCapture?.width,
      state.currentCapture?.height,
      state.currentCapture?.title
    ]);
    expect(entry.width).toBe(100);
    // In place: an undo is not a new capture and must not move the entry.
    expect(state.recentCaptures.map((candidate) => candidate.documentId)).toEqual(orderBefore);
  });

  it("redo puts the cropped image back", async () => {
    const state = await croppedState();
    state.undo();

    state.redo();

    const entry = stripEntry(state);
    expect([entry.path, entry.width, entry.height]).toEqual([CROPPED, 50, 40]);
  });

  it("undo across a cut puts the pre-cut image back into the strip entry", async () => {
    const state = new EditorState();
    await seedStrip(state);
    state.annotations = [highlight];
    state.cutBand = { x: 0, y: 40, width: 100, height: 20 };
    await state.applyCut();
    await settle(state);
    expect(stripEntry(state).path).toBe(CUT);

    state.undo();

    const entry = stripEntry(state);
    expect([entry.path, entry.width, entry.height]).toEqual([BASE, 100, 100]);
  });

  it("keeps the entry's saved-state fields when the image is put back", async () => {
    const state = await croppedState();
    const afterCrop = stripEntry(state);

    state.undo();

    // The snapshot predates the crop's save; its copy of these is older.
    const entry = stripEntry(state);
    expect(entry.currentPath).toBe(afterCrop.currentPath);
    expect(entry.thumbnailRevision).toBe(afterCrop.thumbnailRevision);
  });

  it("does not touch another document's entry", async () => {
    const state = await croppedState();
    const before = { ...stripEntry(state, "doc-2") };

    state.undo();

    expect(stripEntry(state, "doc-2")).toEqual(before);
  });
});

describe("export from the strip after undo across a crop", () => {
  it("renders the image the editor shows, with its annotations", async () => {
    const state = await croppedState();
    state.undo();
    await settle(state);
    renderMock.mockClear();

    await state.exportRecentCapture(stripEntry(state));

    const [capture, annotations] = renderMock.mock.calls[0];
    expect([capture.path, capture.width, capture.height]).toEqual([BASE, 100, 100]);
    expect(annotations).toEqual([highlight]);
  });

  // The second line of defence: an entry object the caller still holds from
  // before the undo (a context menu opened earlier) names the open document,
  // so it is exported as the open document.
  it("exports the open document for a stale entry of it", async () => {
    const state = await croppedState();
    const stale = { ...stripEntry(state) };
    state.undo();
    await settle(state);
    renderMock.mockClear();

    await state.exportRecentCapture(stale);

    expect(renderMock.mock.calls[0][0].path).toBe(BASE);
  });

  it("batch export does the same, and leaves the other capture alone", async () => {
    const state = await croppedState();
    const stale = { ...stripEntry(state) };
    state.undo();
    await settle(state);
    renderMock.mockClear();

    await state.exportRecentCaptures([stale, stripEntry(state, "doc-2")]);

    expect(renderMock.mock.calls.map(([capture]) => capture.path)).toEqual([
      BASE,
      "/other/base.png"
    ]);
  });
});

describe("view across undo and redo", () => {
  function annotatedTwice() {
    const state = new EditorState();
    state.openCapture(persisted());
    state.annotations = [highlight, { ...highlight, id: 2 }];
    // First history step at the fit view.
    state.selectedAnnotationId = 2;
    state.deleteSelectedAnnotation();
    return state;
  }

  it("undo of an annotation keeps the zoom and pan the user has now", () => {
    const state = annotatedTwice();
    state.setEditorZoom(2);
    state.panBy(15, -7);
    // Second history step at the zoomed view.
    state.selectedAnnotationId = 1;
    state.deleteSelectedAnnotation();

    state.undo();
    state.undo();

    expect(state.annotations).toHaveLength(2);
    expect(state.document).toMatchObject({ zoom: 2, mode: "custom", panX: 15, panY: -7 });
  });

  it("redo keeps them too", () => {
    const state = annotatedTwice();
    state.undo();
    state.setEditorZoom(2);
    state.panBy(15, -7);

    state.redo();

    expect(state.annotations).toHaveLength(1);
    expect(state.document).toMatchObject({ zoom: 2, mode: "custom", panX: 15, panY: -7 });
  });

  // A crop changes the image size, so the zoom that suited the cropped image
  // does not suit the original: there the snapshot's view is the right one.
  it("undo across a crop restores the view the pre-crop image had", async () => {
    const state = new EditorState();
    state.openCapture(persisted());
    state.setEditorZoom(0.5);
    state.panBy(3, 4);
    state.cropRect = { x: 50, y: 50, width: 50, height: 40 };
    await state.applyCrop();
    await settle(state);
    state.setEditorZoom(3);

    state.undo();

    expect(state.document).toMatchObject({ zoom: 0.5, mode: "custom", panX: 3, panY: 4 });
  });
});
