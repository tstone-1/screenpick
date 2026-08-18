// @vitest-environment jsdom
//
// ROADMAP #11, window-selector leg. Beyond the Escape/confirm/pending trio,
// this overlay is the only picker that talks to the backend *while* the
// pointer moves: every pointermove can trigger a window_rect_at_point query
// that enumerates all windows. The route throttles that to one query per
// animation frame with a single-flight guard plus one trailing query, so the
// tests below pin the request pattern, not just the final commit -- an
// overlapping-query regression is invisible in the UI and only shows up as a
// laggy highlight on a machine with many windows open.
//
// Mocked at `./bindings` (the real IPC boundary) rather than at
// windowPickerCommands, so the route's actual command wrapper runs too --
// including its rejection of a rect with null fields.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

const commandsMock = vi.hoisted(() => ({
  finishWindowPointSelection: vi.fn(),
  windowRectAtPoint: vi.fn(),
  cancelWindowSelection: vi.fn()
}));

vi.mock("./bindings", () => ({
  commands: commandsMock
}));

import WindowSelectorPage from "../routes/window-selector/+page.svelte";

// The route itself never calls the pointer capture API, but keep the jsdom gap
// (https://github.com/jsdom/jsdom/issues/2527) covered so a future capture call
// in this route fails as a red test rather than a thrown "not a function".
beforeAll(() => {
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = vi.fn();
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  }
});

afterEach(() => {
  cleanup();
});

function pointerEvent(
  type: "pointerdown" | "pointermove",
  init: { clientX: number; clientY: number; pointerId?: number }
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  return event;
}

function mountOverlay() {
  const rendered = render(WindowSelectorPage);
  const main = rendered.container.querySelector("main");
  expect(main).not.toBeNull();
  return { ...rendered, main: main as HTMLElement };
}

function pressEscape() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

// The route coalesces pointermove into one query per animation frame, so a
// "nothing was queried" assertion has to outlive at least one frame to mean
// anything.
function nextFrames(count = 2): Promise<void> {
  return new Promise((resolve) => {
    let remaining = count;
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function rect(x: number, y: number, width: number, height: number) {
  return { status: "ok", data: { x, y, width, height } };
}

describe("window selector overlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commandsMock.finishWindowPointSelection.mockResolvedValue({ status: "ok", data: null });
    commandsMock.cancelWindowSelection.mockResolvedValue({ status: "ok", data: null });
    commandsMock.windowRectAtPoint.mockResolvedValue(rect(0, 0, 100, 100));
  });

  it("commits the pointer position on pointerdown", async () => {
    const { main } = mountOverlay();

    main.dispatchEvent(pointerEvent("pointerdown", { clientX: 320, clientY: 240 }));
    await vi.waitFor(() => expect(commandsMock.finishWindowPointSelection).toHaveBeenCalledTimes(1));

    expect(commandsMock.finishWindowPointSelection).toHaveBeenCalledWith(320, 240);
    expect(commandsMock.cancelWindowSelection).not.toHaveBeenCalled();
  });

  it("blocks a second confirm while the first is still pending", async () => {
    const { main } = mountOverlay();

    // Two pointerdowns with no await in between, i.e. a double-click landing
    // faster than the capture round trip.
    main.dispatchEvent(pointerEvent("pointerdown", { clientX: 320, clientY: 240 }));
    main.dispatchEvent(pointerEvent("pointerdown", { clientX: 322, clientY: 242 }));
    await vi.waitFor(() => expect(commandsMock.finishWindowPointSelection).toHaveBeenCalledTimes(1));

    expect(commandsMock.finishWindowPointSelection).toHaveBeenCalledTimes(1);
    expect(commandsMock.finishWindowPointSelection).toHaveBeenCalledWith(320, 240);
  });

  it("cancels on Escape without confirming anything", async () => {
    mountOverlay();

    pressEscape();
    await vi.waitFor(() => expect(commandsMock.cancelWindowSelection).toHaveBeenCalledTimes(1));

    expect(commandsMock.finishWindowPointSelection).not.toHaveBeenCalled();
  });

  it("sends only one cancel for a burst of Escape presses", async () => {
    mountOverlay();

    pressEscape();
    pressEscape();
    await vi.waitFor(() => expect(commandsMock.cancelWindowSelection).toHaveBeenCalledTimes(1));

    expect(commandsMock.cancelWindowSelection).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape once a confirm is pending, so one click never both confirms and cancels", async () => {
    const { main } = mountOverlay();

    main.dispatchEvent(pointerEvent("pointerdown", { clientX: 320, clientY: 240 }));
    await vi.waitFor(() => expect(commandsMock.finishWindowPointSelection).toHaveBeenCalledTimes(1));

    pressEscape();
    await Promise.resolve();

    expect(commandsMock.cancelWindowSelection).not.toHaveBeenCalled();
  });

  it("stays usable after a failed confirm instead of wedging the overlay", async () => {
    const { main } = mountOverlay();
    commandsMock.finishWindowPointSelection.mockRejectedValueOnce(new Error("ipc down"));

    main.dispatchEvent(pointerEvent("pointerdown", { clientX: 320, clientY: 240 }));
    await vi.waitFor(() => expect(commandsMock.finishWindowPointSelection).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(main.classList.contains("pending")).toBe(false));

    main.dispatchEvent(pointerEvent("pointerdown", { clientX: 320, clientY: 240 }));
    await vi.waitFor(() => expect(commandsMock.finishWindowPointSelection).toHaveBeenCalledTimes(2));
  });

  it("draws the highlight at the bounds the backend reported for the pointer", async () => {
    commandsMock.windowRectAtPoint.mockResolvedValue(rect(12, 34, 560, 420));
    const { main, container } = mountOverlay();

    main.dispatchEvent(pointerEvent("pointermove", { clientX: 100, clientY: 80 }));
    await vi.waitFor(() => expect(commandsMock.windowRectAtPoint).toHaveBeenCalledWith(100, 80));
    await vi.waitFor(() => expect(container.querySelector(".highlight")).not.toBeNull());

    const box = container.querySelector(".highlight") as HTMLElement;
    expect(box.style.left).toBe("12px");
    expect(box.style.top).toBe("34px");
    expect(box.style.width).toBe("560px");
    expect(box.style.height).toBe("420px");
  });

  it("keeps the last good highlight when the backend reports an unusable rect", async () => {
    commandsMock.windowRectAtPoint.mockResolvedValueOnce(rect(12, 34, 560, 420));
    const { main, container } = mountOverlay();

    main.dispatchEvent(pointerEvent("pointermove", { clientX: 100, clientY: 80 }));
    await vi.waitFor(() => expect(container.querySelector(".highlight")).not.toBeNull());

    // A rect with null fields must not become "0" -- drawing a zero-size or
    // top-left box would tell the user the wrong window is targeted.
    commandsMock.windowRectAtPoint.mockResolvedValue({
      status: "ok",
      data: { x: null, y: 34, width: 560, height: 420 }
    });
    main.dispatchEvent(pointerEvent("pointermove", { clientX: 300, clientY: 300 }));
    await vi.waitFor(() => expect(commandsMock.windowRectAtPoint).toHaveBeenCalledWith(300, 300));
    await nextFrames();

    const box = container.querySelector(".highlight") as HTMLElement;
    expect(box.style.left).toBe("12px");
    expect(box.style.width).toBe("560px");
  });

  it("never overlaps window queries, and still queries the pointer's resting position", async () => {
    let releaseFirst: (() => void) | undefined;
    commandsMock.windowRectAtPoint.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve(rect(0, 0, 100, 100));
        })
    );
    const { main } = mountOverlay();

    main.dispatchEvent(pointerEvent("pointermove", { clientX: 10, clientY: 10 }));
    await vi.waitFor(() => expect(commandsMock.windowRectAtPoint).toHaveBeenCalledTimes(1));

    // Everything below lands while the first query is still in flight.
    main.dispatchEvent(pointerEvent("pointermove", { clientX: 20, clientY: 20 }));
    main.dispatchEvent(pointerEvent("pointermove", { clientX: 30, clientY: 30 }));
    main.dispatchEvent(pointerEvent("pointermove", { clientX: 40, clientY: 40 }));
    await nextFrames();
    expect(commandsMock.windowRectAtPoint).toHaveBeenCalledTimes(1);

    releaseFirst!();
    // Exactly one trailing query, and it carries the resting position rather
    // than a stale intermediate one.
    await vi.waitFor(() => expect(commandsMock.windowRectAtPoint).toHaveBeenCalledTimes(2));
    expect(commandsMock.windowRectAtPoint).toHaveBeenLastCalledWith(40, 40);
  });

  it("stops querying and drops the highlight once a confirm is pending", async () => {
    const { main, container } = mountOverlay();

    main.dispatchEvent(pointerEvent("pointermove", { clientX: 100, clientY: 80 }));
    await vi.waitFor(() => expect(container.querySelector(".highlight")).not.toBeNull());

    main.dispatchEvent(pointerEvent("pointerdown", { clientX: 100, clientY: 80 }));
    await vi.waitFor(() => expect(commandsMock.finishWindowPointSelection).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(container.querySelector(".highlight")).toBeNull());

    const queriesBefore = commandsMock.windowRectAtPoint.mock.calls.length;
    main.dispatchEvent(pointerEvent("pointermove", { clientX: 500, clientY: 500 }));
    await nextFrames();

    expect(commandsMock.windowRectAtPoint).toHaveBeenCalledTimes(queriesBefore);
    expect(container.querySelector(".highlight")).toBeNull();
  });

  it("stops listening for Escape after unmount", async () => {
    const { unmount } = mountOverlay();

    unmount();
    pressEscape();
    await Promise.resolve();

    expect(commandsMock.cancelWindowSelection).not.toHaveBeenCalled();
  });
});
