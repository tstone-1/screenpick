// @vitest-environment jsdom
//
// ROADMAP #11, screen-overlay leg. This route is the per-display overlay the
// screen picker puts on every monitor, so it carries two things worth pinning
// down beyond the usual Escape/confirm/pending trio:
//
//  - the monitorId query-param guard. `Number("")` and `Number(null)` are both
//    0 -- a perfectly finite number -- so a missing or garbled param would
//    silently address monitor 0 and capture the wrong display. The route
//    requires an all-digits string so bad input becomes NaN and is rejected.
//  - the screen-target-changed emits, which are what highlights the matching
//    row in the picker window while the pointer is over an overlay.
//
// Everything is asserted through the mocked IPC/event boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import { screenTargetChangedEvent } from "./screenSelectionEvents";

const commandsMock = vi.hoisted(() => ({
  finishScreenSelection: vi.fn(),
  cancelScreenSelection: vi.fn()
}));

const emitMock = vi.hoisted(() => vi.fn());

vi.mock("./bindings", () => ({
  commands: commandsMock
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: emitMock
}));

import ScreenOverlayPage from "../routes/screen-overlay/+page.svelte";

afterEach(() => {
  cleanup();
});

// The route reads location.search when the component initializes, so each test
// sets the URL first and then mounts.
function mountOverlay(search: string) {
  window.history.replaceState({}, "", `/screen-overlay${search}`);
  const rendered = render(ScreenOverlayPage);
  const button = rendered.container.querySelector("button");
  expect(button).not.toBeNull();
  return { ...rendered, button: button as HTMLButtonElement };
}

function pressEscape() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

describe("screen overlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commandsMock.finishScreenSelection.mockResolvedValue({ status: "ok", data: null });
    commandsMock.cancelScreenSelection.mockResolvedValue({ status: "ok", data: null });
    emitMock.mockResolvedValue(undefined);
  });

  it("commits the monitor id from the query string on click", async () => {
    const { button } = mountOverlay("?monitorId=3");

    button.click();
    await vi.waitFor(() => expect(commandsMock.finishScreenSelection).toHaveBeenCalledTimes(1));

    expect(commandsMock.finishScreenSelection).toHaveBeenCalledWith(3);
    expect(commandsMock.cancelScreenSelection).not.toHaveBeenCalled();
  });

  it("clears its own highlight in the picker before committing", async () => {
    const { button } = mountOverlay("?monitorId=3");

    button.click();
    await vi.waitFor(() => expect(commandsMock.finishScreenSelection).toHaveBeenCalledTimes(1));

    // Without this the picker row stays highlighted behind the capture.
    expect(emitMock).toHaveBeenCalledWith(screenTargetChangedEvent, { monitorId: 3, hovered: false });
  });

  it("emits the hover state so the picker can highlight the matching display", async () => {
    const { button } = mountOverlay("?monitorId=2");

    button.dispatchEvent(new MouseEvent("pointerenter", { bubbles: false }));
    await vi.waitFor(() =>
      expect(emitMock).toHaveBeenCalledWith(screenTargetChangedEvent, { monitorId: 2, hovered: true })
    );

    button.dispatchEvent(new MouseEvent("pointerleave", { bubbles: false }));
    await vi.waitFor(() =>
      expect(emitMock).toHaveBeenCalledWith(screenTargetChangedEvent, { monitorId: 2, hovered: false })
    );
  });

  it("blocks a second confirm while the first is still pending", async () => {
    const { button } = mountOverlay("?monitorId=1");

    // Two clicks with no await in between: faster than both the IPC round trip
    // and the re-render that disables the button.
    button.click();
    button.click();
    await vi.waitFor(() => expect(commandsMock.finishScreenSelection).toHaveBeenCalledTimes(1));

    expect(commandsMock.finishScreenSelection).toHaveBeenCalledTimes(1);
  });

  it("disables the overlay button once a confirm is pending", async () => {
    const { button } = mountOverlay("?monitorId=1");

    expect(button.disabled).toBe(false);
    button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(true));
  });

  it("cancels on Escape without confirming anything", async () => {
    mountOverlay("?monitorId=1");

    pressEscape();
    await vi.waitFor(() => expect(commandsMock.cancelScreenSelection).toHaveBeenCalledTimes(1));

    expect(commandsMock.finishScreenSelection).not.toHaveBeenCalled();
  });

  it("sends only one cancel for a burst of Escape presses", async () => {
    mountOverlay("?monitorId=1");

    pressEscape();
    pressEscape();
    pressEscape();
    await vi.waitFor(() => expect(commandsMock.cancelScreenSelection).toHaveBeenCalledTimes(1));

    expect(commandsMock.cancelScreenSelection).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape once a confirm is pending", async () => {
    const { button } = mountOverlay("?monitorId=1");

    button.click();
    await vi.waitFor(() => expect(commandsMock.finishScreenSelection).toHaveBeenCalledTimes(1));

    pressEscape();
    await Promise.resolve();

    expect(commandsMock.cancelScreenSelection).not.toHaveBeenCalled();
  });

  // Number("") === 0 and Number("  ") === 0, so a lenient parse would turn every
  // one of these into a capture of monitor 0 -- the wrong display, silently.
  const rejectedParams: Array<[string, string]> = [
    ["absent", ""],
    ["empty", "?monitorId="],
    ["non-numeric", "?monitorId=abc"],
    ["whitespace", "?monitorId=%20%20"],
    ["fractional", "?monitorId=1.5"],
    ["negative", "?monitorId=-1"],
    ["trailing garbage", "?monitorId=2x"]
  ];

  for (const [label, search] of rejectedParams) {
    it(`refuses to capture when the monitorId param is ${label}`, async () => {
      const { button } = mountOverlay(search);

      button.dispatchEvent(new MouseEvent("pointerenter", { bubbles: false }));
      button.click();
      await Promise.resolve();
      await Promise.resolve();

      expect(commandsMock.finishScreenSelection).not.toHaveBeenCalled();
      expect(emitMock).not.toHaveBeenCalled();
    });
  }

  it("still accepts Escape when the monitorId param is unusable", async () => {
    mountOverlay("?monitorId=abc");

    // The guard must not strand the overlay: cancelling is monitor-independent.
    pressEscape();
    await vi.waitFor(() => expect(commandsMock.cancelScreenSelection).toHaveBeenCalledTimes(1));
  });

  it("stops listening for Escape after unmount", async () => {
    const { unmount } = mountOverlay("?monitorId=1");

    unmount();
    pressEscape();
    await Promise.resolve();

    expect(commandsMock.cancelScreenSelection).not.toHaveBeenCalled();
  });
});
