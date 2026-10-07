import { describe, expect, it } from "vitest";

import {
  arrowGeometry,
  drawAnnotation,
  measureTextWidth,
  smoothedStrokePoints,
  strokePath,
  textStyle,
  type ArrowGeometry
} from "./annotationRendering";
import type {
  ArrowAnnotation,
  BlurAnnotation,
  EraseStroke,
  HighlightAnnotation,
  PenStroke,
  ShapeAnnotation,
  TextAnnotation
} from "./annotations";

// Minimal canvas 2D context double that records which drawing primitives were
// called, so the export dispatch can be asserted without a real canvas (the
// test env is Node, no DOM/canvas backend).
function recordingContext() {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (..._args: unknown[]) => {
      calls.push(name);
    };
  const ctx = {
    calls,
    canvas: { width: 1000, height: 1000 },
    save: record("save"),
    restore: record("restore"),
    beginPath: record("beginPath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    quadraticCurveTo: record("quadraticCurveTo"),
    closePath: record("closePath"),
    stroke: record("stroke"),
    fill: record("fill"),
    fillRect: record("fillRect"),
    strokeRect: record("strokeRect"),
    ellipse: record("ellipse"),
    arc: record("arc"),
    rect: record("rect"),
    clip: record("clip"),
    drawImage: record("drawImage"),
    fillText: record("fillText"),
    measureText: (text: string) => {
      calls.push("measureText");
      return { width: text.length * 10 } as TextMetrics;
    }
  };
  return ctx;
}

function asContext(ctx: ReturnType<typeof recordingContext>): CanvasRenderingContext2D {
  return ctx as unknown as CanvasRenderingContext2D;
}

describe("strokePath", () => {
  it("returns an empty path for an empty stroke", () => {
    const stroke: PenStroke = { kind: "pen", id: 1, points: [], color: "#000000", width: 4 };

    expect(strokePath(stroke)).toBe("");
  });

  it("formats points as SVG path commands", () => {
    const stroke: PenStroke = {
      kind: "pen",
      id: 1,
      points: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
        { x: 5, y: 6 }
      ],
      color: "#000000",
      width: 4
    };

    // Points on one line stay where they are; the middle one becomes the
    // control of a curve that ends halfway to the last.
    expect(strokePath(stroke)).toBe("M 1 2 Q 3 4 4 5 L 5 6");
  });

  it("draws a two-point stroke as one straight segment", () => {
    const stroke: PenStroke = {
      kind: "pen",
      id: 1,
      points: [
        { x: 1, y: 2 },
        { x: 3, y: 4 }
      ],
      color: "#000000",
      width: 4
    };

    expect(strokePath(stroke)).toBe("M 1 2 L 3 4");
  });
});

describe("smoothedStrokePoints", () => {
  // A slow horizontal stroke that steps down one image pixel, as whole-pixel
  // pointer positions give it.
  const step = Array.from({ length: 21 }, (_, x) => ({ x, y: x < 10 ? 0 : 1 }));

  it("keeps the first and the last point and spreads a one-pixel step", () => {
    const smoothed = smoothedStrokePoints(step);

    expect(smoothed[0]).toEqual({ x: 0, y: 0 });
    expect(smoothed[20]).toEqual({ x: 20, y: 1 });
    // The step from 0 to 1 between x = 9 and x = 10 becomes a slope.
    expect(smoothed[9].y).toBeGreaterThan(0.1);
    expect(smoothed[10].y).toBeLessThan(0.9);
    for (let x = 1; x <= 20; x += 1) {
      expect(smoothed[x].y).toBeGreaterThanOrEqual(smoothed[x - 1].y);
    }
  });

  // The radius is a distance in image pixels. A fast stroke has its points far
  // apart, and each of them is a place the hand went: none may move.
  it("leaves a stroke alone whose points lie further apart than the radius", () => {
    const fast = [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 60 },
      { x: 0, y: 60 }
    ];

    expect(smoothedStrokePoints(fast)).toEqual(fast);
  });

  // Many points one pixel apart around a corner: the corner is rounded within
  // a few pixels and the stroke further away is not moved.
  it("changes a dense stroke only near the place that is not smooth", () => {
    const corner = [
      ...Array.from({ length: 41 }, (_, i) => ({ x: i, y: 0 })),
      ...Array.from({ length: 40 }, (_, i) => ({ x: 40, y: i + 1 }))
    ];
    const smoothed = smoothedStrokePoints(corner);

    expect(smoothed[40].x).toBeLessThan(40);
    expect(smoothed[40].y).toBeGreaterThan(0);
    expect(smoothed[20].x).toBeCloseTo(20, 6);
    expect(smoothed[20].y).toBeCloseTo(0, 6);
    expect(smoothed[60].x).toBeCloseTo(40, 6);
    expect(smoothed[60].y).toBeCloseTo(20, 6);
  });

  it("leaves a stroke of two points as it is", () => {
    expect(smoothedStrokePoints(step.slice(0, 2))).toEqual(step.slice(0, 2));
  });

  it("gives the stage and the export the same curve", () => {
    const stroke: PenStroke = { kind: "pen", id: 1, points: step, color: "#000000", width: 4 };
    const drawn: string[] = [];
    const ctx = {
      save() {},
      restore() {},
      beginPath() {},
      stroke() {},
      moveTo: (x: number, y: number) => drawn.push(`M ${x} ${y}`),
      lineTo: (x: number, y: number) => drawn.push(`L ${x} ${y}`),
      quadraticCurveTo: (cx: number, cy: number, x: number, y: number) =>
        drawn.push(`Q ${cx} ${cy} ${x} ${y}`)
    };

    drawAnnotation(ctx as unknown as CanvasRenderingContext2D, stroke);

    expect(drawn.join(" ")).toBe(strokePath(stroke));
    expect(drawn.join(" ")).toContain("Q");
  });
});

describe("arrowGeometry", () => {
  const baseArrow = (endX: number, width = 4): ArrowAnnotation => ({
    kind: "arrow",
    id: 1,
    start: { x: 0, y: 0 },
    end: { x: endX, y: 0 },
    color: "#000000",
    width
  });

  it("omits line and head for a zero-length arrow", () => {
    expect(arrowGeometry(baseArrow(0))).toEqual({
      base: { x: 0, y: 0 },
      control: null,
      shaft: "",
      head: "",
      headPoints: null,
      hasLine: false
    });
  });

  it("hides the shaft when the arrow is shorter than its head", () => {
    const geometry = arrowGeometry(baseArrow(8));

    expect(geometry.hasLine).toBe(false);
    expect(geometry.headPoints).not.toBeNull();
  });

  // The stage and the export share this geometry, so it carries no zoom term:
  // width 4 gives a 16 x 10.4 head in image pixels at every zoom.
  it("sizes the head in image pixels from the stroke width alone", () => {
    const geometry: ArrowGeometry = arrowGeometry(baseArrow(100, 4));

    expect(geometry.base).toEqual({ x: 84, y: 0 });
    expect(geometry.head).toBe("100,0 84,5.2 84,-5.2");
    expect(geometry.hasLine).toBe(true);
    expect(geometry.shaft).toBe("M 0 0 L 84 0");
    expect(geometry.control).toBeNull();
  });

  describe("bent", () => {
    // Bent 30 pixels down at its middle; the head is 16 long at width 4.
    const bent: ArrowAnnotation = { ...baseArrow(100, 4), bend: { x: 50, y: 30 } };
    const geometry = arrowGeometry(bent);

    it("puts the base of the head on the curve, one head length before the tip", () => {
      expect(Math.hypot(100 - geometry.base.x, 0 - geometry.base.y)).toBeCloseTo(16, 3);
      // The curve comes up to the tip from below, so the base is below the
      // straight line; a head on the straight line would have y = 0.
      expect(geometry.base.y).toBeGreaterThan(5);
      expect(geometry.headPoints?.[0]).toEqual({ x: 100, y: 0 });
    });

    it("draws the shaft as one curve from the start to the base of the head", () => {
      expect(geometry.hasLine).toBe(true);
      expect(geometry.control).not.toBeNull();
      expect(geometry.shaft).toBe(
        `M 0 0 Q ${geometry.control?.x} ${geometry.control?.y} ${geometry.base.x} ${geometry.base.y}`
      );
    });

    it("keeps the shaft passing through the bend point", () => {
      // The shaft is the first part of the full curve, so some point of it is
      // the bend. Sample it and take the nearest.
      const control = geometry.control!;
      let nearest = Infinity;
      for (let i = 0; i <= 1000; i += 1) {
        const t = i / 1000;
        const u = 1 - t;
        const x = 2 * u * t * control.x + t * t * geometry.base.x;
        const y = 2 * u * t * control.y + t * t * geometry.base.y;
        nearest = Math.min(nearest, Math.hypot(x - 50, y - 30));
      }
      expect(nearest).toBeLessThan(0.1);
    });

    it("exports the shaft as a curve", () => {
      const ctx = recordingContext();
      drawAnnotation(asContext(ctx), bent);
      expect(ctx.calls).toContain("quadraticCurveTo");

      const straight = recordingContext();
      drawAnnotation(asContext(straight), baseArrow(100, 4));
      expect(straight.calls).not.toContain("quadraticCurveTo");
    });
  });
});

describe("textStyle", () => {
  const text = (background: boolean): TextAnnotation => ({
    kind: "text",
    id: 1,
    position: { x: 10, y: 20 },
    text: "Note",
    color: "#112233",
    fontSize: 24,
    background,
    backgroundOpacity: 0.5
  });

  it("scales position and font size by zoom", () => {
    expect(textStyle(text(false), 2)).toBe(
      "left: 20px; top: 40px; font-size: 48px; color: #112233;"
    );
  });

  it("adds scaled background box styling", () => {
    expect(textStyle(text(true), 2)).toBe(
      "left: 20px; top: 40px; font-size: 48px; color: #112233; padding: 4px 12px; border-radius: 8px; background-color: rgba(255, 255, 255, 0.5);"
    );
  });
});

describe("drawAnnotation (export dispatch)", () => {
  it("strokes a pen path", () => {
    const ctx = recordingContext();
    const pen: PenStroke = {
      kind: "pen",
      id: 1,
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 5 }
      ],
      color: "#000000",
      width: 4
    };
    drawAnnotation(asContext(ctx), pen);
    expect(ctx.calls).toContain("lineTo");
    expect(ctx.calls).toContain("stroke");
  });

  it("fills a highlight rect", () => {
    const ctx = recordingContext();
    const highlight: HighlightAnnotation = {
      kind: "highlight",
      id: 2,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      color: "#ffff00",
      opacity: 0.35
    };
    drawAnnotation(asContext(ctx), highlight);
    expect(ctx.calls).toContain("fillRect");
  });

  it("strokes a rectangle shape but only fills when filled", () => {
    const base: ShapeAnnotation = {
      kind: "shape",
      id: 3,
      shape: "rectangle",
      rect: { x: 0, y: 0, width: 10, height: 10 },
      color: "#222222",
      width: 2,
      fill: false,
      fillOpacity: 0.2
    };
    const outline = recordingContext();
    drawAnnotation(asContext(outline), base);
    expect(outline.calls).toContain("strokeRect");
    expect(outline.calls).not.toContain("fillRect");

    const filled = recordingContext();
    drawAnnotation(asContext(filled), { ...base, fill: true });
    expect(filled.calls).toContain("fillRect");
    expect(filled.calls).toContain("strokeRect");
  });

  it("fills an arrow head", () => {
    const ctx = recordingContext();
    const arrow: ArrowAnnotation = {
      kind: "arrow",
      id: 4,
      start: { x: 0, y: 0 },
      end: { x: 100, y: 0 },
      color: "#d73535",
      width: 4
    };
    drawAnnotation(asContext(ctx), arrow);
    expect(ctx.calls).toContain("fill");
  });

  it("measures and paints non-empty text, skips empty text", () => {
    const text: TextAnnotation = {
      kind: "text",
      id: 5,
      position: { x: 0, y: 0 },
      text: "Note",
      color: "#000000",
      fontSize: 24,
      background: true,
      backgroundOpacity: 1
    };
    const painted = recordingContext();
    drawAnnotation(asContext(painted), text);
    expect(painted.calls).toContain("measureText");
    expect(painted.calls).toContain("fillText");

    const empty = recordingContext();
    drawAnnotation(asContext(empty), { ...text, text: "" });
    expect(empty.calls).not.toContain("fillText");
  });

  it("draws nothing for a degenerate (zero-area) blur", () => {
    const ctx = recordingContext();
    const blur: BlurAnnotation = {
      kind: "blur",
      id: 6,
      rect: { x: 0, y: 0, width: 0, height: 20 },
      radius: 10
    };
    drawAnnotation(asContext(ctx), blur);
    expect(ctx.calls).toHaveLength(0);
  });

  it("erases to transparency via destination-out for a null-color brush", () => {
    const ctx = recordingContext();
    const erase: EraseStroke = {
      kind: "erase",
      id: 7,
      points: [
        { x: 0, y: 0 },
        { x: 20, y: 0 }
      ],
      width: 10,
      color: null
    };
    drawAnnotation(asContext(ctx), erase);
    expect(ctx.calls).toContain("stroke");
    // restore() is a no-op in the double, so the assigned mode persists.
    expect((ctx as unknown as { globalCompositeOperation?: string }).globalCompositeOperation).toBe(
      "destination-out"
    );
  });

  it("paints an opaque swath (no destination-out) for a colored brush", () => {
    const ctx = recordingContext();
    const erase: EraseStroke = {
      kind: "erase",
      id: 8,
      points: [
        { x: 0, y: 0 },
        { x: 20, y: 0 }
      ],
      width: 10,
      color: "#000000"
    };
    drawAnnotation(asContext(ctx), erase);
    expect(ctx.calls).toContain("stroke");
    expect(
      (ctx as unknown as { globalCompositeOperation?: string }).globalCompositeOperation
    ).toBeUndefined();
    expect((ctx as unknown as { strokeStyle?: string }).strokeStyle).toBe("#000000");
  });

  it("stamps a dot (arc + fill) for a single-point erase", () => {
    const ctx = recordingContext();
    const erase: EraseStroke = {
      kind: "erase",
      id: 9,
      points: [{ x: 5, y: 5 }],
      width: 12,
      color: null
    };
    drawAnnotation(asContext(ctx), erase);
    expect(ctx.calls).toContain("arc");
    expect(ctx.calls).toContain("fill");
    expect(ctx.calls).not.toContain("stroke");
  });
});

describe("measureTextWidth", () => {
  it("falls back to the per-char estimate without a canvas backend", () => {
    // The test env is Node (no document), so this exercises the fallback path.
    expect(measureTextWidth("abcd", 10)).toBeCloseTo(4 * 10 * 0.58);
  });
});
