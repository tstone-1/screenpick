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

const { DocumentStore } = await import("./documentStore.svelte");
const deleteDocumentMock = commandsMock.deleteDocument;
const listDocumentsMock = commandsMock.listDocuments;

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
