// The picture that follows the pointer while a Recent capture is dragged out.
//
// The drag plugin draws its `icon` at the image's own pixel size on macOS
// (NSImage.size) and on Windows (the bitmap's width and height), so handing it
// the capture file itself put a full-size screenshot under the pointer. The
// plugin also accepts a `data:image/png;base64,` string, which is what this
// module produces: the strip's thumbnail drawn into a small canvas.
//
// It has to be synchronous, because the native drag must start inside the
// `dragstart` gesture (see startFileDrag in editorCommands.ts). The strip's
// <img> is already decoded, so drawImage and toDataURL need no await.

// Longest side of the preview, in image pixels.
export const DRAG_PREVIEW_MAX_SIDE = 160;

// A 1x1 transparent PNG: the preview when the thumbnail cannot be read. The
// drag still works, it only has no picture. Never fall back to the capture
// path here, that is the full-size preview this module exists to replace.
export const EMPTY_DRAG_PREVIEW =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=";

// Scale a size down so its longest side is at most `maxSide`, keeping the
// aspect ratio. A size that already fits is returned unchanged (no upscaling),
// and neither side goes below one pixel.
export function fitWithin(
  width: number,
  height: number,
  maxSide: number
): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

// The drag preview for a Recent card, from the card's own thumbnail <img>.
// That <img> must carry `crossorigin="anonymous"`: the asset protocol is
// another origin, and without it the canvas is tainted and toDataURL throws.
export function dragPreviewDataUrl(image: HTMLImageElement | null | undefined): string {
  if (!image || !image.complete || image.naturalWidth === 0 || image.naturalHeight === 0) {
    return EMPTY_DRAG_PREVIEW;
  }
  const size = fitWithin(image.naturalWidth, image.naturalHeight, DRAG_PREVIEW_MAX_SIDE);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) return EMPTY_DRAG_PREVIEW;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, size.width, size.height);
    return canvas.toDataURL("image/png");
  } catch {
    return EMPTY_DRAG_PREVIEW;
  }
}
