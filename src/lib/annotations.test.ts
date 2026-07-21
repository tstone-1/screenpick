import { describe, expect, it } from "vitest";

import {
  annotationBounds,
  annotationHitTest,
  annotationLayer,
  annotationsInPaintOrder,
  annotationsInVisualHitOrder,
  colorWithAlpha,
  cropAnnotations,
  cutoutAnnotations,
  cutSeamPoints,
  distanceToSegment,
  normalizeHexColor,
  pointInPolygon,
  pointsBounds,
  rectsIntersect,
  rgbToHex,
  shapeHitTest,
  shapeOutlinePoints,
  translateAnnotation,
  type Annotation,
  type CutSeamAnnotation,
  type ShapeAnnotation,
  type ShapeKind,
  type TextAnnotation
} from "./annotations";

function cutSeam(patch: Partial<CutSeamAnnotation> = {}): CutSeamAnnotation {
  return {
    kind: "cut",
    id: 100,
    orientation: "horizontal",
    position: 40,
    start: 0,
    span: 80,
    color: "#ffffff",
    width: 2,
    amplitude: 6,
    period: 20,
    ...patch
  };
}

describe("colorWithAlpha", () => {
  it("parses 6-digit hex", () => {
    expect(colorWithAlpha("#aabbcc", 0.5)).toBe("rgba(170, 187, 204, 0.5)");
  });

  it("expands 3-digit hex", () => {
    expect(colorWithAlpha("#abc", 0.5)).toBe("rgba(170, 187, 204, 0.5)");
  });

  it("rejects invalid hex", () => {
    expect(colorWithAlpha("zzz", 1)).toBeNull();
    expect(colorWithAlpha("#12", 1)).toBeNull();
  });

  it("clamps alpha to [0, 1]", () => {
    expect(colorWithAlpha("#000000", 5)).toBe("rgba(0, 0, 0, 1)");
    expect(colorWithAlpha("#000000", -2)).toBe("rgba(0, 0, 0, 0)");
  });
});

describe("rgbToHex", () => {
  it("formats and pads channels", () => {
    expect(rgbToHex(0, 0, 0)).toBe("#000000");
    expect(rgbToHex(255, 16, 1)).toBe("#ff1001");
  });

  it("clamps out-of-range channels", () => {
    expect(rgbToHex(-5, 300, 128)).toBe("#00ff80");
  });
});

describe("distanceToSegment", () => {
  it("returns point distance for a zero-length segment", () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(5);
  });

  it("projects onto the segment interior", () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3);
  });

  it("clamps the projection to the endpoints", () => {
    expect(distanceToSegment({ x: -4, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(4);
  });
});

describe("pointsBounds", () => {
  it("returns a zero rect for no points", () => {
    expect(pointsBounds([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("applies padding and enforces a minimum size", () => {
    const bounds = pointsBounds([{ x: 5, y: 5 }], 3);
    expect(bounds.x).toBe(2);
    expect(bounds.y).toBe(2);
    expect(bounds.width).toBeGreaterThanOrEqual(1);
    expect(bounds.height).toBeGreaterThanOrEqual(1);
  });
});

const ellipse = (fill: boolean): ShapeAnnotation => ({
  kind: "shape",
  id: 1,
  shape: "ellipse",
  rect: { x: 0, y: 0, width: 100, height: 100 },
  color: "#000000",
  width: 2,
  fill,
  fillOpacity: 0.2
});

describe("shapeHitTest (ellipse)", () => {
  it("hits a point on the unfilled stroke ring", () => {
    expect(shapeHitTest(ellipse(false), { x: 0, y: 50 }, 4)).toBe(true);
  });

  it("misses the hollow interior when unfilled", () => {
    expect(shapeHitTest(ellipse(false), { x: 50, y: 50 }, 4)).toBe(false);
  });

  it("hits the interior when filled", () => {
    expect(shapeHitTest(ellipse(true), { x: 50, y: 50 }, 4)).toBe(true);
  });
});

const polyShape = (shape: ShapeKind, fill: boolean): ShapeAnnotation => ({
  kind: "shape",
  id: 1,
  shape,
  rect: { x: 0, y: 0, width: 100, height: 100 },
  color: "#000000",
  width: 2,
  fill,
  fillOpacity: 0.2
});

describe("shapeOutlinePoints", () => {
  it("returns null for rectangle and ellipse (they have dedicated geometry)", () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(shapeOutlinePoints("rectangle", rect)).toBeNull();
    expect(shapeOutlinePoints("ellipse", rect)).toBeNull();
  });

  it("inscribes a triangle in the bounding rect (apex top-center)", () => {
    expect(shapeOutlinePoints("triangle", { x: 0, y: 0, width: 100, height: 80 })).toEqual([
      { x: 50, y: 0 },
      { x: 100, y: 80 },
      { x: 0, y: 80 }
    ]);
  });

  it("inscribes a diamond touching all four edge midpoints", () => {
    expect(shapeOutlinePoints("diamond", { x: 0, y: 0, width: 100, height: 80 })).toEqual([
      { x: 50, y: 0 },
      { x: 100, y: 40 },
      { x: 50, y: 80 },
      { x: 0, y: 40 }
    ]);
  });
});

describe("pointInPolygon", () => {
  const triangle = shapeOutlinePoints("triangle", { x: 0, y: 0, width: 100, height: 100 })!;

  it("includes an interior point", () => {
    expect(pointInPolygon({ x: 50, y: 60 }, triangle)).toBe(true);
  });

  it("excludes a point outside the slanted edge", () => {
    // Near the top corner, well outside the narrow apex of the triangle.
    expect(pointInPolygon({ x: 5, y: 5 }, triangle)).toBe(false);
  });
});

describe("shapeHitTest (polygon shapes)", () => {
  it("hits a triangle's stroke edge when unfilled", () => {
    // Midpoint of the bottom edge.
    expect(shapeHitTest(polyShape("triangle", false), { x: 50, y: 100 }, 4)).toBe(true);
  });

  it("misses a triangle's hollow interior when unfilled", () => {
    expect(shapeHitTest(polyShape("triangle", false), { x: 50, y: 60 }, 4)).toBe(false);
  });

  it("hits a triangle's interior when filled", () => {
    expect(shapeHitTest(polyShape("triangle", true), { x: 50, y: 60 }, 4)).toBe(true);
  });

  it("misses the empty corner above a triangle's slanted edge even when filled", () => {
    expect(shapeHitTest(polyShape("triangle", true), { x: 5, y: 5 }, 4)).toBe(false);
  });

  it("hits a diamond's interior when filled", () => {
    expect(shapeHitTest(polyShape("diamond", true), { x: 50, y: 50 }, 4)).toBe(true);
  });

  it("misses a diamond's clipped corner when filled", () => {
    expect(shapeHitTest(polyShape("diamond", true), { x: 5, y: 5 }, 4)).toBe(false);
  });
});

describe("normalizeHexColor", () => {
  it("canonicalizes 6-digit hex to lowercase with a leading hash", () => {
    expect(normalizeHexColor("#AABBCC")).toBe("#aabbcc");
    expect(normalizeHexColor("aabbcc")).toBe("#aabbcc");
  });

  it("expands 3-digit shorthand", () => {
    expect(normalizeHexColor("#abc")).toBe("#aabbcc");
    expect(normalizeHexColor("ABC")).toBe("#aabbcc");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeHexColor("  #1c7c6d  ")).toBe("#1c7c6d");
  });

  it("rejects invalid input", () => {
    expect(normalizeHexColor("")).toBeNull();
    expect(normalizeHexColor("#12")).toBeNull();
    expect(normalizeHexColor("#12345")).toBeNull();
    expect(normalizeHexColor("zzzzzz")).toBeNull();
    expect(normalizeHexColor("rgb(1,2,3)")).toBeNull();
  });
});

describe("annotationBounds", () => {
  it("passes a shape rect through unchanged", () => {
    expect(annotationBounds(ellipse(false))).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it("estimates a text box including background padding", () => {
    const text: TextAnnotation = {
      kind: "text",
      id: 2,
      position: { x: 10, y: 20 },
      text: "ab",
      color: "#000000",
      fontSize: 24,
      background: true,
      backgroundOpacity: 0.72
    };
    const bounds = annotationBounds(text);
    expect(bounds.x).toBe(10);
    expect(bounds.y).toBe(20);
    expect(bounds.height).toBeCloseTo(24 * 1.2 + 2 * 2);
    expect(bounds.width).toBeGreaterThan(24);
  });

  it("prefers a stamped measuredWidth over the per-char estimate", () => {
    const base: TextAnnotation = {
      kind: "text",
      id: 2,
      position: { x: 0, y: 0 },
      text: "WWWW",
      color: "#000000",
      fontSize: 24,
      background: true,
      backgroundOpacity: 1
    };
    // measuredWidth is the real glyph width; bounds = measuredWidth + padding.
    const measured = annotationBounds({ ...base, measuredWidth: 200 });
    expect(measured.width).toBeCloseTo(200 + 6 * 2);
    // Without it, bounds fall back to the rough length*fontSize*0.58 estimate,
    // which differs from the measured value.
    const estimated = annotationBounds(base);
    expect(estimated.width).not.toBeCloseTo(measured.width);
  });

  it("bounds a cut seam around its sawtooth amplitude", () => {
    expect(annotationBounds(cutSeam())).toEqual({ x: 0, y: 34, width: 80, height: 12 });
    expect(annotationBounds(cutSeam({ orientation: "vertical" }))).toEqual({
      x: 34,
      y: 0,
      width: 12,
      height: 80
    });
  });
});

describe("annotationHitTest", () => {
  it("hits within a highlight rect expanded by tolerance", () => {
    const highlight: Annotation = {
      kind: "highlight",
      id: 3,
      rect: { x: 0, y: 0, width: 20, height: 20 },
      color: "#ffff00",
      opacity: 0.35
    };
    expect(annotationHitTest(highlight, { x: -2, y: 10 }, 4)).toBe(true);
    expect(annotationHitTest(highlight, { x: -10, y: 10 }, 4)).toBe(false);
  });

  it("hits cut seams by their bounds", () => {
    expect(annotationHitTest(cutSeam(), { x: 20, y: 40 }, 1)).toBe(true);
    expect(annotationHitTest(cutSeam(), { x: 20, y: 20 }, 1)).toBe(false);
  });
});

describe("translateAnnotation", () => {
  it("moves a pen stroke's points", () => {
    const pen: Annotation = {
      kind: "pen",
      id: 4,
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      color: "#000000",
      width: 4
    };
    const moved = translateAnnotation(pen, 5, -3);
    expect(moved).toMatchObject({
      points: [{ x: 5, y: -3 }, { x: 15, y: 7 }]
    });
  });

  it("does not mutate the original annotation", () => {
    const shape = ellipse(false);
    const moved = translateAnnotation(shape, 10, 10) as ShapeAnnotation;
    expect(shape.rect.x).toBe(0);
    expect(moved.rect.x).toBe(10);
  });

  it("moves cut seam position and start on the relevant axes", () => {
    expect(translateAnnotation(cutSeam(), 5, -3)).toMatchObject({
      position: 37,
      start: 5
    });
    expect(translateAnnotation(cutSeam({ orientation: "vertical" }), 5, -3)).toMatchObject({
      position: 45,
      start: -3
    });
  });
});

describe("cutSeamPoints", () => {
  it("builds alternating horizontal sawtooth points", () => {
    expect(cutSeamPoints(cutSeam({ span: 40, period: 20, position: 30, amplitude: 5 }))).toEqual([
      { x: 0, y: 25 },
      { x: 20, y: 35 },
      { x: 40, y: 25 }
    ]);
  });

  it("builds vertical sawtooth points", () => {
    expect(
      cutSeamPoints(cutSeam({ orientation: "vertical", span: 40, period: 20, position: 30, amplitude: 5 }))
    ).toEqual([
      { x: 25, y: 0 },
      { x: 35, y: 20 },
      { x: 25, y: 40 }
    ]);
  });
});

describe("rectsIntersect", () => {
  it("returns true for overlapping and contained rects", () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsIntersect({ x: 0, y: 0, width: 20, height: 20 }, { x: 5, y: 5, width: 5, height: 5 })).toBe(true);
  });

  it("returns false for disjoint rects and touching edges", () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 11, y: 0, width: 10, height: 10 })).toBe(false);
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
  });
});

describe("cropAnnotations", () => {
  it("keeps every annotation kind inside the crop and translates coordinates", () => {
    const annotations: Annotation[] = [
      { kind: "pen", id: 1, points: [{ x: 20, y: 30 }, { x: 25, y: 35 }], color: "#000", width: 2 },
      { kind: "arrow", id: 2, start: { x: 30, y: 40 }, end: { x: 45, y: 55 }, color: "#000", width: 3 },
      {
        kind: "shape",
        id: 3,
        shape: "rectangle",
        rect: { x: 50, y: 60, width: 20, height: 10 },
        color: "#000",
        width: 2,
        fill: false,
        fillOpacity: 0.2
      },
      {
        kind: "highlight",
        id: 4,
        rect: { x: 65, y: 70, width: 10, height: 10 },
        color: "#ff0",
        opacity: 0.3
      },
      { kind: "blur", id: 5, rect: { x: 75, y: 80, width: 10, height: 10 }, radius: 8 },
      {
        kind: "text",
        id: 6,
        position: { x: 85, y: 90 },
        text: "label",
        color: "#000",
        fontSize: 16,
        background: false,
        backgroundOpacity: 1
      }
    ];

    expect(cropAnnotations(annotations, 10, 20, 100, 100)).toEqual([
      { ...annotations[0], points: [{ x: 10, y: 10 }, { x: 15, y: 15 }] },
      { ...annotations[1], start: { x: 20, y: 20 }, end: { x: 35, y: 35 } },
      { ...annotations[2], rect: { x: 40, y: 40, width: 20, height: 10 } },
      { ...annotations[3], rect: { x: 55, y: 50, width: 10, height: 10 } },
      { ...annotations[4], rect: { x: 65, y: 60, width: 10, height: 10 } },
      { ...annotations[5], position: { x: 75, y: 70 } }
    ]);
  });

  it("drops annotations entirely outside, keeps edge straddlers, and preserves order and ids", () => {
    const outside: Annotation = {
      kind: "shape",
      id: 10,
      shape: "rectangle",
      rect: { x: 200, y: 200, width: 10, height: 10 },
      color: "#000",
      width: 2,
      fill: false,
      fillOpacity: 0.2
    };
    const straddling: Annotation = {
      kind: "highlight",
      id: 11,
      rect: { x: 5, y: 12, width: 10, height: 10 },
      color: "#ff0",
      opacity: 0.3
    };
    const inside: Annotation = {
      kind: "text",
      id: 12,
      position: { x: 25, y: 30 },
      text: "kept",
      color: "#000",
      fontSize: 12,
      background: false,
      backgroundOpacity: 1
    };

    const cropped = cropAnnotations([outside, straddling, inside], 10, 10, 30, 30);

    expect(cropped.map((annotation) => annotation.id)).toEqual([11, 12]);
    expect(cropped[0]).toMatchObject({ rect: { x: -5, y: 2, width: 10, height: 10 } });
    expect(cropped[1]).toMatchObject({ position: { x: 15, y: 20 } });
  });
});

describe("cutoutAnnotations", () => {
  it("keeps above annotations, shifts below annotations, and drops fully removed annotations", () => {
    const above: Annotation = { ...ellipse(false), id: 1, rect: { x: 10, y: 10, width: 20, height: 10 } };
    const removed: Annotation = { ...ellipse(false), id: 2, rect: { x: 10, y: 45, width: 20, height: 10 } };
    const below: Annotation = { ...ellipse(false), id: 3, rect: { x: 10, y: 80, width: 20, height: 10 } };
    const straddlingTop: Annotation = { ...ellipse(false), id: 4, rect: { x: 10, y: 35, width: 20, height: 20 } };

    const result = cutoutAnnotations([above, removed, below, straddlingTop], "horizontal", 40, 20, 100, 80);

    expect(result).toEqual([
      above,
      { ...below, rect: { x: 10, y: 60, width: 20, height: 10 } },
      straddlingTop
    ]);
  });

  it("handles vertical cuts symmetrically and filters survivors outside the new bounds", () => {
    const left: Annotation = { ...ellipse(false), id: 1, rect: { x: 10, y: 10, width: 10, height: 10 } };
    const removed: Annotation = { ...ellipse(false), id: 2, rect: { x: 45, y: 10, width: 10, height: 10 } };
    const right: Annotation = { ...ellipse(false), id: 3, rect: { x: 80, y: 10, width: 10, height: 10 } };
    const outsideAfterShift: Annotation = { ...ellipse(false), id: 4, rect: { x: 120, y: 10, width: 10, height: 10 } };

    const result = cutoutAnnotations(
      [left, removed, right, outsideAfterShift],
      "vertical",
      40,
      20,
      80,
      100
    );

    expect(result).toEqual([left, { ...right, rect: { x: 60, y: 10, width: 10, height: 10 } }]);
  });
});

describe("annotationsInVisualHitOrder", () => {
  it("orders text, middle, highlight, blur, then cut (newest-first within a layer)", () => {
    const blur: Annotation = { kind: "blur", id: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, radius: 10 };
    const highlight: Annotation = { kind: "highlight", id: 2, rect: { x: 0, y: 0, width: 1, height: 1 }, color: "#ff0", opacity: 0.3 };
    const pen1: Annotation = { kind: "pen", id: 3, points: [{ x: 0, y: 0 }], color: "#000", width: 2 };
    const text: Annotation = { kind: "text", id: 4, position: { x: 0, y: 0 }, text: "x", color: "#000", fontSize: 12, background: false, backgroundOpacity: 1 };
    const pen2: Annotation = { kind: "pen", id: 5, points: [{ x: 0, y: 0 }], color: "#000", width: 2 };
    const cut: Annotation = cutSeam({ id: 6 });

    const order = annotationsInVisualHitOrder([blur, highlight, pen1, text, cut, pen2]).map((a) => a.id);
    expect(order).toEqual([4, 5, 3, 2, 1, 6]);
  });
});

describe("annotationLayer", () => {
  it("returns the fixed stacking layer for each annotation kind", () => {
    expect(annotationLayer({ kind: "blur", id: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, radius: 10 })).toBe("blur");
    expect(annotationLayer({ kind: "highlight", id: 2, rect: { x: 0, y: 0, width: 1, height: 1 }, color: "#ff0", opacity: 0.3 })).toBe("highlight");
    expect(annotationLayer({ kind: "pen", id: 3, points: [{ x: 0, y: 0 }], color: "#000", width: 2 })).toBe("middle");
    expect(annotationLayer({ kind: "arrow", id: 4, start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, color: "#000", width: 2 })).toBe("middle");
    expect(annotationLayer({ kind: "shape", id: 5, shape: "rectangle", rect: { x: 0, y: 0, width: 1, height: 1 }, color: "#000", width: 2, fill: false, fillOpacity: 0.2 })).toBe("middle");
    expect(annotationLayer({ kind: "text", id: 6, position: { x: 0, y: 0 }, text: "x", color: "#000", fontSize: 12, background: false, backgroundOpacity: 1 })).toBe("text");
    expect(annotationLayer(cutSeam({ id: 7 }))).toBe("cut");
    expect(annotationLayer({ kind: "erase", id: 8, points: [{ x: 0, y: 0 }], width: 10, color: null })).toBe("erase");
  });
});

describe("erase strokes", () => {
  const erase: Annotation = {
    kind: "erase",
    id: 9,
    points: [
      { x: 10, y: 10 },
      { x: 30, y: 10 }
    ],
    width: 8,
    color: null
  };

  it("paints first (bottom of the stack) and hit-tests last (top-to-bottom)", () => {
    const blur: Annotation = { kind: "blur", id: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, radius: 10 };
    const cut: Annotation = cutSeam({ id: 2 });

    expect(annotationsInPaintOrder([blur, cut, erase]).map((a) => a.id)).toEqual([9, 2, 1]);
    expect(annotationsInVisualHitOrder([blur, cut, erase]).map((a) => a.id)).toEqual([1, 2, 9]);
  });

  it("bounds expand by half the brush width", () => {
    expect(annotationBounds(erase)).toEqual({ x: 6, y: 6, width: 28, height: 8 });
  });

  it("hit-tests along the brush path", () => {
    expect(annotationHitTest(erase, { x: 20, y: 11 }, 1)).toBe(true);
    expect(annotationHitTest(erase, { x: 20, y: 40 }, 1)).toBe(false);
  });

  it("translates every point", () => {
    const moved = translateAnnotation(erase, 5, -3);
    expect(moved).toMatchObject({
      kind: "erase",
      points: [
        { x: 15, y: 7 },
        { x: 35, y: 7 }
      ]
    });
  });
});

describe("annotationsInPaintOrder", () => {
  it("orders cut, blur, highlight, middle, then text while preserving array order within layers", () => {
    const blur: Annotation = { kind: "blur", id: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, radius: 10 };
    const highlight: Annotation = { kind: "highlight", id: 2, rect: { x: 0, y: 0, width: 1, height: 1 }, color: "#ff0", opacity: 0.3 };
    const pen1: Annotation = { kind: "pen", id: 3, points: [{ x: 0, y: 0 }], color: "#000", width: 2 };
    const text: Annotation = { kind: "text", id: 4, position: { x: 0, y: 0 }, text: "x", color: "#000", fontSize: 12, background: false, backgroundOpacity: 1 };
    const pen2: Annotation = { kind: "pen", id: 5, points: [{ x: 0, y: 0 }], color: "#000", width: 2 };
    const cut: Annotation = cutSeam({ id: 6 });

    const order = annotationsInPaintOrder([pen1, text, blur, cut, pen2, highlight]).map((a) => a.id);
    expect(order).toEqual([6, 1, 2, 3, 5, 4]);
  });
});
