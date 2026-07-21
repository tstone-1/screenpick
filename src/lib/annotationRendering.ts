import {
  annotationsInPaintOrder,
  colorWithAlpha,
  cutSeamPoints,
  polygonShapePoints,
  CUT_SEAM_CASING_COLOR,
  CUT_SEAM_CASING_EXTRA_WIDTH,
  TEXT_BACKGROUND_PADDING_X,
  TEXT_BACKGROUND_PADDING_Y,
  TEXT_LINE_HEIGHT,
  type Annotation,
  type ArrowAnnotation,
  type BlurAnnotation,
  type CutSeamAnnotation,
  type EraseStroke,
  type HighlightAnnotation,
  type PenStroke,
  type Point,
  type ShapeAnnotation,
  type TextAnnotation
} from "./annotations";
import { loadImage } from "./editorCommands";
// Type-only: erased at compile time, so this does NOT reintroduce the
// editor<->annotationRendering runtime cycle N3 removed (the constants above
// used to come from here, which did create a runtime cycle).
import type { RecentCapture } from "./editor.svelte";

const ARROW_HEAD_MIN_LENGTH = 12;
const ARROW_HEAD_MIN_WIDTH = 8;
const ARROW_HEAD_LENGTH_PER_WIDTH = 4;
const ARROW_HEAD_WIDTH_PER_WIDTH = 2.6;
const TEXT_BACKGROUND_RADIUS = 4;
export const TEXT_FONT_FAMILY =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const TEXT_BACKGROUND_BASE_COLOR = "#ffffff";

// Per-char fallback used when no real canvas is available (e.g. a Node test
// environment). Matches the heuristic in `estimatedTextWidth`.
const TEXT_WIDTH_FALLBACK_RATIO = 0.58;

let sharedMeasureCanvas: HTMLCanvasElement | null = null;

// Measure the real rendered width of `text` at `fontSize` in the same font the
// canvas exporter uses, so committed text annotations can store an accurate
// width for bounds/hit-testing. Falls back to the per-char estimate when no
// canvas 2D context is available.
export function measureTextWidth(text: string, fontSize: number): number {
  if (typeof document === "undefined") return text.length * fontSize * TEXT_WIDTH_FALLBACK_RATIO;
  if (!sharedMeasureCanvas) sharedMeasureCanvas = document.createElement("canvas");
  const ctx = sharedMeasureCanvas.getContext("2d");
  if (!ctx) return text.length * fontSize * TEXT_WIDTH_FALLBACK_RATIO;
  ctx.font = `${fontSize}px ${TEXT_FONT_FAMILY}`;
  return ctx.measureText(text).width;
}

export type ArrowGeometry = {
  base: Point;
  head: string;
  headPoints: [Point, Point, Point] | null;
  hasLine: boolean;
};

export function textStyle(text: TextAnnotation, zoom: number): string {
  const fontPx = text.fontSize * zoom;
  const base = `left: ${text.position.x * zoom}px; top: ${text.position.y * zoom}px; font-size: ${fontPx}px; color: ${text.color};`;
  if (!text.background) return base;

  const paddingY = TEXT_BACKGROUND_PADDING_Y * zoom;
  const paddingX = TEXT_BACKGROUND_PADDING_X * zoom;
  const radius = TEXT_BACKGROUND_RADIUS * zoom;
  const boxStyle = `padding: ${paddingY}px ${paddingX}px; border-radius: ${radius}px;`;
  const background = colorWithAlpha(TEXT_BACKGROUND_BASE_COLOR, text.backgroundOpacity);
  return background ? `${base} ${boxStyle} background-color: ${background};` : `${base} ${boxStyle}`;
}

export function strokePath(stroke: PenStroke): string {
  const [first, ...rest] = stroke.points;
  if (!first) return "";
  return rest.reduce((path, point) => `${path} L ${point.x} ${point.y}`, `M ${first.x} ${first.y}`);
}

export function arrowGeometry(arrow: ArrowAnnotation, zoom: number): ArrowGeometry {
  const dx = arrow.end.x - arrow.start.x;
  const dy = arrow.end.y - arrow.start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return {
      base: { x: arrow.start.x, y: arrow.start.y },
      head: "",
      headPoints: null,
      hasLine: false
    };
  }

  const ux = dx / length;
  const uy = dy / length;
  const headLength =
    Math.max(ARROW_HEAD_MIN_LENGTH, arrow.width * ARROW_HEAD_LENGTH_PER_WIDTH) / zoom;
  const headWidth =
    Math.max(ARROW_HEAD_MIN_WIDTH, arrow.width * ARROW_HEAD_WIDTH_PER_WIDTH) / zoom;
  const baseX = arrow.end.x - ux * headLength;
  const baseY = arrow.end.y - uy * headLength;
  const perpX = -uy;
  const perpY = ux;
  const left = {
    x: baseX + perpX * (headWidth / 2),
    y: baseY + perpY * (headWidth / 2)
  };
  const right = {
    x: baseX - perpX * (headWidth / 2),
    y: baseY - perpY * (headWidth / 2)
  };
  const tip = { x: arrow.end.x, y: arrow.end.y };

  return {
    base: { x: baseX, y: baseY },
    head: `${arrow.end.x},${arrow.end.y} ${left.x},${left.y} ${right.x},${right.y}`,
    headPoints: [tip, left, right],
    hasLine: length > headLength
  };
}

export async function renderFlattenedPng(
  capture: RecentCapture,
  annotations: Annotation[]
): Promise<Uint8Array> {
  const image = await loadImage(capture.assetUrl);

  await ensureTextFontsReady(annotations);

  const canvas = document.createElement("canvas");
  canvas.width = capture.width;
  canvas.height = capture.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable.");

  ctx.drawImage(image, 0, 0, capture.width, capture.height);

  for (const annotation of annotationsInPaintOrder(annotations)) {
    drawAnnotation(ctx, annotation);
  }

  return canvasToPngBytes(canvas);
}

export function drawAnnotation(ctx: CanvasRenderingContext2D, annotation: Annotation) {
  switch (annotation.kind) {
    case "pen":
      drawPenStroke(ctx, annotation);
      break;
    case "arrow":
      drawArrow(ctx, annotation);
      break;
    case "shape":
      drawShape(ctx, annotation);
      break;
    case "text":
      drawText(ctx, annotation);
      break;
    case "highlight":
      drawHighlight(ctx, annotation);
      break;
    case "blur":
      drawBlur(ctx, annotation);
      break;
    case "erase":
      drawErase(ctx, annotation);
      break;
    case "cut":
      drawCutSeam(ctx, annotation);
      break;
    default: {
      const _exhaustive: never = annotation;
      throw new Error(
        `Unknown annotation kind: ${(_exhaustive as { kind?: string }).kind ?? "unknown"}`
      );
    }
  }
}

function drawCutSeam(ctx: CanvasRenderingContext2D, seam: CutSeamAnnotation) {
  const [first, ...rest] = cutSeamPoints(seam);
  if (!first) return;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (const point of rest) ctx.lineTo(point.x, point.y);
  ctx.strokeStyle = CUT_SEAM_CASING_COLOR;
  ctx.lineWidth = seam.width + CUT_SEAM_CASING_EXTRA_WIDTH;
  ctx.stroke();
  ctx.strokeStyle = seam.color;
  ctx.lineWidth = seam.width;
  ctx.stroke();
  ctx.restore();
}

function drawPenStroke(ctx: CanvasRenderingContext2D, stroke: PenStroke) {
  const [first, ...rest] = stroke.points;
  if (!first) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (const point of rest) ctx.lineTo(point.x, point.y);
  ctx.stroke();
  ctx.restore();
}

// The image eraser. `color === null` punches a true transparent hole via
// `destination-out` (the PNG ends up with alpha 0 there); a hex color paints an
// opaque swath. Because `erase` sorts first in paint order it runs directly over
// the base image — `destination-out` therefore only clears the screenshot, and
// the save/restore returns the context to source-over for every later draw.
function drawErase(ctx: CanvasRenderingContext2D, erase: EraseStroke) {
  const [first, ...rest] = erase.points;
  if (!first) return;
  const paint = erase.color ?? "#000000";
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = erase.width;
  ctx.strokeStyle = paint;
  ctx.fillStyle = paint;
  if (erase.color === null) ctx.globalCompositeOperation = "destination-out";
  if (rest.length === 0) {
    ctx.beginPath();
    ctx.arc(first.x, first.y, erase.width / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const point of rest) ctx.lineTo(point.x, point.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawArrow(ctx: CanvasRenderingContext2D, arrow: ArrowAnnotation) {
  const geometry = arrowGeometry(arrow, 1);
  ctx.save();
  ctx.strokeStyle = arrow.color;
  ctx.fillStyle = arrow.color;
  ctx.lineWidth = arrow.width;
  if (geometry.hasLine) {
    ctx.beginPath();
    ctx.moveTo(arrow.start.x, arrow.start.y);
    ctx.lineTo(geometry.base.x, geometry.base.y);
    ctx.stroke();
  }
  if (geometry.headPoints) {
    const [tip, left, right] = geometry.headPoints;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawText(ctx: CanvasRenderingContext2D, text: TextAnnotation) {
  if (text.text.length === 0) return;
  ctx.save();
  ctx.font = `${text.fontSize}px ${TEXT_FONT_FAMILY}`;
  ctx.textBaseline = "top";

  const paddingX = text.background ? TEXT_BACKGROUND_PADDING_X : 0;
  const paddingY = text.background ? TEXT_BACKGROUND_PADDING_Y : 0;
  if (text.background) {
    const metrics = ctx.measureText(text.text);
    const lineBoxHeight = text.fontSize * TEXT_LINE_HEIGHT;
    const rectWidth = metrics.width + TEXT_BACKGROUND_PADDING_X * 2;
    const rectHeight = lineBoxHeight + TEXT_BACKGROUND_PADDING_Y * 2;
    const background = colorWithAlpha(TEXT_BACKGROUND_BASE_COLOR, text.backgroundOpacity);
    if (background) {
      ctx.fillStyle = background;
      roundedRect(ctx, text.position.x, text.position.y, rectWidth, rectHeight, TEXT_BACKGROUND_RADIUS);
      ctx.fill();
    }
  }

  const halfLeading = (text.fontSize * (TEXT_LINE_HEIGHT - 1)) / 2;
  ctx.fillStyle = text.color;
  ctx.fillText(text.text, text.position.x + paddingX, text.position.y + paddingY + halfLeading);
  ctx.restore();
}

function drawShape(ctx: CanvasRenderingContext2D, shape: ShapeAnnotation) {
  const { x, y, width, height } = shape.rect;
  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.lineWidth = shape.width;
  if (shape.fill) {
    ctx.fillStyle = colorWithAlpha(shape.color, shape.fillOpacity) ?? shape.color;
  }

  if (shape.shape === "rectangle") {
    if (shape.fill) ctx.fillRect(x, y, width, height);
    ctx.strokeRect(x, y, width, height);
  } else if (shape.shape === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    if (shape.fill) ctx.fill();
    ctx.stroke();
  } else {
    const polygon = polygonShapePoints(shape.shape, shape.rect);
    ctx.lineJoin = "round";
    ctx.beginPath();
    polygon.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.closePath();
    if (shape.fill) ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawHighlight(ctx: CanvasRenderingContext2D, highlight: HighlightAnnotation) {
  const { x, y, width, height } = highlight.rect;
  ctx.save();
  ctx.fillStyle = colorWithAlpha(highlight.color, highlight.opacity) ?? highlight.color;
  ctx.fillRect(x, y, width, height);
  ctx.restore();
}

function drawBlur(ctx: CanvasRenderingContext2D, blur: BlurAnnotation) {
  const { x, y, width, height } = blur.rect;
  if (width <= 0 || height <= 0) return;
  const r = blur.radius;
  const srcX = Math.max(0, Math.floor(x - r));
  const srcY = Math.max(0, Math.floor(y - r));
  const srcW = Math.ceil(Math.min(ctx.canvas.width - srcX, width + r * 2));
  const srcH = Math.ceil(Math.min(ctx.canvas.height - srcY, height + r * 2));

  const temp = document.createElement("canvas");
  temp.width = srcW;
  temp.height = srcH;
  const tctx = temp.getContext("2d");
  if (!tctx) return;
  tctx.drawImage(ctx.canvas, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);
  tctx.filter = `blur(${r}px)`;
  tctx.drawImage(temp, 0, 0, srcW, srcH, 0, 0, srcW, srcH);
  tctx.filter = "none";

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  ctx.drawImage(temp, 0, 0, srcW, srcH, srcX, srcY, srcW, srcH);
  ctx.restore();
}

async function ensureTextFontsReady(annotations: Annotation[]) {
  if (!("fonts" in document)) return;
  const fonts = document.fonts;
  await fonts.ready;
  const sizes = new Set(
    annotations
      .filter((annotation): annotation is TextAnnotation => annotation.kind === "text")
      .map((annotation) => annotation.fontSize)
  );
  await Promise.all([...sizes].map((size) => fonts.load(`${size}px ${TEXT_FONT_FAMILY}`)));
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error("Canvas PNG export failed."));
        return;
      }
      try {
        resolve(new Uint8Array(await blob.arrayBuffer()));
      } catch (error) {
        reject(error);
      }
    }, "image/png");
  });
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const limitedRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + limitedRadius, y);
  ctx.lineTo(x + width - limitedRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + limitedRadius);
  ctx.lineTo(x + width, y + height - limitedRadius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - limitedRadius, y + height);
  ctx.lineTo(x + limitedRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - limitedRadius);
  ctx.lineTo(x, y + limitedRadius);
  ctx.quadraticCurveTo(x, y, x + limitedRadius, y);
  ctx.closePath();
}
