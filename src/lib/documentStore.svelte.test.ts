import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentRecord } from "./bindings";
import type { PenStroke } from "./annotations";
import { serializeAnnotations } from "./annotations";
import type { RecentCapture } from "./documentStore.svelte";

// W4 in the 2026-07 code review: zero tests existed for the disk-deleting
// retention/eviction logic. Mocked at the same IPC-adapter boundary as
// editor.svelte.test.ts (`./bindings` for the pure command pass-throughs,
// `./editorCommands` for the Uint8Array-shim wrapper), so these exercise the
// real DocumentStore/enforceRetention/isDocumentDirty logic end to end.
const commandsMock = vi.hoisted(() => ({
  createDocument: vi.fn(),
  replaceDocumentBase: vi.fn(),
  deleteDocument: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  listDocuments: vi.fn()
}));

vi.mock("./bindings", () => ({
  commands: commandsMock
}));

vi.mock("./editorCommands", () => ({
  saveDocument: vi.fn(),
  toAssetUrl: (path: string) => `asset://${path}`
}));

// renderFlattenedPng needs a real <canvas>, which this suite's node environment
// doesn't provide; it is the only export documentStore.svelte.ts takes from
// this module.
vi.mock("./annotationRendering", () => ({
  renderFlattenedPng: vi.fn().mockResolvedValue(new Uint8Array())
}));

// The diagnostics log is the recovery signal for a dropped annotation layer
// (below), so it is mocked to be asserted on rather than to be silenced.
vi.mock("./diagnosticsLog", () => ({
  logError: vi.fn(),
  logWarn: vi.fn()
}));

const {
  DocumentStore,
  baseFileNameOf,
  recentCapturePatchForRecord,
  recentThumbnailUrl,
  restoredAnnotationLayer
} = await import("./documentStore.svelte");
const { saveDocument } = await import("./editorCommands");
const { logError } = await import("./diagnosticsLog");
const logErrorMock = vi.mocked(logError);
const deleteDocumentMock = commandsMock.deleteDocument;
const listDocumentsMock = commandsMock.listDocuments;
const replaceDocumentBaseMock = commandsMock.replaceDocumentBase;
const saveDocumentMock = vi.mocked(saveDocument);

// How many clean documents DocumentStore.enforceRetention keeps (see the
// CLEAN_DOCUMENT_RETENTION comment in documentStore.svelte.ts) — not exported,
// so mirrored here rather than reaching into the module's private constant.
const CLEAN_DOCUMENT_RETENTION = 8;

function capture(overrides: Partial<RecentCapture> & { path: string }): RecentCapture {
  return {
    mode: "region",
    title: overrides.path,
    width: 100,
    height: 100,
    assetUrl: `asset://${overrides.path}`,
    ...overrides
  };
}

function penAnnotation(id: number): PenStroke {
  return {
    kind: "pen",
    id,
    points: [
      { x: 10, y: 10 },
      { x: 20, y: 20 }
    ],
    color: "#000000",
    width: 2
  };
}

function documentRecord(id: string, annotationsJson: string): DocumentRecord {
  return {
    id,
    mode: "region",
    title: id,
    width: 100,
    height: 100,
    createdAt: null,
    updatedAt: null,
    dirty: false,
    basePath: `${id}-base.png`,
    currentPath: `${id}-current.png`,
    annotations: annotationsJson
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteDocumentMock.mockResolvedValue({ status: "ok", data: null });
});

describe("DocumentStore.enforceRetention", () => {
  it("evicts only clean documents beyond the cap and never the open one", () => {
    const store = new DocumentStore();
    const dirtyEntry = capture({ path: "dirty.png", documentId: "dirty-id", dirty: true });
    const cleanEntries = Array.from({ length: 10 }, (_, i) =>
      capture({ path: `clean${i + 1}.png`, documentId: `clean-${i + 1}` })
    );
    store.recentCaptures = [dirtyEntry, ...cleanEntries];
    // clean-1 is the open document — it must survive despite occupying the
    // MRU-newest clean slot the cap would otherwise happily keep anyway; the
    // real test is that it doesn't consume one of the 8 clean eviction slots.
    const openCapture = cleanEntries[0];

    store.enforceRetention(openCapture, openCapture);

    const survivingIds = store.recentCaptures.map((c) => c.documentId);
    expect(survivingIds).toEqual([
      "dirty-id",
      ...cleanEntries.slice(0, CLEAN_DOCUMENT_RETENTION + 1).map((c) => c.documentId)
    ]);
    expect(survivingIds).not.toContain("clean-10");
    expect(deleteDocumentMock).toHaveBeenCalledTimes(1);
    expect(deleteDocumentMock).toHaveBeenCalledWith("clean-10");
  });
});

describe("DocumentStore.isDocumentDirty", () => {
  it("counts seeded annotations of a restored-but-unopened document", () => {
    const store = new DocumentStore();
    const docA = capture({ path: "docA.png", documentId: "doc-a" });
    const docB = capture({ path: "docB.png", documentId: "doc-b" });
    store.seedAnnotations("doc-a", [penAnnotation(1)]);
    store.seedAnnotations("doc-b", []);

    expect(store.isDocumentDirty(docA, undefined, 0)).toBe(true);
    expect(store.isDocumentDirty(docB, undefined, 0)).toBe(false);

    // Retention should honor the same predicate: docA (real seeded work)
    // survives past the cap; docB (an empty seeded layer, i.e. genuinely
    // clean) is evictable.
    const fillers = Array.from({ length: CLEAN_DOCUMENT_RETENTION }, (_, i) =>
      capture({ path: `filler${i}.png`, documentId: `filler-${i}` })
    );
    store.recentCaptures = [...fillers, docA, docB];

    store.enforceRetention(null, null);

    const survivingIds = store.recentCaptures.map((c) => c.documentId);
    expect(survivingIds).toContain("doc-a");
    expect(survivingIds).not.toContain("doc-b");
    expect(deleteDocumentMock).toHaveBeenCalledTimes(1);
    expect(deleteDocumentMock).toHaveBeenCalledWith("doc-b");
  });
});

describe("DocumentStore.loadPersistedDocuments", () => {
  it("seeds layers before applying retention", async () => {
    const store = new DocumentStore();
    const annotatedJson = serializeAnnotations([penAnnotation(1)]);
    const emptyJson = serializeAnnotations([]);
    // 2 records dirty via their annotations payload (record.dirty itself is
    // false — the seeded layer is what must count), 10 genuinely clean.
    const dirtyRecords = [documentRecord("d1", annotatedJson), documentRecord("d2", annotatedJson)];
    const cleanRecords = Array.from({ length: 10 }, (_, i) =>
      documentRecord(`clean-${i + 1}`, emptyJson)
    );
    listDocumentsMock.mockResolvedValue({ status: "ok", data: [...dirtyRecords, ...cleanRecords] });

    await store.loadPersistedDocuments(null, null);

    const survivingIds = store.recentCaptures.map((c) => c.documentId);
    expect(survivingIds).toContain("d1");
    expect(survivingIds).toContain("d2");
    // 10 clean records, cap 8: exactly the 2 oldest overflow and are evicted.
    expect(survivingIds).not.toContain("clean-9");
    expect(survivingIds).not.toContain("clean-10");
    expect(survivingIds).toEqual([
      "d1",
      "d2",
      "clean-1",
      "clean-2",
      "clean-3",
      "clean-4",
      "clean-5",
      "clean-6",
      "clean-7",
      "clean-8"
    ]);
    expect(deleteDocumentMock).toHaveBeenCalledTimes(2);
    expect(deleteDocumentMock).toHaveBeenCalledWith("clean-9");
    expect(deleteDocumentMock).toHaveBeenCalledWith("clean-10");
  });
});

// W1 in the 2026-08 code review: persists for one document overlapped freely
// (debounce timer, exit flush, crop/cut's re-base write, the persist-first rule
// behind copy-path/reveal), each carrying the layer it was called with — so an
// older call's save_document could land after a newer one's and leave the stale
// layer on disk with nothing scheduled to correct it.
describe("DocumentStore.persistDocument", () => {
  it("serializes overlapping persists for one document in call order", async () => {
    const store = new DocumentStore();
    const doc = capture({ path: "doc.png", documentId: "doc-1" });
    store.recentCaptures = [doc];
    // Teaches the store which base raster the document holds, so both writes
    // carry the same stamp and the layers below are compared like for like.
    store.recentFromRecord(documentRecord("doc-1", "[]"));
    // Base already in sync, so neither persist takes the re-base branch and
    // save_document is the only ordering surface under test. Set after the
    // record above, which points it at the document's own base path.
    store.recordLastPersistedBasePath("doc-1", "doc.png");

    const releases: Array<() => void> = [];
    const written: string[] = [];
    saveDocumentMock.mockImplementation(async (id, annotations) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      written.push(annotations);
      return { status: "ok", data: { ...documentRecord(id, annotations), annotations } };
    });

    const firstLayer = [penAnnotation(1)];
    const secondLayer = [penAnnotation(1), penAnnotation(2)];
    const first = store.persistDocument(doc, firstLayer);
    const second = store.persistDocument(doc, secondLayer);

    await vi.waitFor(() => expect(releases).toHaveLength(1));
    // The overlap itself is the defect: while the first write is open the
    // second must not have been sent, or the two can complete out of order.
    expect(saveDocumentMock).toHaveBeenCalledOnce();

    releases[0]();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]();
    await Promise.all([first, second]);

    expect(written).toEqual([
      serializeAnnotations(firstLayer, "doc-1-base.png"),
      serializeAnnotations(secondLayer, "doc-1-base.png")
    ]);
    expect(replaceDocumentBaseMock).not.toHaveBeenCalled();
  });

  it("settlePersists resolves only once an in-flight write has finished", async () => {
    const store = new DocumentStore();
    const doc = capture({ path: "doc.png", documentId: "doc-1" });
    store.recentCaptures = [doc];
    store.recordLastPersistedBasePath("doc-1", "doc.png");

    const releases: Array<() => void> = [];
    saveDocumentMock.mockImplementation(async (id, annotations) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { status: "ok", data: { ...documentRecord(id, annotations), annotations } };
    });

    // Nothing queued: the exit path must not stall on an idle store.
    await store.settlePersists();

    const persist = store.persistDocument(doc, [penAnnotation(1)]);
    await vi.waitFor(() => expect(releases).toHaveLength(1));

    let settled = false;
    const drained = store.settlePersists().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releases[0]();
    await drained;
    expect(settled).toBe(true);
    await persist;
  });
});

// W1 in the 2026-08 code review. Crop/cut persist through two IPC calls:
// replace_document_base commits the new base raster to the manifest, then
// save_document writes the transformed annotation layer. A crash, a full disk
// or a forced quit between them leaves the cropped base beside the pre-crop
// layer — and the restore path used to re-apply that layer over the new image,
// silently offsetting every annotation by the crop origin, permanently. The
// layer now names the raster it was rendered against.
describe("annotation layer / base raster pairing", () => {
  function recordWithBase(id: string, annotationsJson: string, basePath: string): DocumentRecord {
    return { ...documentRecord(id, annotationsJson), basePath };
  }

  it("stamps a save with the base raster the re-base just committed", async () => {
    const store = new DocumentStore();
    // The document as it stood before the crop.
    store.recentFromRecord(recordWithBase("doc-1", "[]", "/docs/doc-1/base.png"));
    const cropped = capture({ path: "cropped.png", documentId: "doc-1" });
    store.recentCaptures = [cropped];
    replaceDocumentBaseMock.mockResolvedValue({
      status: "ok",
      data: recordWithBase("doc-1", "[]", "/docs/doc-1/base-99-1.png")
    });
    saveDocumentMock.mockImplementation(async (id, annotations) => ({
      status: "ok",
      data: { ...recordWithBase(id, annotations, "/docs/doc-1/base-99-1.png"), annotations }
    }));

    const layer = [penAnnotation(1)];
    await store.persistDocument(cropped, layer, { replaceBase: true });

    expect(replaceDocumentBaseMock).toHaveBeenCalledOnce();
    // The post-crop raster, not the pre-crop one it superseded: stamping the
    // old name would make every crop look like the very corruption this
    // guards against.
    expect(saveDocumentMock).toHaveBeenCalledWith(
      "doc-1",
      serializeAnnotations(layer, "base-99-1.png"),
      expect.anything(),
      true
    );
  });

  it("restores a layer stamped with the base the document still holds", async () => {
    const store = new DocumentStore();
    const layer = [penAnnotation(1)];
    listDocumentsMock.mockResolvedValue({
      status: "ok",
      data: [
        recordWithBase(
          "doc-1",
          serializeAnnotations(layer, "base-99-1.png"),
          "/docs/doc-1/base-99-1.png"
        )
      ]
    });

    await store.loadPersistedDocuments(null, null);

    expect(store.takeSeededAnnotations("doc-1")).toEqual(layer);
    expect(logErrorMock).not.toHaveBeenCalled();
  });

  // The crash case itself: the manifest carries the cropped base, the layer on
  // disk was drawn on the one before it.
  it("drops a layer stamped with a base the document no longer holds", async () => {
    const store = new DocumentStore();
    listDocumentsMock.mockResolvedValue({
      status: "ok",
      data: [
        recordWithBase(
          "doc-1",
          serializeAnnotations([penAnnotation(1)], "base.png"),
          "/docs/doc-1/base-99-1.png"
        )
      ]
    });

    await store.loadPersistedDocuments(null, null);

    expect(store.takeSeededAnnotations("doc-1")).toEqual([]);
    // The base image itself survives — losing the overlay is recoverable,
    // misplacing it silently is not.
    expect(store.recentCaptures.map((entry) => entry.path)).toEqual(["/docs/doc-1/base-99-1.png"]);
    expect(logErrorMock).toHaveBeenCalledOnce();
    const [message] = logErrorMock.mock.calls[0];
    expect(message).toContain("doc-1");
    expect(message).toContain("base.png");
    expect(message).toContain("base-99-1.png");
  });

  // Every document written before the stamp existed holds a bare array. The
  // upgrade must not read that as a mismatch and throw the user's work away.
  it("restores a legacy un-stamped layer unchanged", async () => {
    const store = new DocumentStore();
    const layer = [penAnnotation(1)];
    listDocumentsMock.mockResolvedValue({
      status: "ok",
      data: [recordWithBase("doc-1", JSON.stringify(layer), "/docs/doc-1/base-99-1.png")]
    });

    await store.loadPersistedDocuments(null, null);

    expect(store.takeSeededAnnotations("doc-1")).toEqual(layer);
    expect(logErrorMock).not.toHaveBeenCalled();
  });

  it("compares base rasters by file name on either platform's separator", () => {
    expect(baseFileNameOf("C:\\Users\\x\\documents\\doc-1\\base-99-1.png")).toBe("base-99-1.png");
    expect(baseFileNameOf("/Users/x/documents/doc-1/base-99-1.png")).toBe("base-99-1.png");
    expect(baseFileNameOf("base.png")).toBe("base.png");

    // The same document folder reached through the two separator styles must
    // not read as a re-base: it is the name that identifies the raster.
    const layer = [penAnnotation(1)];
    const stamped = serializeAnnotations(layer, "base-99-1.png");
    expect(
      restoredAnnotationLayer(recordWithBase("doc-1", stamped, "C:\\docs\\doc-1\\base-99-1.png"))
    ).toEqual({ annotations: layer, droppedFrom: null });
    expect(
      restoredAnnotationLayer(recordWithBase("doc-1", stamped, "/docs/doc-1/base-99-1.png"))
    ).toEqual({ annotations: layer, droppedFrom: null });
  });
});

// The Recent strip used to render `assetUrl` — always the un-annotated base
// raster — so a highlighted screenshot showed up in the strip clean, and the
// only place the annotations existed visibly was the open editor. The strip now
// renders the document's flattened current.png, which brings its own hazard:
// that file keeps its path while its bytes are rewritten on every save, and the
// webview caches by URL, so a naive src swap would freeze on the first render.
describe("Recent-strip thumbnail", () => {
  function savedRecord(id: string, updatedAt: number | null): DocumentRecord {
    return { ...documentRecord(id, "[]"), updatedAt, dirty: true };
  }

  it("shows the flattened current.png once a save has produced one", () => {
    const unpersisted = capture({ path: "shot.png" });
    const persisted = { ...unpersisted, documentId: "doc-1", currentPath: "doc-1-current.png" };

    expect(recentThumbnailUrl(unpersisted)).toBe("asset://shot.png");
    expect(recentThumbnailUrl(persisted)).toContain("asset://doc-1-current.png");
  });

  it("changes the thumbnail URL on every persisted save", () => {
    const store = new DocumentStore();
    store.recentCaptures = [capture({ path: "shot.png", documentId: "doc-1" })];

    store.applyRecordToRecent(savedRecord("doc-1", 1000));
    const afterFirstSave = recentThumbnailUrl(store.recentCaptures[0]);
    store.applyRecordToRecent(savedRecord("doc-1", 2000));
    const afterSecondSave = recentThumbnailUrl(store.recentCaptures[0]);

    // Both point at the same file — only the cache key may move, or the
    // asset protocol would stop resolving it.
    expect(afterFirstSave).toContain("asset://doc-1-current.png");
    expect(afterSecondSave).toContain("asset://doc-1-current.png");
    expect(afterSecondSave).not.toBe(afterFirstSave);
  });

  // now_millis() is the revision's natural source and is not enough on its own:
  // two saves inside one millisecond would repeat it and pin the strip on the
  // older render, with nothing scheduled to correct it.
  it("changes the thumbnail URL even when two saves share a timestamp", () => {
    const store = new DocumentStore();
    store.recentCaptures = [capture({ path: "shot.png", documentId: "doc-1" })];

    store.applyRecordToRecent(savedRecord("doc-1", 1000));
    const afterFirstSave = recentThumbnailUrl(store.recentCaptures[0]);
    store.applyRecordToRecent(savedRecord("doc-1", 1000));

    expect(recentThumbnailUrl(store.recentCaptures[0])).not.toBe(afterFirstSave);
  });

  // A record only ever patches its own document. Bumping a bystander's cache
  // key would make the whole strip re-fetch on every keystroke-triggered save.
  it("leaves other captures' thumbnails untouched when one document saves", () => {
    const store = new DocumentStore();
    const other = capture({ path: "other.png", documentId: "doc-2" });
    store.recentCaptures = [capture({ path: "shot.png", documentId: "doc-1" }), other];

    store.applyRecordToRecent(savedRecord("doc-1", 1000));

    expect(store.recentCaptures[1]).toEqual(other);
    expect(recentThumbnailUrl(store.recentCaptures[1])).toBe("asset://other.png");
  });

  // A capture whose create_document has not resolved yet (or failed) has no
  // current.png at all; it must keep rendering the base exactly as before.
  it("keeps an unpersisted capture on the base raster", () => {
    const inMemory = capture({ path: "shot.png" });

    // A record for some other document reaches every strip entry through the
    // patch; the one it does not match must come out byte-for-byte identical.
    expect(recentCapturePatchForRecord(savedRecord("doc-1", 1000))(inMemory)).toEqual(inMemory);
    expect(recentThumbnailUrl(inMemory)).toBe("asset://shot.png");
  });

  // Restored at launch, the strip's entry must be keyed to the bytes on disk —
  // not to a cache entry a previous run left behind under a bare URL.
  it("keys a restored document's thumbnail to the save it was restored from", () => {
    const store = new DocumentStore();

    const restored = store.recentFromRecord(savedRecord("doc-1", 4242));

    expect(recentThumbnailUrl(restored)).toBe("asset://doc-1-current.png?v=4242");
  });
});
