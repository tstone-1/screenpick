// @vitest-environment jsdom
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DRAG_PREVIEW_MAX_SIDE,
  EMPTY_DRAG_PREVIEW,
  dragPreviewDataUrl,
  fitWithin
} from "./dragPreview";

describe("fitWithin", () => {
  it("scales the longest side down to the limit and keeps the aspect ratio", () => {
    expect(fitWithin(3840, 2160, 160)).toEqual({ width: 160, height: 90 });
    expect(fitWithin(1080, 1920, 160)).toEqual({ width: 90, height: 160 });
  });

  it("leaves a size that already fits unchanged", () => {
    expect(fitWithin(120, 80, 160)).toEqual({ width: 120, height: 80 });
  });

  it("keeps the short side of a very thin image at one pixel", () => {
    expect(fitWithin(4000, 4, 160)).toEqual({ width: 160, height: 1 });
  });
});

// jsdom has no canvas implementation, so the canvas is replaced by a recorder:
// what matters here is the size the preview is drawn at.
function loadedImage(naturalWidth: number, naturalHeight: number): HTMLImageElement {
  const image = document.createElement("img");
  Object.defineProperties(image, {
    complete: { value: true },
    naturalWidth: { value: naturalWidth },
    naturalHeight: { value: naturalHeight }
  });
  return image;
}

function recordCanvas(toDataURL: () => string = () => "data:image/png;base64,small") {
  const drawImage = vi.fn();
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toDataURL };
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
    tag === "canvas" ? canvas : realCreate(tag)) as typeof document.createElement);
  return { canvas, drawImage };
}

// The comment on the constant says "transparent". A hand-copied base64 string
// is easy to get wrong without anyone seeing it, so decode it and look.
describe("EMPTY_DRAG_PREVIEW", () => {
  it("is a 1x1 PNG whose only pixel is fully transparent", () => {
    const prefix = "data:image/png;base64,";
    expect(EMPTY_DRAG_PREVIEW.startsWith(prefix)).toBe(true);
    const png = Buffer.from(EMPTY_DRAG_PREVIEW.slice(prefix.length), "base64");
    expect(png.subarray(0, 8).toString("latin1")).toBe("\x89PNG\r\n\x1a\n");

    // IHDR is the first chunk: width, height, bit depth, colour type.
    expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(1);
    expect(png.readUInt32BE(20)).toBe(1);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6); // RGBA

    // IDAT follows IHDR (8 signature + 25 IHDR chunk bytes).
    const idatLength = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString("latin1")).toBe("IDAT");
    const scanline = inflateSync(png.subarray(41, 41 + idatLength));
    // One filter byte, then R, G, B, A.
    expect([...scanline]).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("dragPreviewDataUrl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws a full-size capture at thumbnail size", () => {
    const { canvas, drawImage } = recordCanvas();
    const image = loadedImage(3840, 2160);

    expect(dragPreviewDataUrl(image)).toBe("data:image/png;base64,small");
    expect(Math.max(canvas.width, canvas.height)).toBe(DRAG_PREVIEW_MAX_SIDE);
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 160, 90);
  });

  it("returns the empty preview when there is no loaded image", () => {
    const { drawImage } = recordCanvas();

    expect(dragPreviewDataUrl(null)).toBe(EMPTY_DRAG_PREVIEW);
    expect(dragPreviewDataUrl(loadedImage(0, 0))).toBe(EMPTY_DRAG_PREVIEW);
    expect(drawImage).not.toHaveBeenCalled();
  });

  // A tainted canvas throws on readback. The drag must still start.
  it("returns the empty preview when the canvas cannot be read back", () => {
    recordCanvas(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });

    expect(dragPreviewDataUrl(loadedImage(3840, 2160))).toBe(EMPTY_DRAG_PREVIEW);
  });
});
