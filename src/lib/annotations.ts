// Pure annotation data types and geometry/hit-test/color helpers.
//
// This module is deliberately free of Svelte runes and Tauri imports so it can
// be unit-tested in a plain Node environment. The stateful editor
// (`editor.svelte.ts`) imports from here and re-exports the public types.

export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Point = {
  x: number;
  y: number;
};

export type PenStroke = {
  kind: "pen";
  id: number;
  points: Point[];
  color: string;
  width: number;
};

export type ArrowAnnotation = {
  kind: "arrow";
  id: number;
  start: Point;
  end: Point;
  color: string;
  width: number;
};

export type ShapeKind = "rectangle" | "ellipse" | "triangle" | "diamond";
export type PolygonShapeKind = Exclude<ShapeKind, "rectangle" | "ellipse">;

export type ShapeAnnotation = {
  kind: "shape";
  id: number;
  shape: ShapeKind;
  rect: CropRect;
  color: string;
  width: number;
  fill: boolean;
  fillOpacity: number;
};

export type TextAnnotation = {
  kind: "text";
  id: number;
  position: Point;
  text: string;
  color: string;
  fontSize: number;
  background: boolean;
  backgroundOpacity: number;
  // Real measured glyph width (px, unscaled), stamped at commit time via canvas
  // `measureText`. The renderer always uses `measureText`; bounds/hit-testing
  // read this so the selection box and drag-clamp match the rendered text for
  // wide and non-Latin glyphs instead of the rough per-char estimate.
  measuredWidth?: number;
};

export type HighlightAnnotation = {
  kind: "highlight";
  id: number;
  rect: CropRect;
  color: string;
  opacity: number;
};

export type BlurAnnotation = {
  kind: "blur";
  id: number;
  rect: CropRect;
  radius: number;
};

// A freehand brush that removes screenshot content (NOT a placed object like a
// filled shape, and NOT the object eraser which deletes annotations). At export
// it is composited at the very bottom of the stack, directly over the base
// image: `color === null` punches a true transparent hole (alpha 0 in the PNG);
// a hex `color` paints an opaque swath. Annotations drawn afterwards sit on top,
// so this only ever affects the picture, never the user's marks.
export type EraseStroke = {
  kind: "erase";
  id: number;
  points: Point[];
  width: number;
  color: string | null;
};

export type CutSeamAnnotation = {
  kind: "cut";
  id: number;
  orientation: "horizontal" | "vertical";
  position: number;
  start: number;
  span: number;
  color: string;
  width: number;
  amplitude: number;
  period: number;
};

// The cut seam's dark casing (a thin outline drawn under the seam's own
// zigzag stroke, both in EditorStage's live SVG and in the flattened canvas
// export) so the seam reads against light AND dark screenshot backgrounds.
// Lives here — not in editor.svelte.ts — so annotationRendering.ts (which
// needs both for the canvas export) doesn't have to import back from the
// editor state module: that was the one module cycle in the codebase (N3 in
// the 2026-07 code review), and it only existed because these two constants
// lived on the wrong side of it. Both prior importers (annotationRendering.ts,
// EditorStage.svelte) now import from here instead.
export const CUT_SEAM_CASING_COLOR = "#20242a";
export const CUT_SEAM_CASING_EXTRA_WIDTH = 2;

export type Annotation =
  | PenStroke
  | ArrowAnnotation
  | ShapeAnnotation
  | TextAnnotation
  | HighlightAnnotation
  | BlurAnnotation
  | EraseStroke
  | CutSeamAnnotation;

export type AnnotationBounds = CropRect;

const ANNOTATION_KINDS = new Set<Annotation["kind"]>([
  "pen",
  "arrow",
  "shape",
  "text",
  "highlight",
  "blur",
  "erase",
  "cut"
]);

// Serialize an annotation layer for persistence (`annotations.json`). Plain
// `JSON.stringify` — annotations are pure data with no functions/cycles.
export function serializeAnnotations(annotations: Annotation[]): string {
  return JSON.stringify(annotations);
}

// Parse a persisted annotation layer back into `Annotation[]`, defensively:
// disk data is untrusted (could be hand-edited or written by an older/newer
// build), so a malformed payload yields an empty layer rather than throwing, and
// entries without a known `kind` / numeric `id` are dropped.
export function deserializeAnnotations(json: string): Annotation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is Annotation =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { id?: unknown }).id === "number" &&
      ANNOTATION_KINDS.has((entry as { kind?: Annotation["kind"] }).kind as Annotation["kind"])
  );
}

// Next free annotation id for a layer, so ids stay unique after restoring a
// persisted document (the in-process counter resets each session).
export function nextAnnotationIdFor(annotations: Annotation[]): number {
  return annotations.reduce((max, annotation) => Math.max(max, annotation.id), 0) + 1;
}

// Text geometry constants shared by the bounds math here and the renderer in
// editor.svelte.ts, so the on-screen DOM, the hit box, and the exported canvas
// all agree.
export const TEXT_BACKGROUND_PADDING_X = 6;
export const TEXT_BACKGROUND_PADDING_Y = 2;
export const TEXT_LINE_HEIGHT = 1.2;

type AnnotationKind = Annotation["kind"];
export type AnnotationLayer = "erase" | "cut" | "blur" | "highlight" | "middle" | "text";

const ANNOTATION_LAYER: Record<AnnotationKind, AnnotationLayer> = {
  erase: "erase",
  cut: "cut",
  blur: "blur",
  highlight: "highlight",
  pen: "middle",
  arrow: "middle",
  shape: "middle",
  text: "text"
};

export function annotationLayer(annotation: Annotation): AnnotationLayer {
  return ANNOTATION_LAYER[annotation.kind];
}

// Orders annotations top-to-bottom in the same visual stack the renderer and
// export use: text above pen/arrow/shape, those above highlights, highlights
// above blur. Within each layer the most-recently-added is on top (reverse of
// array order). Select and Erase both hit-test in this order so they target the
// same visible annotation when several overlap.
export function annotationsInVisualHitOrder(annotations: Annotation[]): Annotation[] {
  const text = annotations.filter((annotation) => ANNOTATION_LAYER[annotation.kind] === "text");
  const middle = annotations.filter((annotation) => ANNOTATION_LAYER[annotation.kind] === "middle");
  const highlights = annotations.filter((annotation) => ANNOTATION_LAYER[annotation.kind] === "highlight");
  const blurs = annotations.filter((annotation) => ANNOTATION_LAYER[annotation.kind] === "blur");
  const cuts = annotations.filter((annotation) => ANNOTATION_LAYER[annotation.kind] === "cut");
  const erases = annotations.filter((annotation) => ANNOTATION_LAYER[annotation.kind] === "erase");
  return [
    ...text.reverse(),
    ...middle.reverse(),
    ...highlights.reverse(),
    ...blurs.reverse(),
    ...cuts.reverse(),
    ...erases.reverse()
  ];
}

export function annotationsInPaintOrder(annotations: Annotation[]): Annotation[] {
  const erases = annotations.filter((annotation) => ANNOTATION_LAYER[annotation.kind] === "erase");
  const cuts = annotations.filter((annotation) => ANNOTATION_LAYER[annotation.kind] === "cut");
  const blurs = annotations.filter((annotation) => ANNOTATION_LAYER[annotation.kind] === "blur");
  const highlights = annotations.filter((annotation) => ANNOTATION_LAYER[annotation.kind] === "highlight");
  const middle = annotations.filter((annotation) => ANNOTATION_LAYER[annotation.kind] === "middle");
  const text = annotations.filter((annotation) => ANNOTATION_LAYER[annotation.kind] === "text");
  return [...erases, ...cuts, ...blurs, ...highlights, ...middle, ...text];
}

export function annotationBounds(annotation: Annotation): AnnotationBounds {
  switch (annotation.kind) {
    case "pen":
      return pointsBounds(annotation.points, annotation.width / 2);
    case "erase":
      return pointsBounds(annotation.points, annotation.width / 2);
    case "arrow":
      return pointsBounds([annotation.start, annotation.end], annotation.width / 2);
    case "shape":
      return annotation.rect;
    case "highlight":
      return annotation.rect;
    case "blur":
      return annotation.rect;
    case "cut":
      return annotation.orientation === "horizontal"
        ? {
            x: annotation.start,
            y: annotation.position - annotation.amplitude,
            width: annotation.span,
            height: annotation.amplitude * 2
          }
        : {
            x: annotation.position - annotation.amplitude,
            y: annotation.start,
            width: annotation.amplitude * 2,
            height: annotation.span
          };
    case "text":
      return {
        x: annotation.position.x,
        y: annotation.position.y,
        width: estimatedTextWidth(annotation),
        height:
          annotation.fontSize * TEXT_LINE_HEIGHT +
          (annotation.background ? TEXT_BACKGROUND_PADDING_Y * 2 : 0)
      };
  }
}

export function rectsIntersect(a: CropRect, b: CropRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function cropAnnotations(
  annotations: Annotation[],
  cropX: number,
  cropY: number,
  croppedWidth: number,
  croppedHeight: number
): Annotation[] {
  const cropBounds = { x: 0, y: 0, width: croppedWidth, height: croppedHeight };
  return annotations
    .map((annotation) => translateAnnotation(annotation, -cropX, -cropY))
    .filter((annotation) => rectsIntersect(annotationBounds(annotation), cropBounds));
}

export function cutoutAnnotations(
  annotations: Annotation[],
  axis: "horizontal" | "vertical",
  start: number,
  length: number,
  newWidth: number,
  newHeight: number
): Annotation[] {
  const end = start + length;
  const newBounds = { x: 0, y: 0, width: newWidth, height: newHeight };
  return annotations
    .flatMap((annotation) => {
      const bounds = annotationBounds(annotation);
      const boundsStart = axis === "horizontal" ? bounds.y : bounds.x;
      const boundsEnd =
        axis === "horizontal" ? bounds.y + bounds.height : bounds.x + bounds.width;

      if (boundsEnd <= start) return [annotation];
      if (boundsStart >= end) {
        return [translateAnnotation(annotation, axis === "horizontal" ? 0 : -length, axis === "horizontal" ? -length : 0)];
      }
      if (boundsStart >= start && boundsEnd <= end) return [];
      if (boundsStart < start) return [annotation];
      return [translateAnnotation(annotation, axis === "horizontal" ? 0 : -length, axis === "horizontal" ? -length : 0)];
    })
    .filter((annotation) => rectsIntersect(annotationBounds(annotation), newBounds));
}

export function pointsBounds(points: Point[], padding = 0): AnnotationBounds {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs) - padding;
  const minY = Math.min(...ys) - padding;
  const maxX = Math.max(...xs) + padding;
  const maxY = Math.max(...ys) + padding;
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}

export function estimatedTextWidth(annotation: TextAnnotation): number {
  const padding = annotation.background ? TEXT_BACKGROUND_PADDING_X * 2 : 0;
  // Prefer the real measured glyph width when present; fall back to the rough
  // per-character estimate for drafts/legacy annotations that were never stamped.
  const glyphWidth = annotation.measuredWidth ?? annotation.text.length * annotation.fontSize * 0.58;
  return Math.max(annotation.fontSize, glyphWidth + padding);
}

export function annotationHitTest(annotation: Annotation, point: Point, tolerance: number): boolean {
  switch (annotation.kind) {
    case "pen":
      return polylineHitTest(annotation.points, point, Math.max(tolerance, annotation.width / 2));
    case "erase":
      return polylineHitTest(annotation.points, point, Math.max(tolerance, annotation.width / 2));
    case "arrow":
      return (
        distanceToSegment(point, annotation.start, annotation.end) <=
        Math.max(tolerance, annotation.width / 2)
      );
    case "shape":
      return shapeHitTest(annotation, point, Math.max(tolerance, annotation.width / 2));
    case "highlight":
      return rectContains(expandRect(annotation.rect, tolerance), point);
    case "blur":
      return rectContains(expandRect(annotation.rect, tolerance), point);
    case "cut":
      return rectContains(expandRect(annotationBounds(annotation), tolerance), point);
    case "text":
      return rectContains(expandRect(annotationBounds(annotation), tolerance), point);
  }
}

export function cutSeamPoints(seam: CutSeamAnnotation): Point[] {
  const points: Point[] = [];
  const teeth = Math.max(1, Math.round(seam.span / seam.period));
  for (let i = 0; i <= teeth; i += 1) {
    const along = seam.start + (seam.span * i) / teeth;
    const off = seam.position + (i % 2 === 0 ? -seam.amplitude : seam.amplitude);
    points.push(
      seam.orientation === "horizontal" ? { x: along, y: off } : { x: off, y: along }
    );
  }
  return points;
}

export function polylineHitTest(points: Point[], point: Point, tolerance: number): boolean {
  // Callers only pass committed pen strokes, which always have >= 2 points
  // (finishPenStroke rejects shorter drafts).
  for (let index = 1; index < points.length; index += 1) {
    if (distanceToSegment(point, points[index - 1], points[index]) <= tolerance) return true;
  }
  return false;
}

// Vertices for the polygon-based shapes (triangle, diamond) inscribed in the
// shape's bounding rect, in draw order. Rectangle and ellipse have their own
// dedicated geometry and return null here. Shared by the SVG renderer
// (EditorStage), the canvas export (annotationRendering), and hit testing so
// all three agree on the exact outline.
export function shapeOutlinePoints(shape: ShapeKind, rect: CropRect): Point[] | null {
  if (shape === "triangle" || shape === "diamond") return polygonShapePoints(shape, rect);
  return null;
}

export function polygonShapePoints(shape: PolygonShapeKind, rect: CropRect): Point[] {
  const { x, y, width, height } = rect;
  switch (shape) {
    case "triangle":
      return [
        { x: x + width / 2, y },
        { x: x + width, y: y + height },
        { x, y: y + height }
      ];
    case "diamond":
      return [
        { x: x + width / 2, y },
        { x: x + width, y: y + height / 2 },
        { x: x + width / 2, y: y + height },
        { x, y: y + height / 2 }
      ];
  }
}

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  // Ray-casting (even-odd rule). Counts edge crossings of a ray cast to +x.
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function shapeHitTest(shape: ShapeAnnotation, point: Point, tolerance: number): boolean {
  const rect = shape.rect;
  if (!rectContains(expandRect(rect, tolerance), point)) return false;
  if (shape.shape === "rectangle") {
    if (shape.fill && rectContains(rect, point)) return true;
    const nearX = Math.abs(point.x - rect.x) <= tolerance || Math.abs(point.x - (rect.x + rect.width)) <= tolerance;
    const nearY = Math.abs(point.y - rect.y) <= tolerance || Math.abs(point.y - (rect.y + rect.height)) <= tolerance;
    return (nearX && point.y >= rect.y - tolerance && point.y <= rect.y + rect.height + tolerance) ||
      (nearY && point.x >= rect.x - tolerance && point.x <= rect.x + rect.width + tolerance);
  }

  const polygon = shapeOutlinePoints(shape.shape, rect);
  if (polygon) {
    if (shape.fill && pointInPolygon(point, polygon)) return true;
    for (let i = 0; i < polygon.length; i += 1) {
      const next = polygon[(i + 1) % polygon.length];
      if (distanceToSegment(point, polygon[i], next) <= tolerance) return true;
    }
    return false;
  }

  const rx = rect.width / 2;
  const ry = rect.height / 2;
  if (rx <= 0 || ry <= 0) return false;
  const nx = (point.x - (rect.x + rx)) / rx;
  const ny = (point.y - (rect.y + ry)) / ry;
  const value = nx * nx + ny * ny;
  if (shape.fill && value <= 1) return true;
  const outerRx = rx + tolerance;
  const outerRy = ry + tolerance;
  const innerRx = Math.max(1, rx - tolerance);
  const innerRy = Math.max(1, ry - tolerance);
  const outer =
    ((point.x - (rect.x + rx)) / outerRx) ** 2 + ((point.y - (rect.y + ry)) / outerRy) ** 2;
  const inner =
    ((point.x - (rect.x + rx)) / innerRx) ** 2 + ((point.y - (rect.y + ry)) / innerRy) ** 2;
  return outer <= 1 && inner >= 1;
}

export function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  const projection = {
    x: start.x + t * dx,
    y: start.y + t * dy
  };
  return Math.hypot(point.x - projection.x, point.y - projection.y);
}

export function rectContains(rect: CropRect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

export function expandRect(rect: CropRect, amount: number): CropRect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2
  };
}

export function translateAnnotation(annotation: Annotation, dx: number, dy: number): Annotation {
  switch (annotation.kind) {
    case "pen":
      return {
        ...annotation,
        points: annotation.points.map((point) => ({ x: point.x + dx, y: point.y + dy }))
      };
    case "erase":
      return {
        ...annotation,
        points: annotation.points.map((point) => ({ x: point.x + dx, y: point.y + dy }))
      };
    case "arrow":
      return {
        ...annotation,
        start: { x: annotation.start.x + dx, y: annotation.start.y + dy },
        end: { x: annotation.end.x + dx, y: annotation.end.y + dy }
      };
    case "shape":
      return {
        ...annotation,
        rect: { ...annotation.rect, x: annotation.rect.x + dx, y: annotation.rect.y + dy }
      };
    case "highlight":
      return {
        ...annotation,
        rect: { ...annotation.rect, x: annotation.rect.x + dx, y: annotation.rect.y + dy }
      };
    case "blur":
      return {
        ...annotation,
        rect: { ...annotation.rect, x: annotation.rect.x + dx, y: annotation.rect.y + dy }
      };
    case "text":
      return {
        ...annotation,
        position: { x: annotation.position.x + dx, y: annotation.position.y + dy }
      };
    case "cut":
      return annotation.orientation === "horizontal"
        ? { ...annotation, position: annotation.position + dy, start: annotation.start + dx }
        : { ...annotation, position: annotation.position + dx, start: annotation.start + dy };
  }
}

// Accepts user/picker input in `#rgb`, `rgb`, `#rrggbb`, or `rrggbb` form and
// returns a canonical lowercase `#rrggbb`, or null if it is not a valid hex
// color. Used to validate the custom hex field before applying it.
export function normalizeHexColor(input: string): string | null {
  const hex = input.trim().replace(/^#/, "").toLowerCase();
  if (!/^([\da-f]{3}|[\da-f]{6})$/.test(hex)) return null;
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((part) => `${part}${part}`)
          .join("")
      : hex;
  return `#${full}`;
}

export function rgbToHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0"))
    .join("")}`;
}

export function colorWithAlpha(color: string, alpha: number): string | null {
  const hex = color.trim().replace(/^#/, "");
  const normalized =
    hex.length === 3
      ? hex
          .split("")
          .map((part) => `${part}${part}`)
          .join("")
      : hex;
  if (!/^[\da-f]{6}$/i.test(normalized)) return null;
  const value = Number.parseInt(normalized, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(1, alpha))})`;
}
