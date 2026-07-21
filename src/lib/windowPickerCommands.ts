import { commands, type CaptureResult, type WindowBounds } from "./bindings";

type CommandResult<T> = Promise<{ status: "ok"; data: T } | { status: "error"; error: string }>;

export type StrictWindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function finishWindowPointSelection(x: number, y: number): CommandResult<CaptureResult> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return Promise.resolve({ status: "error", error: "Window selection point is invalid." });
  }
  return commands.finishWindowPointSelection(x, y);
}

export async function windowRectAtPoint(x: number, y: number): CommandResult<StrictWindowBounds | null> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { status: "error", error: "Window pointer position is invalid." };
  }

  const result = await commands.windowRectAtPoint(x, y);
  if (result.status === "error") return result;
  if (result.data === null) return { status: "ok", data: null };

  const bounds = strictWindowBounds(result.data);
  if (!bounds) {
    return { status: "error", error: "Window bounds are invalid." };
  }
  return { status: "ok", data: bounds };
}

function strictWindowBounds(bounds: WindowBounds): StrictWindowBounds | null {
  const { x, y, width, height } = bounds;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
    return null;
  }
  return { x, y, width, height };
}

function isFiniteNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
