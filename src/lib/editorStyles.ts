import type { AnnotationBounds, CropRect } from "./annotations";
import type { SampledColor } from "./editor.svelte";

// Pure inline-style helpers consumed by EditorStage.svelte. Lives outside
// editor.svelte.ts because these are presentation-only (build a CSS string
// from a rect plus zoom) and have nothing to do with the editor's domain
// state machine — putting them in the editor class mixed presentation with
// state and made the class harder to read.

const SELECTION_OUTLINE_PADDING_PX = 5;

export function cropStyle(rect: CropRect, zoom: number): string {
  return `left: ${rect.x * zoom}px; top: ${rect.y * zoom}px; width: ${rect.width * zoom}px; height: ${rect.height * zoom}px;`;
}

export function eraserStyle(
  pointer: { x: number; y: number } | null,
  radius: number,
  zoom: number
): string {
  if (!pointer) return "";
  const r = radius * zoom;
  return `left: ${pointer.x * zoom - r}px; top: ${pointer.y * zoom - r}px; width: ${r * 2}px; height: ${r * 2}px;`;
}

export function selectionStyle(bounds: AnnotationBounds, zoom: number): string {
  const padding = SELECTION_OUTLINE_PADDING_PX;
  return `left: ${bounds.x * zoom - padding}px; top: ${bounds.y * zoom - padding}px; width: ${bounds.width * zoom + padding * 2}px; height: ${bounds.height * zoom + padding * 2}px;`;
}

export function samplePreviewStyle(sample: SampledColor | null, zoom: number): string {
  if (!sample) return "";
  const size = 28;
  return `left: ${sample.point.x * zoom - size / 2}px; top: ${sample.point.y * zoom - size / 2}px;`;
}
