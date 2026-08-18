// @vitest-environment jsdom
//
// ROADMAP #11: the four picker routes had no tests at all, so the three
// behaviors every overlay depends on -- Escape cancels, a completed gesture
// commits, and `selectionPending` prevents a double-submit -- were only ever
// verified by hand. This suite covers the region overlay through the mocked
// IPC boundary: every assertion is "which command did the route call, how
// often, with what", never an internal flag.
//
// Failure modes these prevent, concretely: a stray drag of two pixels firing a
// real capture instead of cancelling; two `finish_region_selection` calls for
// one gesture (the backend ends the region session on the first, so the second
// races a torn-down session); and Escape leaving the overlay up with no path
// back to the main window.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

const commandsMock = vi.hoisted(() => ({
  finishRegionSelection: vi.fn(),
  cancelRegionSelection: vi.fn()
}));

// The generated bindings module is the seam (same one shutdown.test.ts and
// captureOrchestration.test.ts use), so the route runs with no Tauri runtime.
vi.mock("./bindings", () => ({
  commands: commandsMock
}));

import RegionSelectorPage from "../routes/region-selector/+page.svelte";

// jsdom implements neither PointerEvent nor the pointer capture API
// (https://github.com/jsdom/jsdom/issues/2527); the route calls
// set/releasePointerCapture unconditionally, so without these the very first
// pointerdown throws before any selection logic runs. Same polyfill as
// EditorStage.component.test.ts.
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
  type: "pointerdown" | "pointermove" | "pointerup",
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
  const rendered = render(RegionSelectorPage);
  const main = rendered.container.querySelector("main");
  expect(main).not.toBeNull();
  return { ...rendered, main: main as HTMLElement };
}

function drag(main: HTMLElement, from: [number, number], to: [number, number]) {
  main.dispatchEvent(pointerEvent("pointerdown", { clientX: from[0], clientY: from[1] }));
  main.dispatchEvent(pointerEvent("pointermove", { clientX: to[0], clientY: to[1] }));
  main.dispatchEvent(pointerEvent("pointerup", { clientX: to[0], clientY: to[1] }));
}

function pressEscape() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

describe("region selector overlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commandsMock.finishRegionSelection.mockResolvedValue({ status: "ok", data: null });
    commandsMock.cancelRegionSelection.mockResolvedValue({ status: "ok", data: null });
  });

  it("commits a completed drag as one finishRegionSelection call with the normalized rect", async () => {
    const { main } = mountOverlay();

    // Dragged bottom-right to top-left on purpose: the command must receive the
    // top-left origin and positive extents, not the raw start/end points.
    drag(main, [200, 150], [40, 30]);
    await vi.waitFor(() => expect(commandsMock.finishRegionSelection).toHaveBeenCalledTimes(1));

    expect(commandsMock.finishRegionSelection).toHaveBeenCalledWith({
      x: 40,
      y: 30,
      width: 160,
      height: 120,
      scaleFactor: window.devicePixelRatio
    });
    expect(commandsMock.cancelRegionSelection).not.toHaveBeenCalled();
  });

  it("cancels instead of confirming when the drag is below the minimum size", async () => {
    const { main } = mountOverlay();

    // A 2x2 drag is an accidental click, not a region. Confirming it would hand
    // the backend a rect too small to capture.
    drag(main, [10, 10], [12, 12]);
    await vi.waitFor(() => expect(commandsMock.cancelRegionSelection).toHaveBeenCalledTimes(1));

    expect(commandsMock.finishRegionSelection).not.toHaveBeenCalled();
  });

  it("blocks a second confirm while the first is still pending", async () => {
    const { main } = mountOverlay();

    // Two complete gestures back to back with no await in between, i.e. faster
    // than the first IPC round trip can return.
    drag(main, [10, 10], [120, 120]);
    drag(main, [30, 30], [150, 150]);
    await vi.waitFor(() => expect(commandsMock.finishRegionSelection).toHaveBeenCalledTimes(1));

    expect(commandsMock.finishRegionSelection).toHaveBeenCalledTimes(1);
    expect(commandsMock.cancelRegionSelection).not.toHaveBeenCalled();
  });

  it("cancels on Escape without confirming anything", async () => {
    mountOverlay();

    pressEscape();
    await vi.waitFor(() => expect(commandsMock.cancelRegionSelection).toHaveBeenCalledTimes(1));

    expect(commandsMock.finishRegionSelection).not.toHaveBeenCalled();
  });

  it("ignores Escape once a confirm is pending, so one gesture never both confirms and cancels", async () => {
    const { main } = mountOverlay();

    drag(main, [10, 10], [120, 120]);
    await vi.waitFor(() => expect(commandsMock.finishRegionSelection).toHaveBeenCalledTimes(1));

    pressEscape();
    pressEscape();
    await Promise.resolve();

    expect(commandsMock.cancelRegionSelection).not.toHaveBeenCalled();
  });

  it("ignores keys other than Escape", async () => {
    mountOverlay();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
    await Promise.resolve();

    expect(commandsMock.cancelRegionSelection).not.toHaveBeenCalled();
    expect(commandsMock.finishRegionSelection).not.toHaveBeenCalled();
  });

  it("stays usable after a failed confirm instead of wedging the overlay", async () => {
    const { main } = mountOverlay();
    commandsMock.finishRegionSelection.mockRejectedValueOnce(new Error("ipc down"));

    drag(main, [10, 10], [120, 120]);
    await vi.waitFor(() => expect(commandsMock.finishRegionSelection).toHaveBeenCalledTimes(1));

    // The route only clears `selectionPending` when the IPC layer itself
    // throws; if it did not, the overlay would sit there with no way back --
    // visible as the wait cursor never lifting.
    await vi.waitFor(() => expect(main.classList.contains("pending")).toBe(false));

    drag(main, [10, 10], [120, 120]);
    await vi.waitFor(() => expect(commandsMock.finishRegionSelection).toHaveBeenCalledTimes(2));
  });

  it("stops listening for Escape after unmount", async () => {
    const { unmount } = mountOverlay();

    unmount();
    pressEscape();
    await Promise.resolve();

    expect(commandsMock.cancelRegionSelection).not.toHaveBeenCalled();
  });

  it("draws the selection box at the normalized rect while dragging", async () => {
    const { main, container } = mountOverlay();

    main.dispatchEvent(pointerEvent("pointerdown", { clientX: 200, clientY: 150 }));
    main.dispatchEvent(pointerEvent("pointermove", { clientX: 40, clientY: 30 }));
    await vi.waitFor(() => expect(container.querySelector(".selection")).not.toBeNull());

    const box = container.querySelector(".selection") as HTMLElement;
    expect(box.style.left).toBe("40px");
    expect(box.style.top).toBe("30px");
    expect(box.style.width).toBe("160px");
    expect(box.style.height).toBe("120px");
  });
});
