import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureMode, CaptureSettings, ShortcutStatus } from "./bindings";

// Mock the modules the orchestrator imports BEFORE importing the class
// itself, so the singleton's constructor never touches a real Tauri IPC.
const settingsHolder = {
  current: {
    saveDirectory: null,
    copyToClipboard: false,
    playCaptureSound: false,
    autoOpenEditor: true,
    bringToFrontOnHotkeyCapture: false,
    closeToTray: false,
    shortcutOverrides: {}
  } satisfies CaptureSettings as CaptureSettings
};

const commandsMock = vi.hoisted(() => ({
  appStatus: vi.fn(),
  listCaptureModes: vi.fn(),
  shortcutStatus: vi.fn(),
  effectiveShortcutAccelerators: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  autostartEnabled: vi.fn(),
  startRegionSelection: vi.fn(),
  startWindowSelection: vi.fn(),
  startScreenSelection: vi.fn(),
  captureScreenUnderCursor: vi.fn(),
  cancelRegionSelection: vi.fn(),
  cancelWindowSelection: vi.fn(),
  cancelScreenSelection: vi.fn(),
  captureActiveWindow: vi.fn(),
  copyImageToClipboard: vi.fn().mockResolvedValue({ status: "ok", data: null })
}));

const captureSoundMock = vi.hoisted(() => ({
  playCaptureSound: vi.fn(),
  unlockCaptureSound: vi.fn()
}));

const eventsMock = vi.hoisted(() => ({
  captureShortcut: { listen: vi.fn().mockResolvedValue(() => {}) },
  shortcutRegistration: { listen: vi.fn().mockResolvedValue(() => {}) },
  captureCompleted: { listen: vi.fn().mockResolvedValue(() => {}) },
  captureCancelled: { listen: vi.fn().mockResolvedValue(() => {}) }
}));

const editorMock = vi.hoisted(() => ({
  ingestCompleted: vi.fn((p) => ({ ...p, assetUrl: `asset://${p.path}` })),
  ingestWithoutOpening: vi.fn((p) => ({ ...p, assetUrl: `asset://${p.path}` }))
}));

vi.mock("./bindings", () => ({
  commands: commandsMock,
  events: eventsMock
}));

vi.mock("./editor.svelte", () => ({
  editor: editorMock
}));

vi.mock("./editorCommands", () => ({
  pickDirectory: vi.fn()
}));

vi.mock("./captureSound", () => captureSoundMock);

vi.mock("./diagnosticsLog", () => ({
  logError: vi.fn(),
  logWarn: vi.fn()
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn()
}));

const { logError } = await import("./diagnosticsLog");

// The class lives in a .svelte.ts file but its behavior is testable here:
// vitest runs through Vite with the Svelte plugin so $state/$derived are
// real reactivity in this environment.
const { CaptureOrchestration } = await import("./captureOrchestration.svelte");
// The settings/shortcut half of the old class now lives in its own store,
// composed as `orchestration.settingsStore` — its own suite is
// settingsState.test.ts; what is asserted through it here is what the capture
// side and the startup sequence read and write.
const { statusLine } = await import("./statusLine.svelte");

const modes: CaptureMode[] = [
  { id: "region", label: "Region", accelerators: ["CommandOrControl+Shift+4"] },
  {
    id: "window",
    label: "Window",
    accelerators: ["CommandOrControl+Shift+W", "CommandOrControl+Alt+W"]
  },
  { id: "screen", label: "Screen", accelerators: ["CommandOrControl+Shift+S"] },
  { id: "screen-pick", label: "Pick display", accelerators: ["CommandOrControl+Shift+Alt+S"] }
];

function status(accelerator: string, mode: string, state: "registered" | "failed"): ShortcutStatus {
  return { accelerator, mode, state, error: null };
}

function keyEvent(fields: {
  code: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): KeyboardEvent {
  return {
    code: fields.code,
    ctrlKey: fields.ctrlKey ?? false,
    metaKey: fields.metaKey ?? false,
    altKey: fields.altKey ?? false,
    shiftKey: fields.shiftKey ?? false,
    preventDefault: vi.fn()
  } as unknown as KeyboardEvent;
}

function sanitize(overrides: Record<string, string[]>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [mode, accelerators] of Object.entries(overrides)) {
    if (accelerators.length === 0) {
      result[mode] = [];
      continue;
    }
    const kept = accelerators.map((a) => a.trim()).filter((a) => a.length > 0);
    if (kept.length > 0) result[mode] = kept;
  }
  return result;
}

function commandOrControl(o: InstanceType<typeof CaptureOrchestration>) {
  return o.isMac ? { metaKey: true } : { ctrlKey: true };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The status line is a module singleton shared by every orchestrator, so a
  // message left by the previous test would satisfy a `toContain` here.
  statusLine.set("");
  settingsHolder.current = {
    saveDirectory: null,
    copyToClipboard: false,
    playCaptureSound: false,
    autoOpenEditor: true,
    bringToFrontOnHotkeyCapture: false,
    shortcutOverrides: {}
  };
  commandsMock.appStatus.mockResolvedValue("ready");
  commandsMock.listCaptureModes.mockResolvedValue(modes);
  commandsMock.shortcutStatus.mockResolvedValue([]);
  commandsMock.effectiveShortcutAccelerators.mockResolvedValue({
    region: ["CommandOrControl+Shift+4"],
    window: ["CommandOrControl+Shift+W", "CommandOrControl+Alt+W"],
    screen: ["CommandOrControl+Shift+S"]
  });
  commandsMock.getSettings.mockResolvedValue(settingsHolder.current);
  commandsMock.updateSettings.mockImplementation(async (s: CaptureSettings) => {
    // Mirrors Rust's `sanitize_settings`: blank entries are dropped and a mode
    // whose entries were all blank disappears. A fake that echoed the payload
    // back verbatim would let a draft/stored mismatch pass unnoticed.
    settingsHolder.current = { ...s, shortcutOverrides: sanitize(s.shortcutOverrides ?? {}) };
    return { status: "ok", data: settingsHolder.current };
  });
  commandsMock.autostartEnabled.mockResolvedValue({ status: "ok", data: false });
});

describe("startup", () => {
  it("loads the OS autostart state", async () => {
    commandsMock.autostartEnabled.mockResolvedValueOnce({ status: "ok", data: true });
    const o = new CaptureOrchestration();
    const cleanup = o.setup();

    await vi.waitFor(() => {
      expect(o.settingsStore.autostartEnabled).toBe(true);
    });

    cleanup();
  });

  it("surfaces autostart load errors without failing setup", async () => {
    commandsMock.autostartEnabled.mockResolvedValueOnce({
      status: "error",
      error: "startup unavailable"
    });
    const o = new CaptureOrchestration();
    const cleanup = o.setup();

    await vi.waitFor(() => {
      expect(statusLine.message).toContain("startup unavailable");
    });

    cleanup();
  });
});

describe("activeAccelerator", () => {
  it("returns the registered accelerator for a mode", () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    o.settingsStore.registrations = [status("Cmd+Shift+4", "region", "registered")];
    expect(o.activeAccelerator(modes[0])).toBe("Cmd+Shift+4");
  });

  it("falls back to the first declared accelerator when registrations are empty", () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    o.settingsStore.registrations = [];
    expect(o.activeAccelerator(modes[0])).toBe("CommandOrControl+Shift+4");
  });

  it("returns null when registrations exist but the mode has none registered", () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    o.settingsStore.registrations = [status("Cmd+Shift+W", "window", "registered")];
    expect(o.activeAccelerator(modes[0])).toBeNull();
  });
});

// The gate itself (a save refused before `get_settings` has answered) is
// asserted in settingsState.test.ts. This is its control from the outside: the
// startup sequence must actually open it, or the gate would read as a fix while
// quietly making every settings change inert.
describe("settings-load gate", () => {
  it("opens once setup has loaded the stored settings", async () => {
    settingsHolder.current = { ...settingsHolder.current, saveDirectory: "/stored/captures" };
    commandsMock.getSettings.mockResolvedValue(settingsHolder.current);
    const o = new CaptureOrchestration();
    const cleanup = o.setup();
    await vi.waitFor(() => {
      expect(o.settingsStore.settingsLoaded).toBe(true);
    });

    await o.settingsStore.toggleSetting("autoOpenEditor");

    expect(commandsMock.updateSettings).toHaveBeenCalledTimes(1);
    expect(settingsHolder.current.saveDirectory).toBe("/stored/captures");
    cleanup();
  });
});

describe("requestCapture", () => {
  it("dispatches to the right Tauri command per mode", async () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    commandsMock.startRegionSelection.mockResolvedValue({ status: "ok", data: null });
    commandsMock.startWindowSelection.mockResolvedValue({ status: "ok", data: null });
    commandsMock.startScreenSelection.mockResolvedValue({ status: "ok", data: null });

    await o.requestCapture("region", "button");
    expect(commandsMock.startRegionSelection).toHaveBeenCalledOnce();

    o.capturePending = false;
    await o.requestCapture("window", "button");
    expect(commandsMock.startWindowSelection).toHaveBeenCalledOnce();

    o.capturePending = false;
    await o.requestCapture("screen", "button");
    expect(commandsMock.startScreenSelection).toHaveBeenCalledOnce();
  });

  it("captures the display under the cursor (not the picker) for a screen hotkey", async () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    commandsMock.captureScreenUnderCursor.mockResolvedValue({ status: "ok", data: null });

    await o.requestCapture("screen", "shortcut");

    expect(commandsMock.captureScreenUnderCursor).toHaveBeenCalledOnce();
    expect(commandsMock.startScreenSelection).not.toHaveBeenCalled();
  });

  it("opens the picker for the dedicated screen-pick hotkey", async () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    commandsMock.startScreenSelection.mockResolvedValue({ status: "ok", data: null });

    await o.requestCapture("screen-pick", "shortcut");

    expect(commandsMock.startScreenSelection).toHaveBeenCalledOnce();
    expect(commandsMock.captureScreenUnderCursor).not.toHaveBeenCalled();
  });

  it("captures the active window (not the picker) for a window hotkey", async () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    commandsMock.captureActiveWindow.mockResolvedValue({
      status: "ok",
      data: { mode: "window", title: "Editor", path: "/tmp/w.png", width: 800, height: 600 }
    });

    await o.requestCapture("window", "shortcut");

    expect(commandsMock.captureActiveWindow).toHaveBeenCalledOnce();
    expect(commandsMock.startWindowSelection).not.toHaveBeenCalled();
    expect(editorMock.ingestCompleted).toHaveBeenCalledOnce();
  });

  it("plays the capture sound for a hotkey capture only when enabled", async () => {
    const result = {
      status: "ok" as const,
      data: { mode: "window", title: "W", path: "/w.png", width: 10, height: 10 }
    };
    commandsMock.captureActiveWindow.mockResolvedValue(result);

    const off = new CaptureOrchestration();
    off.captureModes = modes;
    await off.requestCapture("window", "shortcut");
    expect(captureSoundMock.playCaptureSound).not.toHaveBeenCalled();

    const on = new CaptureOrchestration();
    on.captureModes = modes;
    on.settingsStore.settings = { ...on.settingsStore.settings, playCaptureSound: true };
    await on.requestCapture("window", "shortcut");
    expect(captureSoundMock.playCaptureSound).toHaveBeenCalledOnce();
  });

  it("no-ops while a capture is already pending", async () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    o.capturePending = true;
    await o.requestCapture("region", "button");
    expect(commandsMock.startRegionSelection).not.toHaveBeenCalled();
  });

  // The mode id crosses the IPC boundary as a plain string, so nothing in the
  // typed contract catches a mode Rust lists and the dispatch table lacks. It
  // used to land in a silent else: no command, no error, no log — a control
  // that did nothing. Assert every mode the backend reports is dispatchable.
  it("dispatches every mode the backend lists", async () => {
    commandsMock.startRegionSelection.mockResolvedValue({ status: "ok", data: null });
    commandsMock.startWindowSelection.mockResolvedValue({ status: "ok", data: null });
    commandsMock.startScreenSelection.mockResolvedValue({ status: "ok", data: null });

    for (const mode of modes) {
      const o = new CaptureOrchestration();
      o.captureModes = modes;
      await o.requestCapture(mode.id, "button");
      expect(statusLine.message, `mode ${mode.id}`).not.toContain("not available");
    }

    expect(logError).not.toHaveBeenCalled();
  });

  it("logs and clears pending for a mode id with no dispatch entry", async () => {
    const o = new CaptureOrchestration();
    o.captureModes = [...modes, { id: "hologram", label: "Hologram", accelerators: [] }];

    await o.requestCapture("hologram", "button");

    expect(logError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logError).mock.calls[0][0]).toContain("hologram");
    expect(statusLine.message).toContain("hologram");
    expect(o.capturePending).toBe(false);
    expect(commandsMock.startRegionSelection).not.toHaveBeenCalled();
    expect(commandsMock.startWindowSelection).not.toHaveBeenCalled();
    expect(commandsMock.startScreenSelection).not.toHaveBeenCalled();
  });
});

describe("fallback shortcuts", () => {
  it("does not fire a default accelerator disabled by shortcut overrides", () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    o.settingsStore.appliedSettings = {
      ...o.settingsStore.appliedSettings,
      shortcutOverrides: { region: [] }
    };
    o.settingsStore.effectiveAccelerators = { region: [], window: [], screen: [] };
    const event = keyEvent({
      code: "Digit4",
      ...commandOrControl(o),
      shiftKey: true
    });

    expect(o.handleFallbackShortcut(event)).toBe(false);
    expect(commandsMock.startRegionSelection).not.toHaveBeenCalled();
  });

  it("fires an unregistered custom accelerator as an in-app fallback", () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    o.settingsStore.appliedSettings = {
      ...o.settingsStore.appliedSettings,
      shortcutOverrides: { region: ["CommandOrControl+Shift+R"] }
    };
    o.settingsStore.effectiveAccelerators = {
      region: ["CommandOrControl+Shift+R"],
      window: [],
      screen: []
    };
    const event = keyEvent({
      code: "KeyR",
      ...commandOrControl(o),
      shiftKey: true
    });

    expect(o.handleFallbackShortcut(event)).toBe(true);
    expect(commandsMock.startRegionSelection).toHaveBeenCalledOnce();
  });

  it("requires Ctrl and Meta to match exactly", () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    o.settingsStore.registrations = [status("CommandOrControl+Shift+S", "screen", "failed")];
    const event = keyEvent({
      code: "KeyS",
      ctrlKey: o.isMac,
      metaKey: !o.isMac,
      shiftKey: true
    });

    expect(o.handleFallbackShortcut(event)).toBe(false);
    expect(commandsMock.startScreenSelection).not.toHaveBeenCalled();
  });
});

describe("capture watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Regression: `screen-pick` used to fall through `#cancelPendingCapture`'s
  // mode if/else (it only handled region/window/screen), so a wedged
  // display-picker overlay recovered the local UI but never told Rust to
  // cancel the still-recorded `ScreenPickerSession` — the overlay windows and
  // hidden main window were stranded. Assert the watchdog now routes
  // screen-pick through the same cancel_screen_selection command as screen.
  it("cancels a wedged screen-pick session after the watchdog timeout", async () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    commandsMock.startScreenSelection.mockResolvedValue({ status: "ok", data: null });
    commandsMock.cancelScreenSelection.mockResolvedValue({ status: "ok", data: null });

    await o.requestCapture("screen-pick", "shortcut");
    expect(o.capturePending).toBe(true);
    expect(commandsMock.cancelScreenSelection).not.toHaveBeenCalled();

    // CAPTURE_WATCHDOG_MS is 60_000 and not exported; advancing well past it
    // is equivalent and avoids the test drifting silently if the constant
    // changes without this file noticing.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(commandsMock.cancelScreenSelection).toHaveBeenCalledOnce();
    expect(o.capturePending).toBe(false);
  });

  // Start and cancel now come from one table, so the pairing is worth asserting
  // per mode: a wrong cancel command leaves the Rust session recorded and its
  // overlay on screen while the local UI reports itself recovered.
  it("cancels each mode through that mode's own cancel command", async () => {
    commandsMock.startRegionSelection.mockResolvedValue({ status: "ok", data: null });
    commandsMock.startWindowSelection.mockResolvedValue({ status: "ok", data: null });
    commandsMock.cancelRegionSelection.mockResolvedValue({ status: "ok", data: null });
    commandsMock.cancelWindowSelection.mockResolvedValue({ status: "ok", data: null });

    const region = new CaptureOrchestration();
    region.captureModes = modes;
    await region.requestCapture("region", "button");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(commandsMock.cancelRegionSelection).toHaveBeenCalledOnce();
    expect(commandsMock.cancelWindowSelection).not.toHaveBeenCalled();
    expect(commandsMock.cancelScreenSelection).not.toHaveBeenCalled();

    const window = new CaptureOrchestration();
    window.captureModes = modes;
    await window.requestCapture("window", "button");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(commandsMock.cancelWindowSelection).toHaveBeenCalledOnce();
    expect(commandsMock.cancelRegionSelection).toHaveBeenCalledOnce();
    expect(commandsMock.cancelScreenSelection).not.toHaveBeenCalled();
  });
});

describe("failedShortcuts derived", () => {
  it("hides failures once the user dismisses the banner", () => {
    const o = new CaptureOrchestration();
    o.settingsStore.shortcutStatusByKey = {
      "Cmd+Shift+4:region": status("Cmd+Shift+4", "region", "failed")
    };
    expect(o.failedShortcuts.length).toBe(1);
    o.dismissShortcutConflicts();
    expect(o.failedShortcuts.length).toBe(0);
  });
});
