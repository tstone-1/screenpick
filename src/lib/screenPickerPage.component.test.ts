// @vitest-environment jsdom
//
// ROADMAP #11, screen-picker leg. This is the picker *window* (the list of
// displays), as opposed to the per-display overlays. Beyond the
// Escape/confirm/pending trio it owns two things nothing else covers: the
// display list it loads on mount (including the error path, where a failed
// enumeration must say so rather than render an empty list that looks like
// "no displays"), and the screen-target-changed subscription that mirrors the
// pointer's position on the overlays back into this list.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import type { CapturableMonitor } from "./bindings";
import { screenTargetChangedEvent, type ScreenTargetChanged } from "./screenSelectionEvents";

const commandsMock = vi.hoisted(() => ({
  listScreensForSelection: vi.fn(),
  finishScreenSelection: vi.fn(),
  cancelScreenSelection: vi.fn()
}));

const listenMock = vi.hoisted(() => vi.fn());

vi.mock("./bindings", () => ({
  commands: commandsMock
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock
}));

// The route's four icons come from `@lucide/svelte`, whose barrel entry pulls
// in the whole icon set -- transforming it costs ~15s per run for glyphs no
// assertion here looks at. Stubbed with an inert component so the suite stays
// in the same second-scale as the other component tests. Nothing below asserts
// icon markup; if a future test needs to, drop this mock for that file.
vi.mock("@lucide/svelte", () => {
  const iconStub = () => {};
  return { LoaderCircle: iconStub, Monitor: iconStub, RefreshCcw: iconStub, X: iconStub };
});

import ScreenPickerPage from "../routes/screen-picker/+page.svelte";

afterEach(() => {
  cleanup();
});

function monitor(overrides: Partial<CapturableMonitor> = {}): CapturableMonitor {
  return {
    id: 1,
    name: "\\\\.\\DISPLAY1",
    friendlyName: "Built-in Display",
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    scaleFactor: 1,
    primary: true,
    ...overrides
  };
}

const twoScreens = [
  monitor({ id: 1, friendlyName: "Built-in Display", primary: true }),
  monitor({ id: 7, friendlyName: "External 4K", primary: false, width: 3840, height: 2160 })
];

async function mountPicker() {
  const rendered = render(ScreenPickerPage);
  await vi.waitFor(() => expect(commandsMock.listScreensForSelection).toHaveBeenCalled());
  return rendered;
}

function displayButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("section > button"));
}

function pressEscape() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

// Hand back the screen-target-changed callback the route registered, so a test
// can fire the event the overlays would send.
function targetChangedHandler(): (event: { payload: ScreenTargetChanged }) => void {
  const call = listenMock.mock.calls.find(([name]) => name === screenTargetChangedEvent);
  expect(call, "route did not subscribe to screen-target-changed").toBeDefined();
  return call![1] as (event: { payload: ScreenTargetChanged }) => void;
}

describe("screen picker window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commandsMock.listScreensForSelection.mockResolvedValue({ status: "ok", data: twoScreens });
    commandsMock.finishScreenSelection.mockResolvedValue({ status: "ok", data: null });
    commandsMock.cancelScreenSelection.mockResolvedValue({ status: "ok", data: null });
    listenMock.mockResolvedValue(() => {});
  });

  it("lists the displays it loaded and counts them in the status line", async () => {
    const { container } = await mountPicker();

    await vi.waitFor(() => expect(displayButtons(container)).toHaveLength(2));
    expect(container.textContent).toContain("Built-in Display");
    expect(container.textContent).toContain("External 4K");
    expect(container.textContent).toContain("2 displays");
  });

  it("says 'display' rather than 'displays' for a single monitor", async () => {
    commandsMock.listScreensForSelection.mockResolvedValue({ status: "ok", data: [monitor()] });
    const { container } = await mountPicker();

    await vi.waitFor(() => expect(container.textContent).toContain("1 display"));
    expect(container.textContent).not.toContain("1 displays");
  });

  it("commits the clicked display's id, not its list position", async () => {
    const { container } = await mountPicker();
    await vi.waitFor(() => expect(displayButtons(container)).toHaveLength(2));

    displayButtons(container)[1]!.click();
    await vi.waitFor(() => expect(commandsMock.finishScreenSelection).toHaveBeenCalledTimes(1));

    expect(commandsMock.finishScreenSelection).toHaveBeenCalledWith(7);
    expect(commandsMock.cancelScreenSelection).not.toHaveBeenCalled();
  });

  it("blocks a second confirm while the first is still pending", async () => {
    const { container } = await mountPicker();
    await vi.waitFor(() => expect(displayButtons(container)).toHaveLength(2));

    // Two clicks on different displays, faster than the IPC round trip: the
    // second must not reach a backend that has already ended the session.
    const buttons = displayButtons(container);
    buttons[0]!.click();
    buttons[1]!.click();
    await vi.waitFor(() => expect(commandsMock.finishScreenSelection).toHaveBeenCalledTimes(1));

    expect(commandsMock.finishScreenSelection).toHaveBeenCalledTimes(1);
    expect(commandsMock.finishScreenSelection).toHaveBeenCalledWith(1);
  });

  it("disables every display button once a confirm is pending", async () => {
    const { container } = await mountPicker();
    await vi.waitFor(() => expect(displayButtons(container)).toHaveLength(2));

    displayButtons(container)[0]!.click();
    await vi.waitFor(() => expect(displayButtons(container).every((b) => b.disabled)).toBe(true));
  });

  it("cancels on Escape without confirming anything", async () => {
    await mountPicker();

    pressEscape();
    await vi.waitFor(() => expect(commandsMock.cancelScreenSelection).toHaveBeenCalledTimes(1));

    expect(commandsMock.finishScreenSelection).not.toHaveBeenCalled();
  });

  it("ignores Escape once a confirm is pending", async () => {
    const { container } = await mountPicker();
    await vi.waitFor(() => expect(displayButtons(container)).toHaveLength(2));

    displayButtons(container)[0]!.click();
    await vi.waitFor(() => expect(commandsMock.finishScreenSelection).toHaveBeenCalledTimes(1));

    pressEscape();
    await Promise.resolve();

    expect(commandsMock.cancelScreenSelection).not.toHaveBeenCalled();
  });

  it("cancels from the header Cancel button", async () => {
    const { getByLabelText } = await mountPicker();

    getByLabelText("Cancel").click();
    await vi.waitFor(() => expect(commandsMock.cancelScreenSelection).toHaveBeenCalledTimes(1));

    expect(commandsMock.finishScreenSelection).not.toHaveBeenCalled();
  });

  it("re-enumerates the displays from the Refresh button", async () => {
    const { getByLabelText, container } = await mountPicker();
    await vi.waitFor(() => expect(displayButtons(container)).toHaveLength(2));

    commandsMock.listScreensForSelection.mockResolvedValue({ status: "ok", data: [monitor({ id: 9 })] });
    getByLabelText("Refresh").click();
    await vi.waitFor(() => expect(commandsMock.listScreensForSelection).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(displayButtons(container)).toHaveLength(1));
  });

  it("shows the enumeration error instead of an empty list that reads as 'no displays'", async () => {
    commandsMock.listScreensForSelection.mockResolvedValue({
      status: "error",
      error: "Screen recording permission denied"
    });
    const { container } = await mountPicker();

    await vi.waitFor(() => expect(container.textContent).toContain("Screen recording permission denied"));
    expect(displayButtons(container)).toHaveLength(0);
  });

  it("shows a thrown enumeration failure rather than hanging on 'Loading displays'", async () => {
    commandsMock.listScreensForSelection.mockRejectedValue(new Error("IPC unavailable"));
    const { container } = await mountPicker();

    await vi.waitFor(() => expect(container.textContent).toContain("IPC unavailable"));
    expect(container.textContent).not.toContain("Loading displays");
  });

  it("highlights the display an overlay reports the pointer is over, and clears it on leave", async () => {
    const { container } = await mountPicker();
    await vi.waitFor(() => expect(displayButtons(container)).toHaveLength(2));

    targetChangedHandler()({ payload: { monitorId: 7, hovered: true } });
    await vi.waitFor(() => expect(displayButtons(container)[1]!.classList.contains("targeted")).toBe(true));
    expect(displayButtons(container)[0]!.classList.contains("targeted")).toBe(false);

    targetChangedHandler()({ payload: { monitorId: 7, hovered: false } });
    await vi.waitFor(() => expect(displayButtons(container)[1]!.classList.contains("targeted")).toBe(false));
  });

  it("keeps the current highlight when a different display reports pointer-leave", async () => {
    const { container } = await mountPicker();
    await vi.waitFor(() => expect(displayButtons(container)).toHaveLength(2));

    const fire = targetChangedHandler();
    fire({ payload: { monitorId: 7, hovered: true } });
    await vi.waitFor(() => expect(displayButtons(container)[1]!.classList.contains("targeted")).toBe(true));

    // Overlay 1's leave event must not clear overlay 7's highlight -- pointer
    // moves between displays deliver leave-after-enter out of order.
    fire({ payload: { monitorId: 1, hovered: false } });
    await Promise.resolve();
    expect(displayButtons(container)[1]!.classList.contains("targeted")).toBe(true);
  });

  it("stops listening for Escape after unmount", async () => {
    const { unmount } = await mountPicker();

    unmount();
    pressEscape();
    await Promise.resolve();

    expect(commandsMock.cancelScreenSelection).not.toHaveBeenCalled();
  });
});
