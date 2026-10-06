// @vitest-environment jsdom
//
// The jsdom docblock above is load-bearing, and it is the whole point of this
// file existing separately from editor.svelte.test.ts.
//
// Under the suite's default `environment: "node"`, `.svelte.ts` modules are
// compiled in SSR mode: `$state` is a plain value, nothing is proxied, and
// `stateHeldObject === rawObject` is true. Under jsdom the client runtime is
// used, `$state` deep-proxies, and that comparison is ALWAYS false — a proxy
// is never `===` to the object it wraps, and two `$state` fields holding the
// same object hand out two different proxies.
//
// EditorState#attachDocumentIdentity used to match the just-created document
// against the open capture with `capture === original`. That passed every
// node-mode test and could never be true in the app, so every capture kept a
// null documentId, every annotation save and crop re-base returned before
// touching disk, and dragging the capture out handed over the un-annotated
// original (the fault 26.9.0 instrumented and this test pins).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RecentCapture } from "./editor.svelte";

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
  pickPngSavePath: vi.fn(),
  saveDocument: vi.fn(),
  savePngBytes: vi.fn(),
  toAssetUrl: (path: string) => `asset://${path}`
}));

const logWarnMock = vi.hoisted(() => vi.fn());
vi.mock("./diagnosticsLog", () => ({
  logWarn: logWarnMock,
  logError: vi.fn(),
  logInfo: vi.fn()
}));

vi.mock("./annotationRendering", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./annotationRendering")>();
  return { ...actual, renderFlattenedPng: vi.fn().mockResolvedValue(new Uint8Array()) };
});

const { EditorState } = await import("./editor.svelte");
const { saveDocument } = await import("./editorCommands");
const saveDocumentMock = vi.mocked(saveDocument);

function capture(path: string): RecentCapture {
  return {
    mode: "window",
    title: "Some Window",
    path,
    width: 200,
    height: 100,
    assetUrl: `asset://${path}`
  };
}

function record(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    mode: "window",
    title: "Some Window",
    width: 200,
    height: 100,
    createdAt: 1,
    updatedAt: 1,
    dirty: false,
    basePath: `store/${id}/base.png`,
    currentPath: `store/${id}/current.png`,
    annotations: "[]",
    ...patch
  };
}

// #createDocumentFor is fire-and-forget (`void`), so the ingest call returns
// before create_document resolves. Two microtask turns is enough for the
// awaited IPC and the attach that follows it.
async function settleCreate(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("document identity survives Svelte's state proxies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // The control for every test below, and the reason it is first: those tests
  // are about identity, so they are only meaningful where `$state` actually
  // proxies. Run this file in the `node` environment and Svelte compiles in
  // SSR mode, `$state` becomes a plain value, and each of them passes against
  // code that is broken in the app — measured, not assumed. Nothing else would
  // report that: the docblock at the top of this file is a comment, so a typo
  // in it, a Vitest change to how per-file environments are selected, or a
  // config edit downgrades this whole file to decoration, silently and while
  // staying green.
  //
  // `openCapture` puts this exact object into a `$state` field. Reading it back
  // under the client runtime yields a proxy — a different object wrapping the
  // same capture — which is the entire fault this file exists for. If this
  // assertion ever fails, the environment is wrong, not the editor.
  it("runs under the client runtime, where $state proxies", () => {
    const editor = new EditorState();
    const raw = capture("environment-control.png");

    editor.openCapture(raw);

    expect(editor.document?.capture).not.toBe(raw);
    expect(editor.document?.capture.path).toBe(raw.path);
  });

  it("attaches the new document's id to the open capture", async () => {
    commandsMock.createDocument.mockResolvedValue({ status: "ok", data: record("doc-1") });
    const editor = new EditorState();

    editor.ingestCompleted(capture("shot-1.png"));
    await settleCreate();

    expect(editor.document?.capture.documentId).toBe("doc-1");
    expect(editor.document?.capture.currentPath).toBe("store/doc-1/current.png");
    expect(editor.currentCapture?.documentId).toBe("doc-1");
    expect(editor.recentCaptures[0]?.documentId).toBe("doc-1");
    // The tripwire that reported this fault in the field must stay silent on
    // the healthy path, or it says nothing when it fires.
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it("still attaches when the capture is ingested without opening the editor", async () => {
    commandsMock.createDocument.mockResolvedValue({ status: "ok", data: record("doc-2") });
    const editor = new EditorState();

    editor.ingestWithoutOpening(capture("shot-2.png"));
    await settleCreate();

    expect(editor.recentCaptures[0]?.documentId).toBe("doc-2");
  });

  // The reported flow, end to end: capture, crop, draw, and the crop's
  // re-base plus the annotation save both have to reach disk. A crop is the
  // cheapest probe because applyCrop persists unconditionally on success (see
  // AGENTS.md), so a skipped save shows up with no annotation involved.
  it("carries the identity through a crop and an annotation save", async () => {
    commandsMock.createDocument.mockResolvedValue({ status: "ok", data: record("doc-3") });
    commandsMock.replaceDocumentBase.mockResolvedValue({
      status: "ok",
      data: record("doc-3", { basePath: "store/doc-3/base.png" })
    });
    saveDocumentMock.mockResolvedValue({
      status: "ok",
      data: record("doc-3", { dirty: true })
    } as never);
    const editor = new EditorState();

    editor.ingestCompleted(capture("shot-3.png"));
    await settleCreate();

    editor.cropRect = { x: 10, y: 10, width: 50, height: 40 };
    commandsMock.cropCapture.mockResolvedValue({
      status: "ok",
      data: {
        mode: "window",
        title: "Some Window",
        path: "shot-3-cropped.png",
        width: 50,
        height: 40
      }
    });
    await editor.applyCrop();
    // applyCrop's persist (replaceBase=true) is fire-and-forget.
    await vi.waitFor(() => expect(saveDocumentMock).toHaveBeenCalled());

    expect(commandsMock.replaceDocumentBase).toHaveBeenLastCalledWith(
      "doc-3",
      "shot-3-cropped.png",
      expect.any(String),
      50,
      40
    );
    expect(saveDocumentMock.mock.calls[0]?.[0]).toBe("doc-3");
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it("does not re-stamp a capture that already carries a different document id", async () => {
    commandsMock.createDocument.mockResolvedValue({ status: "ok", data: record("doc-4") });
    const editor = new EditorState();

    editor.ingestCompleted(capture("shot-4.png"));
    await settleCreate();
    expect(editor.document?.capture.documentId).toBe("doc-4");

    // A second create resolving for the same path (a duplicated ingest) must
    // not overwrite the identity the capture already has.
    commandsMock.createDocument.mockResolvedValue({ status: "ok", data: record("doc-5") });
    editor.ingestWithoutOpening(capture("shot-4.png"));
    await settleCreate();

    expect(editor.document?.capture.documentId).toBe("doc-4");
  });
});

// A capture is unsaveable until create_document resolves, roughly 40 ms after
// it appears on screen. These pin what happens to work started inside that
// window — the crop case is the sharp one, because rebasedCapture copies the
// documentId forward, so a crop that starts too early produces a capture with
// no id at a path the arriving record can no longer match: unsaveable forever,
// not merely for 40 ms.
describe("work started before create_document resolves", () => {
  // A create_document call whose resolution this test controls, keyed by the
  // source path so overlapping captures can be released independently.
  function deferredCreates() {
    const resolvers = new Map<string, (value: unknown) => void>();
    commandsMock.createDocument.mockImplementation(
      (sourcePath: string) =>
        new Promise((resolve) => {
          resolvers.set(sourcePath, resolve);
        })
    );
    return {
      release(sourcePath: string, id: string) {
        const resolve = resolvers.get(sourcePath);
        if (!resolve) throw new Error(`no create in flight for ${sourcePath}`);
        resolve({ status: "ok", data: record(id, { basePath: `store/${id}/base.png` }) });
      }
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("a crop started inside the window still re-bases the document", async () => {
    const creates = deferredCreates();
    commandsMock.cropCapture.mockResolvedValue({
      status: "ok",
      data: {
        mode: "window",
        title: "Some Window",
        path: "shot-6-cropped.png",
        width: 50,
        height: 40
      }
    });
    commandsMock.replaceDocumentBase.mockImplementation(async () => ({
      status: "ok",
      data: record("doc-6", { basePath: "store/doc-6/base.png" })
    }));
    saveDocumentMock.mockResolvedValue({
      status: "ok",
      data: record("doc-6", { dirty: true })
    } as never);
    const editor = new EditorState();

    editor.ingestCompleted(capture("shot-6.png"));
    // No settleCreate() here: the create is deliberately still in flight, which
    // is the whole point of this test.
    editor.cropRect = { x: 10, y: 10, width: 50, height: 40 };
    const cropping = editor.applyCrop();

    creates.release("shot-6.png", "doc-6");
    await cropping;
    await vi.waitFor(() => expect(saveDocumentMock).toHaveBeenCalled());

    expect(editor.document?.capture.path).toBe("shot-6-cropped.png");
    expect(editor.document?.capture.documentId).toBe("doc-6");
    expect(commandsMock.replaceDocumentBase).toHaveBeenLastCalledWith(
      "doc-6",
      "shot-6-cropped.png",
      expect.any(String),
      50,
      40
    );
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it("flushPendingSave writes an annotation drawn inside the window", async () => {
    // The exit handshake calls flushPendingSave and then lets the process go.
    // Nothing arms the debounce timer inside the window (#scheduleDocumentSave
    // needs a documentId), so without waiting for the create there is no
    // pending work to find and the annotation dies with the process.
    const creates = deferredCreates();
    saveDocumentMock.mockResolvedValue({
      status: "ok",
      data: record("doc-7", { dirty: true })
    } as never);
    const editor = new EditorState();

    editor.ingestCompleted(capture("shot-7.png"));
    editor.annotations = [
      {
        kind: "pen",
        id: 1,
        points: [
          { x: 1, y: 1 },
          { x: 5, y: 5 }
        ],
        color: "#ff0000",
        width: 3
      }
    ];

    const flushing = editor.flushPendingSave();
    creates.release("shot-7.png", "doc-7");
    await flushing;

    expect(saveDocumentMock).toHaveBeenCalledTimes(1);
    expect(saveDocumentMock.mock.calls[0]?.[0]).toBe("doc-7");
  });

  it("waits for its own capture's create, not another one still in flight", async () => {
    // Why #pendingCreates is a map: two captures in quick succession overlap,
    // and a crop on the second must not be released by the first's record (nor
    // hang waiting for a create that belongs to a capture nobody is editing).
    const creates = deferredCreates();
    commandsMock.cropCapture.mockResolvedValue({
      status: "ok",
      data: {
        mode: "window",
        title: "Some Window",
        path: "shot-9-cropped.png",
        width: 50,
        height: 40
      }
    });
    commandsMock.replaceDocumentBase.mockImplementation(async () => ({
      status: "ok",
      data: record("doc-9", { basePath: "store/doc-9/base.png" })
    }));
    saveDocumentMock.mockResolvedValue({
      status: "ok",
      data: record("doc-9", { dirty: true })
    } as never);
    const editor = new EditorState();

    editor.ingestCompleted(capture("shot-8.png"));
    editor.ingestCompleted(capture("shot-9.png"));
    editor.cropRect = { x: 10, y: 10, width: 50, height: 40 };
    const cropping = editor.applyCrop();

    // Only the open capture's create is released; shot-8's stays in flight.
    creates.release("shot-9.png", "doc-9");
    await cropping;

    expect(editor.document?.capture.documentId).toBe("doc-9");
    expect(editor.document?.capture.path).toBe("shot-9-cropped.png");
  });
});

describe("asynchronous persistence invariants", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    commandsMock.replaceDocumentBase.mockImplementation(async (id: string) => ({
      status: "ok", data: record(id)
    }));
    saveDocumentMock.mockImplementation(async (id: string) => ({
      status: "ok", data: record(id)
    }) as never);
  });

  afterEach(() => vi.useRealTimers());

  async function turns() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  function note(editor: InstanceType<typeof EditorState>) {
    editor.textDraft = {
      kind: "text", id: 1, position: { x: 5, y: 5 }, text: "must survive",
      color: "#ff0000", fontSize: 16, background: false, backgroundOpacity: 0.5
    };
    editor.commitTextDraft();
  }

  function expectSaved(id: string) {
    expect(saveDocumentMock.mock.calls.some(
      call => call[0] === id && call[1].includes("must survive")
    )).toBe(true);
  }

  async function create(editor: InstanceType<typeof EditorState>, path: string, id: string) {
    commandsMock.createDocument.mockResolvedValue({ status: "ok", data: record(id) });
    editor.ingestCompleted(capture(path));
    await turns();
  }

  function deferredCreate() {
    let release!: (result: unknown) => void;
    commandsMock.createDocument.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    return (id: string) => release({ status: "ok", data: record(id) });
  }

  it("saves annotations when flushed in place", async () => {
    const editor = new EditorState();
    await create(editor, "control.png", "control");
    note(editor);
    await editor.flushPendingSave();
    expectSaved("control");
  });

  it.each([false, true])("switching during debounce persists the outgoing document (pending create: %s)", async (pending) => {
    const editor = new EditorState();
    const release = deferredCreate();
    if (pending) editor.ingestCompleted(capture("first.png"));
    else await create(editor, "first.png", "first");
    note(editor);
    editor.openCapture({ ...capture("second.png"), documentId: "second" });
    const flushing = editor.flushPendingSave();
    if (pending) release("first");
    await flushing;
    await vi.advanceTimersByTimeAsync(1000);
    expectSaved("first");
    expect(saveDocumentMock.mock.calls.some(call => call[0] === "second")).toBe(false);
  });

  it.each(["crop", "cut"] as const)("finishing a %s after switching never changes the new document", async (tool) => {
    const editor = new EditorState();
    await create(editor, "first.png", "first");
    let release!: (result: unknown) => void;
    const command = tool === "crop" ? commandsMock.cropCapture : commandsMock.cutoutCapture;
    command.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    editor.cropRect = { x: 0, y: 0, width: 50, height: 40 };
    editor.cutBand = { x: 0, y: 10, width: 200, height: 40 };
    const finishing = tool === "crop" ? editor.applyCrop() : editor.applyCut();
    editor.openCapture({ ...capture("second.png"), documentId: "second" });
    const before = JSON.stringify({ annotations: editor.annotations, history: editor.historyPast });
    release({ status: "ok", data: { ...capture("first-transformed.png"), width: 50, height: 40 } });
    await finishing;
    await turns();
    expect(commandsMock.replaceDocumentBase).not.toHaveBeenCalled();
    expect(editor.document?.capture.path).toBe("second.png");
    expect(JSON.stringify({ annotations: editor.annotations, history: editor.historyPast })).toBe(before);
  });

  it.each(["crop", "cut"] as const)("discards a %s if the user edits while creation is still pending", async (tool) => {
    const editor = new EditorState();
    const release = deferredCreate();
    editor.ingestCompleted(capture("early.png"));
    const command = tool === "crop" ? commandsMock.cropCapture : commandsMock.cutoutCapture;
    command.mockResolvedValue({
      status: "ok", data: { ...capture("early-transformed.png"), width: 50, height: 40 }
    });
    editor.cropRect = { x: 0, y: 0, width: 50, height: 40 };
    editor.cutBand = { x: 0, y: 10, width: 200, height: 40 };
    const finishing = tool === "crop" ? editor.applyCrop() : editor.applyCut();
    await turns(); // The IPC finished; now blocked on creation.
    note(editor);
    release("early");
    await finishing;
    await editor.flushPendingSave();
    expect(editor.document?.capture.path).toBe("early.png");
    expect(commandsMock.replaceDocumentBase).not.toHaveBeenCalled();
    expectSaved("early");
  });

  it.each(["crop", "cut"] as const)("undo while a %s is pending discards its stale result", async (tool) => {
    const editor = new EditorState();
    await create(editor, "first.png", "first");
    note(editor); // Gives undo something to step back over.
    let release!: (result: unknown) => void;
    const command = tool === "crop" ? commandsMock.cropCapture : commandsMock.cutoutCapture;
    command.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    editor.cropRect = { x: 0, y: 0, width: 50, height: 40 };
    editor.cutBand = { x: 0, y: 10, width: 200, height: 40 };
    const finishing = tool === "crop" ? editor.applyCrop() : editor.applyCut();
    editor.undo();
    expect(editor.annotations).toHaveLength(0);
    release({ status: "ok", data: { ...capture("first-transformed.png"), width: 50, height: 40 } });
    await finishing;
    await turns();
    expect(commandsMock.replaceDocumentBase).not.toHaveBeenCalled();
    expect(editor.document?.capture.path).toBe("first.png");
    expect(editor.annotations).toHaveLength(0);
  });

  // N6: a capture closed while its create_document is in flight has no
  // documentId to delete by, so the record that arrives afterwards must be
  // deleted on arrival or it reappears at the next launch.
  it("closing a capture while its create is in flight deletes the document it creates", async () => {
    commandsMock.deleteDocument.mockResolvedValue({ status: "ok", data: null });
    const editor = new EditorState();
    const release = deferredCreate();
    const fresh = editor.ingestCompleted(capture("closing.png"));
    editor.closeDocument(fresh);
    release("closing");
    await turns();
    expect(editor.recentCaptures).toHaveLength(0);
    expect(editor.document).toBeNull();
    expect(commandsMock.deleteDocument).toHaveBeenCalledWith("closing");
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it("does not delete a created document whose capture is still open", async () => {
    commandsMock.deleteDocument.mockResolvedValue({ status: "ok", data: null });
    const editor = new EditorState();
    await create(editor, "kept.png", "kept");
    expect(editor.document?.capture.documentId).toBe("kept");
    expect(commandsMock.deleteDocument).not.toHaveBeenCalled();
  });

  it.each(["crop", "cut"] as const)("undo after early %s retains identity and saves subsequent edits", async (tool) => {
    const editor = new EditorState();
    const release = deferredCreate();
    editor.ingestCompleted(capture("early.png"));
    const command = tool === "crop" ? commandsMock.cropCapture : commandsMock.cutoutCapture;
    command.mockResolvedValue({
      status: "ok", data: { ...capture("early-transformed.png"), width: 50, height: 40 }
    });
    editor.cropRect = { x: 0, y: 0, width: 50, height: 40 };
    editor.cutBand = { x: 0, y: 10, width: 200, height: 40 };
    const finishing = tool === "crop" ? editor.applyCrop() : editor.applyCut();
    release("early");
    await finishing;
    await turns();
    expect(editor.document?.capture.documentId).toBe("early");
    expect(editor.document?.capture.path).toBe("early-transformed.png");
    editor.undo();
    expect(editor.document?.capture.documentId).toBe("early");
    expect(editor.document?.capture.path).toBe("early.png");
    note(editor);
    await editor.flushPendingSave();
    expectSaved("early");
    expect(commandsMock.replaceDocumentBase).toHaveBeenLastCalledWith(
      "early", "early.png", expect.any(String), 200, 100
    );
  });

  it("reopening a workspace cached during create retains identity and can save", async () => {
    const editor = new EditorState();
    const release = deferredCreate();
    editor.ingestCompleted(capture("cached.png"));
    editor.openCapture(capture("other.png"));
    release("cached");
    await turns();
    expect(editor.recentCaptures[0]?.documentId).toBe("cached");
    editor.openCapture(editor.recentCaptures[0]);
    expect(editor.document?.capture.documentId).toBe("cached");
    note(editor);
    await editor.flushPendingSave();
    expectSaved("cached");
  });
});

// Select-drag and object-erase record history once, on their first effective
// move, and that is the only point that arms the save debounce. A gesture that
// outlasts the debounce persists its mid-gesture state and then keeps changing
// `annotations` with no timer armed, so ending the gesture must schedule one
// more save. Every test here spans the debounce inside ONE gesture, which no
// other test does.
describe("a gesture that outlasts the save debounce", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    commandsMock.replaceDocumentBase.mockImplementation(async (id: string) => ({
      status: "ok", data: record(id)
    }));
    commandsMock.deleteDocument.mockResolvedValue({ status: "ok", data: null });
    saveDocumentMock.mockImplementation(async (id: string) => ({
      status: "ok", data: record(id)
    }) as never);
  });

  afterEach(() => vi.useRealTimers());

  type Editor = InstanceType<typeof EditorState>;

  async function turns() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  async function create(editor: Editor, path: string, id: string) {
    commandsMock.createDocument.mockResolvedValue({ status: "ok", data: record(id) });
    editor.ingestCompleted(capture(path));
    await turns();
    editor.imageFrame = {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      getBoundingClientRect: () => ({
        left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, x: 0, y: 0, toJSON: () => ({})
      })
    } as unknown as HTMLDivElement;
  }

  function pointer(clientX: number, clientY: number): PointerEvent {
    return { button: 0, clientX, clientY, pointerId: 1, preventDefault: vi.fn() } as unknown as PointerEvent;
  }

  // A filled 40x40 shape; placing it selects it and arms the Select tool.
  function placeShape(editor: Editor, x = 20) {
    editor.shapeFill = true;
    editor.activeTool = "shape";
    editor.startShapeDrag(pointer(x, 20));
    editor.updateShapeDrag(pointer(x + 40, 60));
    editor.finishShapeDrag(pointer(x + 40, 60));
  }

  function lastSavedLayer(id: string): string {
    const calls = saveDocumentMock.mock.calls.filter((call) => call[0] === id);
    return calls.at(-1)?.[1] ?? "<never saved>";
  }

  it("control: a drag inside the debounce saves its final position", async () => {
    const editor = new EditorState();
    await create(editor, "short.png", "short");
    placeShape(editor);
    await editor.flushPendingSave();
    editor.startSelectionDrag(pointer(40, 40));
    editor.updateSelectionDrag(pointer(50, 40));
    editor.updateSelectionDrag(pointer(70, 40));
    editor.finishSelectionDrag(pointer(70, 40));
    await vi.advanceTimersByTimeAsync(2000);
    await editor.flushPendingSave();
    expect(editor.annotations[0]).toMatchObject({ rect: { x: 50 } });
    expect(lastSavedLayer("short")).toContain('"x":50');
  });

  it("saves the final position of a drag that outlasts the debounce", async () => {
    const editor = new EditorState();
    await create(editor, "long.png", "long");
    placeShape(editor);
    await editor.flushPendingSave();
    editor.startSelectionDrag(pointer(40, 40));
    editor.updateSelectionDrag(pointer(50, 40)); // The first move arms the debounce.
    await vi.advanceTimersByTimeAsync(600); // It fires mid-drag.
    editor.updateSelectionDrag(pointer(70, 40));
    editor.finishSelectionDrag(pointer(70, 40));
    await editor.flushPendingSave(); // What the exit handshake runs.
    expect(editor.annotations[0]).toMatchObject({ rect: { x: 50 } });
    expect(lastSavedLayer("long")).toContain('"x":50');
  });

  it("saves every removal of an erase gesture that outlasts the debounce", async () => {
    const editor = new EditorState();
    await create(editor, "erase.png", "erase");
    placeShape(editor, 20);
    placeShape(editor, 120);
    await editor.flushPendingSave();
    expect(editor.annotations).toHaveLength(2);
    editor.activeTool = "erase";
    editor.startErase(pointer(40, 40)); // Removes the first and arms the debounce.
    await vi.advanceTimersByTimeAsync(600);
    editor.updateErase(pointer(140, 40)); // Removes the second.
    editor.finishErase(pointer(140, 40));
    await editor.flushPendingSave();
    expect(editor.annotations).toHaveLength(0);
    expect(lastSavedLayer("erase")).not.toContain('"kind":"shape"');
  });

  it("writes the final position of a long drag when another capture is opened", async () => {
    const editor = new EditorState();
    await create(editor, "switch.png", "switch");
    placeShape(editor);
    await editor.flushPendingSave();
    editor.startSelectionDrag(pointer(40, 40));
    editor.updateSelectionDrag(pointer(50, 40));
    await vi.advanceTimersByTimeAsync(600);
    editor.updateSelectionDrag(pointer(70, 40));
    editor.finishSelectionDrag(pointer(70, 40));
    editor.openCapture({ ...capture("other.png"), documentId: "other" });
    await editor.flushPendingSave();
    expect(lastSavedLayer("switch")).toContain('"x":50');
  });

  // A capture hotkey can switch documents while the pointer is still down. No
  // gesture end has run, so the flush before the switch must itself see that
  // the drag moved the annotation after the debounce fired.
  it("writes the position of a drag still in progress when another capture is opened", async () => {
    const editor = new EditorState();
    await create(editor, "mid.png", "mid");
    placeShape(editor);
    await editor.flushPendingSave();
    editor.startSelectionDrag(pointer(40, 40));
    editor.updateSelectionDrag(pointer(50, 40));
    await vi.advanceTimersByTimeAsync(600);
    editor.updateSelectionDrag(pointer(70, 40));
    editor.openCapture({ ...capture("other.png"), documentId: "other" });
    await editor.flushPendingSave();
    expect(lastSavedLayer("mid")).toContain('"x":50');
  });

  it.each(["cancel", "clearSelection"] as const)("a long drag ended by %s still saves its last position", async (how) => {
    const editor = new EditorState();
    await create(editor, "cancelled.png", "cancelled");
    placeShape(editor);
    await editor.flushPendingSave();
    editor.startSelectionDrag(pointer(40, 40));
    editor.updateSelectionDrag(pointer(50, 40));
    await vi.advanceTimersByTimeAsync(600);
    editor.updateSelectionDrag(pointer(70, 40));
    if (how === "cancel") editor.cancelSelectionDrag();
    else editor.clearSelection();
    await editor.flushPendingSave();
    expect(lastSavedLayer("cancelled")).toContain('"x":50');
  });

  it("a long erase gesture ended by cancel still saves its removals", async () => {
    const editor = new EditorState();
    await create(editor, "erase-cancel.png", "erase-cancel");
    placeShape(editor, 20);
    placeShape(editor, 120);
    await editor.flushPendingSave();
    editor.activeTool = "erase";
    editor.startErase(pointer(40, 40));
    await vi.advanceTimersByTimeAsync(600);
    editor.updateErase(pointer(140, 40));
    editor.cancelErase();
    await editor.flushPendingSave();
    expect(lastSavedLayer("erase-cancel")).not.toContain('"kind":"shape"');
  });
});
