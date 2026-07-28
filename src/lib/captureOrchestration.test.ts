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
  suspendShortcuts: vi.fn(),
  resumeShortcuts: vi.fn(),
  effectiveShortcutAccelerators: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  resetShortcutSettings: vi.fn(),
  autostartEnabled: vi.fn(),
  setAutostart: vi.fn(),
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

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn()
}));

// The class lives in a .svelte.ts file but its behavior is testable here:
// vitest runs through Vite with the Svelte plugin so $state/$derived are
// real reactivity in this environment.
const { CaptureOrchestration } = await import("./captureOrchestration.svelte");

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
  commandsMock.suspendShortcuts.mockResolvedValue({ status: "ok", data: null });
  commandsMock.resumeShortcuts.mockResolvedValue({ status: "ok", data: null });
  commandsMock.getSettings.mockResolvedValue(settingsHolder.current);
  commandsMock.updateSettings.mockImplementation(async (s: CaptureSettings) => {
    // Mirrors Rust's `sanitize_settings`: blank entries are dropped and a mode
    // whose entries were all blank disappears. A fake that echoed the payload
    // back verbatim would let a draft/stored mismatch pass unnoticed.
    settingsHolder.current = { ...s, shortcutOverrides: sanitize(s.shortcutOverrides ?? {}) };
    return { status: "ok", data: settingsHolder.current };
  });
  commandsMock.resetShortcutSettings.mockImplementation(async () => {
    settingsHolder.current = { ...settingsHolder.current, shortcutOverrides: {} };
    return { status: "ok", data: settingsHolder.current };
  });
  commandsMock.autostartEnabled.mockResolvedValue({ status: "ok", data: false });
  commandsMock.setAutostart.mockImplementation(async (enabled: boolean) => ({
    status: "ok",
    data: enabled
  }));
});

describe("startup", () => {
  it("loads the OS autostart state", async () => {
    commandsMock.autostartEnabled.mockResolvedValueOnce({ status: "ok", data: true });
    const o = new CaptureOrchestration();
    const cleanup = o.setup();

    await vi.waitFor(() => {
      expect(o.autostartEnabled).toBe(true);
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
      expect(o.captureActivity).toContain("startup unavailable");
    });

    cleanup();
  });
});

describe("formatShortcut", () => {
  it("returns Unavailable for null", () => {
    const o = new CaptureOrchestration();
    expect(o.formatShortcut(null)).toBe("Unavailable");
  });

  it("joins parts with platform-appropriate separator", () => {
    const o = new CaptureOrchestration();
    // The orchestrator detects macOS via navigator.platform once at construction;
    // we can't easily flip it, so just check the parts are mapped.
    const result = o.formatShortcut("CommandOrControl+Shift+4");
    expect(result).toContain("4");
    // Either the macOS glyph chord or the spelled-out Windows rendering.
    expect(result === "⌘⇧4" || result === "Ctrl+Shift+4").toBe(true);
  });
});

describe("statusKey", () => {
  it("combines accelerator and mode", () => {
    const o = new CaptureOrchestration();
    expect(o.statusKey(status("Cmd+1", "region", "registered"))).toBe("Cmd+1:region");
  });
});

describe("activeAccelerator", () => {
  it("returns the registered accelerator for a mode", () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    o.registrations = [status("Cmd+Shift+4", "region", "registered")];
    expect(o.activeAccelerator(modes[0])).toBe("Cmd+Shift+4");
  });

  it("falls back to the first declared accelerator when registrations are empty", () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    o.registrations = [];
    expect(o.activeAccelerator(modes[0])).toBe("CommandOrControl+Shift+4");
  });

  it("returns null when registrations exist but the mode has none registered", () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    o.registrations = [status("Cmd+Shift+W", "window", "registered")];
    expect(o.activeAccelerator(modes[0])).toBeNull();
  });
});

describe("shortcut draft round-trip", () => {
  it("addShortcutEntry seeds from defaults and appends a blank row", () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    expect(o.getModeAccelerators("window")).toEqual([
      "CommandOrControl+Shift+W",
      "CommandOrControl+Alt+W"
    ]);
    o.addShortcutEntry("window");
    expect(o.getModeAccelerators("window")).toEqual([
      "CommandOrControl+Shift+W",
      "CommandOrControl+Alt+W",
      ""
    ]);
    // Drafts preserve blanks; Rust's sanitize_settings drops them at save.
    expect(o.settings.shortcutOverrides?.window).toEqual([
      "CommandOrControl+Shift+W",
      "CommandOrControl+Alt+W",
      ""
    ]);
  });

  it("setShortcutEntry replaces the accelerator at the given index", () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    o.addShortcutEntry("region");
    o.setShortcutEntry("region", 1, "CommandOrControl+Shift+R");
    expect(o.getModeAccelerators("region")).toEqual([
      "CommandOrControl+Shift+4",
      "CommandOrControl+Shift+R"
    ]);
  });

  it("removeShortcutEntry drops the row at the given index", async () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    o.addShortcutEntry("window");
    await o.removeShortcutEntry("window", 0);
    expect(o.getModeAccelerators("window")).toEqual([
      "CommandOrControl+Alt+W",
      ""
    ]);
  });

  // The click that removes a row also blurs the field, and that blur handler
  // runs first — on the pre-removal draft. So removal cannot wait for a blur of
  // its own; it has to commit itself or the deletion is silently lost.
  it("removeShortcutEntry persists without waiting for a blur", async () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    await o.removeShortcutEntry("window", 1);
    expect(commandsMock.updateSettings).toHaveBeenCalledTimes(1);
    expect(settingsHolder.current.shortcutOverrides?.window).toEqual([
      "CommandOrControl+Shift+W"
    ]);
  });
});

describe("blur commits the recorded shortcut", () => {
  it("saves and re-registers when a chord was recorded", async () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    await o.beginShortcutRecording();
    o.setShortcutEntry("window", 0, "CommandOrControl+Shift+G");
    await o.endShortcutRecording();

    expect(commandsMock.updateSettings).toHaveBeenCalledTimes(1);
    expect(settingsHolder.current.shortcutOverrides?.window).toEqual([
      "CommandOrControl+Shift+G",
      "CommandOrControl+Alt+W"
    ]);
    expect(o.appliedSettings.shortcutOverrides?.window?.[0]).toBe("CommandOrControl+Shift+G");
    // update_settings re-registers everything, so a separate resume would be a
    // redundant unregister/register cycle.
    expect(commandsMock.resumeShortcuts).not.toHaveBeenCalled();
  });

  it("only resumes when nothing was recorded", async () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    await o.beginShortcutRecording();
    await o.endShortcutRecording();

    expect(commandsMock.resumeShortcuts).toHaveBeenCalledTimes(1);
    expect(commandsMock.updateSettings).not.toHaveBeenCalled();
  });

  // A blank row is not a change: the backend never stores one, so treating it as
  // dirty would save-and-re-register on every blur of an untouched field.
  it("treats a blank placeholder row as no change", async () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    o.appliedSettings = {
      ...o.appliedSettings,
      shortcutOverrides: { window: ["CommandOrControl+Shift+W"] }
    };
    o.shortcutEditorDrafts = { window: ["CommandOrControl+Shift+W"] };
    o.addShortcutEntry("window");
    await o.endShortcutRecording();

    expect(commandsMock.updateSettings).not.toHaveBeenCalled();
    expect(commandsMock.resumeShortcuts).toHaveBeenCalledTimes(1);
  });

  // Moving between two shortcut fields fires blur (commit + re-register) before
  // focus (suspend). If those two land out of order the shortcuts are armed
  // while the second field is recording, and the OS eats the chord — the exact
  // failure `suspend_shortcuts` exists to prevent.
  it("suspends only after the previous field's save has finished", async () => {
    const order: string[] = [];
    commandsMock.updateSettings.mockImplementation(async (s: CaptureSettings) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("save");
      settingsHolder.current = { ...s };
      return { status: "ok", data: settingsHolder.current };
    });
    commandsMock.suspendShortcuts.mockImplementation(async () => {
      order.push("suspend");
      return { status: "ok", data: null };
    });

    const o = new CaptureOrchestration();
    o.captureModes = modes;
    o.setShortcutEntry("window", 0, "CommandOrControl+Shift+G");
    const blur = o.endShortcutRecording();
    const focus = o.beginShortcutRecording();
    await Promise.all([blur, focus]);

    expect(order).toEqual(["save", "suspend"]);
  });

  // A save triggered from one mode must not delete a blank row the user just
  // added under another: the backend strips blanks, so adopting its response
  // wholesale would make the row disappear mid-edit.
  it("keeps an unfilled row in another mode across a save", async () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    o.addShortcutEntry("screen");
    o.setShortcutEntry("window", 0, "CommandOrControl+Shift+G");
    await o.endShortcutRecording();

    expect(settingsHolder.current.shortcutOverrides?.screen).toEqual([
      "CommandOrControl+Shift+S"
    ]);
    expect(o.getModeAccelerators("screen")).toEqual(["CommandOrControl+Shift+S", ""]);
  });
});

describe("shortcutRowState", () => {
  it("reports the registration state of a committed row", () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    o.shortcutStatusByKey = {
      "CommandOrControl+Shift+W:window": status("CommandOrControl+Shift+W", "window", "registered"),
      "CommandOrControl+Alt+W:window": {
        ...status("CommandOrControl+Alt+W", "window", "failed"),
        error: "HotKey already registered"
      }
    };
    expect(o.shortcutRowState("window", "CommandOrControl+Shift+W")).toBe("registered");
    expect(o.shortcutRowState("window", "CommandOrControl+Alt+W")).toBe("failed");
    expect(o.shortcutRowState("window", "")).toBe("empty");
    expect(o.shortcutRowState("screen", "CommandOrControl+Shift+S")).toBe("pending");
  });

  // The collision that started this: the recorder emits Cmd+Alt+Shift+4 while
  // the region default is spelled Cmd+Shift+Alt+4. Same chord, different string
  // — so a raw compare misses it and only the OS notices, by refusing the
  // second registration.
  it("flags a duplicate chord that differs only in modifier order", () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    o.shortcutStatusByKey = {
      "CommandOrControl+Shift+W:window": status("CommandOrControl+Shift+W", "window", "registered")
    };
    o.shortcutEditorDrafts = {
      region: ["CommandOrControl+Shift+Alt+4"],
      window: ["CommandOrControl+Shift+W", "CommandOrControl+Alt+Shift+4"]
    };
    expect(o.shortcutRowState("window", "CommandOrControl+Alt+Shift+4")).toBe("duplicate");
    // Both sides of the collision are flagged; neither is the "right" one.
    expect(o.shortcutRowState("region", "CommandOrControl+Shift+Alt+4")).toBe("duplicate");
    // A chord bound once is untouched — the check flags collisions, not any
    // accelerator that happens to share modifiers with another.
    expect(o.shortcutRowState("window", "CommandOrControl+Shift+W")).toBe("registered");
  });
});

describe("toggleSetting", () => {
  it("flips a boolean setting and persists via updateSettings", async () => {
    const o = new CaptureOrchestration();
    o.settings = { ...o.settings, autoOpenEditor: true };
    o.appliedSettings = { ...o.settings };
    await o.toggleSetting("autoOpenEditor");
    expect(commandsMock.updateSettings).toHaveBeenCalledTimes(1);
    expect(o.settings.autoOpenEditor).toBe(false);
    expect(o.appliedSettings.autoOpenEditor).toBe(false);
  });

  it("toggles bring-to-front hotkey capture", async () => {
    const o = new CaptureOrchestration();
    o.settings = { ...o.settings, bringToFrontOnHotkeyCapture: false };
    o.appliedSettings = { ...o.settings };
    await o.toggleSetting("bringToFrontOnHotkeyCapture");
    expect(commandsMock.updateSettings).toHaveBeenCalledTimes(1);
    expect(o.settings.bringToFrontOnHotkeyCapture).toBe(true);
    expect(o.appliedSettings.bringToFrontOnHotkeyCapture).toBe(true);
  });

  it("rolls back when updateSettings errors", async () => {
    commandsMock.updateSettings.mockResolvedValueOnce({
      status: "error",
      error: "denied"
    });
    const o = new CaptureOrchestration();
    o.settings = { ...o.settings, copyToClipboard: false };
    o.appliedSettings = { ...o.settings };
    await o.toggleSetting("copyToClipboard");
    expect(o.settings.copyToClipboard).toBe(false);
    expect(o.appliedSettings.copyToClipboard).toBe(false);
    expect(o.captureActivity).toContain("denied");
  });
});

describe("toggleAutostart", () => {
  it("flips the OS autostart state through the command", async () => {
    const o = new CaptureOrchestration();
    o.autostartEnabled = false;
    await o.toggleAutostart();
    expect(commandsMock.setAutostart).toHaveBeenCalledWith(true);
    expect(o.autostartEnabled).toBe(true);
  });

  it("rolls back when setAutostart errors", async () => {
    commandsMock.setAutostart.mockResolvedValueOnce({
      status: "error",
      error: "blocked"
    });
    const o = new CaptureOrchestration();
    o.autostartEnabled = false;
    await o.toggleAutostart();
    expect(o.autostartEnabled).toBe(false);
    expect(o.captureActivity).toContain("blocked");
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
    on.settings = { ...on.settings, playCaptureSound: true };
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
});

describe("fallback shortcuts", () => {
  it("does not fire a default accelerator disabled by shortcut overrides", () => {
    const o = new CaptureOrchestration();
    o.captureModes = modes;
    o.appliedSettings = {
      ...o.appliedSettings,
      shortcutOverrides: { region: [] }
    };
    o.effectiveAccelerators = { region: [], window: [], screen: [] };
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
    o.appliedSettings = {
      ...o.appliedSettings,
      shortcutOverrides: { region: ["CommandOrControl+Shift+R"] }
    };
    o.effectiveAccelerators = { region: ["CommandOrControl+Shift+R"], window: [], screen: [] };
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
    o.registrations = [status("CommandOrControl+Shift+S", "screen", "failed")];
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
});

describe("failedShortcuts derived", () => {
  it("hides failures once the user dismisses the banner", () => {
    const o = new CaptureOrchestration();
    o.shortcutStatusByKey = {
      "Cmd+Shift+4:region": status("Cmd+Shift+4", "region", "failed")
    };
    expect(o.failedShortcuts.length).toBe(1);
    o.dismissShortcutConflicts();
    expect(o.failedShortcuts.length).toBe(0);
  });
});
