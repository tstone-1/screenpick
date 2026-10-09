import {
  annotationsInPaintOrder,
  arrowControlPoint,
  colorWithAlpha,
  cutSeamPoints,
  polygonShapePoints,
  quadraticPoint,
  CUT_SEAM_CASING_COLOR,
  CUT_SEAM_CASING_EXTRA_WIDTH,
  TEXT_BACKGROUND_PADDING_X,
  TEXT_BACKGROUND_PADDING_Y,
  TEXT_LINE_HEIGHT,
  type Annotation,
  type CropRect,
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
// Type-only: erased at compile time, so this adds no runtime import and cannot
// form a cycle with the editor. The type is declared in the document store.
import type { RecentCapture } from "./documentStore.svelte";

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
  // Control point of the shaft from `start` to `base`; null on a straight arrow.
  control: Point | null;
  // The shaft as an SVG path, from `start` to `base`.
  shaft: string;
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

// A pen stroke is stored as the points the pointer reported and drawn as a
// curve through them. Drawn as straight segments, a slow stroke shows the steps
// of whole image pixels and a fast one shows a corner at every sample.
//
// Two steps. Each point becomes the weighted mean of the points near it along
// the stroke, which takes out the pixel steps; the result is drawn with one
// quadratic curve per point, from the middle of one segment to the middle of
// the next, which leaves no corner. The first and the last point stay where
// they were put.
//
// "Near" is a distance in image pixels, not a number of points, because the
// spacing of the points depends on the speed of the hand and on the zoom:
// measured on stored strokes it ran from 1.3 to 112 pixels. Averaging a fixed
// number of neighbours that cleans the slow stroke shrinks the loops of the
// fast one. The pixel steps are one image pixel high at every zoom, so a
// radius of a few image pixels reaches them and leaves a fast stroke alone.
const STROKE_SMOOTHING_RADIUS = 3;

export type StrokeCurve = {
  start: Point;
  // One curve per inner point: `control` is the point, `end` the middle of the
  // segment to the next one.
  curves: { control: Point; end: Point }[];
  end: Point;
};

export function smoothedStrokePoints(
  points: Point[],
  radius = STROKE_SMOOTHING_RADIUS
): Point[] {
  if (points.length < 3) return points;
  // Distance along the stroke from its first point to each point.
  const along = [0];
  for (let index = 1; index < points.length; index += 1) {
    const step = Math.hypot(
      points[index].x - points[index - 1].x,
      points[index].y - points[index - 1].y
    );
    along.push(along[index - 1] + step);
  }
  const total = along[along.length - 1];
  return points.map((point, index) => {
    // The reach shrinks to nothing toward both ends, so the ends stay put and
    // no point is pulled toward the side that has more of the stroke.
    const reach = Math.min(radius * 3, along[index], total - along[index]);
    if (reach <= 0) return point;
    let x = 0;
    let y = 0;
    let weights = 0;
    const add = (other: number) => {
      const distance = Math.abs(along[other] - along[index]);
      if (distance > reach) return false;
      const weight = Math.exp(-(distance * distance) / (2 * radius * radius));
      x += points[other].x * weight;
      y += points[other].y * weight;
      weights += weight;
      return true;
    };
    add(index);
    for (let other = index - 1; other >= 0 && add(other); other -= 1);
    for (let other = index + 1; other < points.length && add(other); other += 1);
    return { x: x / weights, y: y / weights };
  });
}

export function strokeCurve(points: Point[]): StrokeCurve | null {
  const smoothed = smoothedStrokePoints(points);
  const start = smoothed[0];
  if (!start) return null;
  const curves: StrokeCurve["curves"] = [];
  for (let index = 1; index < smoothed.length - 1; index += 1) {
    const control = smoothed[index];
    const next = smoothed[index + 1];
    curves.push({
      control,
      end: { x: (control.x + next.x) / 2, y: (control.y + next.y) / 2 }
    });
  }
  return { start, curves, end: smoothed[smoothed.length - 1] };
}

export function strokePath(stroke: PenStroke): string {
  const curve = strokeCurve(stroke.points);
  if (!curve) return "";
  let path = `M ${curve.start.x} ${curve.start.y}`;
  for (const { control, end } of curve.curves) {
    path += ` Q ${control.x} ${control.y} ${end.x} ${end.y}`;
  }
  if (stroke.points.length > 1) path += ` L ${curve.end.x} ${curve.end.y}`;
  return path;
}

// Head and shaft are sized in image pixels, with no zoom term: the stage SVG
// and the export both draw this geometry, and they must agree at every zoom.
//
// On a bent arrow the head sits on the curve: its base is the point of the
// curve one head length before the tip, and it points from there to the tip.
// The shaft is the part of the curve up to that point, so it still passes
// through `bend`.
export function arrowGeometry(arrow: ArrowAnnotation): ArrowGeometry {
  const headLength =
    Math.max(ARROW_HEAD_MIN_LENGTH, arrow.width * ARROW_HEAD_LENGTH_PER_WIDTH);
  const headWidth =
    Math.max(ARROW_HEAD_MIN_WIDTH, arrow.width * ARROW_HEAD_WIDTH_PER_WIDTH);
  const control = arrowControlPoint(arrow);
  const length = Math.hypot(arrow.end.x - arrow.start.x, arrow.end.y - arrow.start.y);

  // Where the shaft ends, and the control point of the shaft up to there.
  let shaftEnd: Point;
  let shaftControl: Point | null = null;
  let hasLine: boolean;
  if (control) {
    const split = curveParameterAtDistanceFromEnd(arrow.start, control, arrow.end, headLength);
    hasLine = split > 0;
    shaftEnd = quadraticPoint(arrow.start, control, arrow.end, split);
    shaftControl = {
      x: arrow.start.x + (control.x - arrow.start.x) * split,
      y: arrow.start.y + (control.y - arrow.start.y) * split
    };
  } else {
    hasLine = length > headLength;
    shaftEnd = arrow.start;
  }

  // The head points from the end of the shaft to the tip. An arrow shorter
  // than its head has no shaft, and its head points from `start`.
  const dx = arrow.end.x - shaftEnd.x;
  const dy = arrow.end.y - shaftEnd.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) {
    return {
      base: { x: arrow.start.x, y: arrow.start.y },
      control: null,
      shaft: "",
      head: "",
      headPoints: null,
      hasLine: false
    };
  }
  const ux = dx / distance;
  const uy = dy / distance;
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
  const from = `M ${arrow.start.x} ${arrow.start.y}`;
  const curved = hasLine && shaftControl !== null;

  return {
    base: { x: baseX, y: baseY },
    control: curved ? shaftControl : null,
    shaft: !hasLine
      ? ""
      : curved && shaftControl
        ? `${from} Q ${shaftControl.x} ${shaftControl.y} ${baseX} ${baseY}`
        : `${from} L ${baseX} ${baseY}`,
    head: `${arrow.end.x},${arrow.end.y} ${left.x},${left.y} ${right.x},${right.y}`,
    headPoints: [tip, left, right],
    hasLine
  };
}

// The parameter of the last point on the curve that lies `distance` from its
// end, measured in a straight line. 0 when no part of the curve is farther
// from the end than that.
//
// "Last" matters: a strongly bent arrow can leave the neighbourhood of its tip
// and come back, so the distance to the tip is not monotone along the curve
// and `start` being near the tip says nothing about the curve between them.
// Walk back from the tip to the first sample outside `distance`, then bisect
// the one step where the curve crosses it.
const CURVE_SPLIT_SAMPLES = 32;

function curveParameterAtDistanceFromEnd(
  start: Point,
  control: Point,
  end: Point,
  distance: number
): number {
  const beyond = (t: number) => {
    const point = quadraticPoint(start, control, end, t);
    return Math.hypot(end.x - point.x, end.y - point.y) > distance;
  };
  let low = -1;
  for (let sample = CURVE_SPLIT_SAMPLES - 1; sample >= 0; sample -= 1) {
    if (beyond(sample / CURVE_SPLIT_SAMPLES)) {
      low = sample / CURVE_SPLIT_SAMPLES;
      break;
    }
  }
  if (low < 0) return 0;
  let high = low + 1 / CURVE_SPLIT_SAMPLES;
  for (let step = 0; step < 24; step += 1) {
    const middle = (low + high) / 2;
    if (beyond(middle)) low = middle;
    else high = middle;
  }
  return low;
}

export async function renderFlattenedPng(
  capture: RecentCapture,
  annotations: Annotation[]
): Promise<Uint8Array> {
  return canvasToPngBytes(await renderFlattenedCanvas(capture, annotations));
}

export async function renderSelectionPng(
  capture: RecentCapture,
  annotations: Annotation[],
  rect: CropRect
): Promise<string> {
  const source = await renderFlattenedCanvas(capture, annotations);
  const canvas = document.createElement("canvas");
  canvas.width = rect.width;
  canvas.height = rect.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable.");
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  return canvas.toDataURL("image/png");
}

async function renderFlattenedCanvas(
  capture: RecentCapture,
  annotations: Annotation[]
): Promise<HTMLCanvasElement> {
  const image = await loadImage(capture.assetUrl);

  await ensureTextFontsReady(annotations);

  const canvas = document.createElement("canvas");
  canvas.width = capture.width;
  canvas.height = capture.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable.");

  ctx.drawImage(image, 0, 0, capture.width, capture.height);

  for (const annotation of annotationsInPaintOrder(annotations)) {
    if (annotation.kind === "image" && annotation.dataUrl !== null) {
      const image = await loadImage(annotation.dataUrl);
      const { x, y, width, height } = annotation.rect;
      ctx.drawImage(image, x, y, width, height);
    } else {
      drawAnnotation(ctx, annotation);
    }
  }

  return canvas;
}

export function drawAnnotation(ctx: CanvasRenderingContext2D, annotation: Annotation) {
  switch (annotation.kind) {
    case "image": {
      if (annotation.dataUrl !== null) throw new Error("Image must be decoded before drawing.");
      ctx.save();
      ctx.fillStyle = "#ffffff";
      const { x, y, width, height } = annotation.rect;
      ctx.fillRect(x, y, width, height);
      ctx.restore();
      break;
    }
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
  const curve = strokeCurve(stroke.points);
  if (!curve) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.beginPath();
  ctx.moveTo(curve.start.x, curve.start.y);
  for (const { control, end } of curve.curves) {
    ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
  }
  ctx.lineTo(curve.end.x, curve.end.y);
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
  const geometry = arrowGeometry(arrow);
  ctx.save();
  ctx.strokeStyle = arrow.color;
  ctx.fillStyle = arrow.color;
  ctx.lineWidth = arrow.width;
  if (geometry.hasLine) {
    ctx.beginPath();
    ctx.moveTo(arrow.start.x, arrow.start.y);
    if (geometry.control) {
      ctx.quadraticCurveTo(
        geometry.control.x,
        geometry.control.y,
        geometry.base.x,
        geometry.base.y
      );
    } else {
      ctx.lineTo(geometry.base.x, geometry.base.y);
    }
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
