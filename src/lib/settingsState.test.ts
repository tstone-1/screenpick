import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureMode, CaptureSettings, ShortcutStatus } from "./bindings";
// The corpus `settings.rs` compiles in with include_str!. Editing it exercises
// both sanitize implementations; see the file's own _readme.
import sanitizeFixture from "./shortcutSanitizeFixture.json";

// Mock the modules the store imports BEFORE importing the class itself, so
// constructing one never touches a real Tauri IPC.
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
  shortcutStatus: vi.fn(),
  suspendShortcuts: vi.fn(),
  resumeShortcuts: vi.fn(),
  effectiveShortcutAccelerators: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  resetShortcutSettings: vi.fn(),
  autostartEnabled: vi.fn(),
  setAutostart: vi.fn()
}));

vi.mock("./bindings", () => ({
  commands: commandsMock,
  events: {}
}));

vi.mock("./editorCommands", () => ({
  pickDirectory: vi.fn()
}));

// The store lives in a .svelte.ts file but its behavior is testable here:
// vitest runs through Vite with the Svelte plugin so $state/$derived are
// real reactivity in this environment.
const { SettingsState, sanitizeShortcutOverrides } = await import("./settingsState.svelte");
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

// The store reads the capture-mode registry through an accessor owned by
// CaptureOrchestration; here that is just the fixture list.
function newSettings(): InstanceType<typeof SettingsState> {
  return new SettingsState(() => modes);
}

// A started app has answered get_settings, which is what unlocks saving — the
// gate that stops a toggle writing `defaultSettings` over the stored struct.
// Tests that exercise a save path construct through this; the gate itself is
// covered by its own cases below.
function loadedSettings(): InstanceType<typeof SettingsState> {
  const s = newSettings();
  s.settingsLoaded = true;
  return s;
}

function status(accelerator: string, mode: string, state: "registered" | "failed"): ShortcutStatus {
  return { accelerator, mode, state, error: null };
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

beforeEach(() => {
  vi.clearAllMocks();
  // The status line is a module singleton shared by every store instance, so a
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

describe("formatShortcut", () => {
  it("returns Unavailable for null", () => {
    expect(newSettings().formatShortcut(null)).toBe("Unavailable");
  });

  it("joins parts with platform-appropriate separator", () => {
    // The store detects macOS via navigator.platform at module load; we can't
    // easily flip it, so just check the parts are mapped.
    const result = newSettings().formatShortcut("CommandOrControl+Shift+4");
    expect(result).toContain("4");
    // Either the macOS glyph chord or the spelled-out Windows rendering.
    expect(result === "⌘⇧4" || result === "Ctrl+Shift+4").toBe(true);
  });
});

describe("statusKey", () => {
  it("combines accelerator and mode", () => {
    expect(newSettings().statusKey(status("Cmd+1", "region", "registered"))).toBe("Cmd+1:region");
  });
});

describe("shortcut draft round-trip", () => {
  it("addShortcutEntry seeds from defaults and appends a blank row", () => {
    const s = newSettings();
    expect(s.getModeAccelerators("window")).toEqual([
      "CommandOrControl+Shift+W",
      "CommandOrControl+Alt+W"
    ]);
    s.addShortcutEntry("window");
    expect(s.getModeAccelerators("window")).toEqual([
      "CommandOrControl+Shift+W",
      "CommandOrControl+Alt+W",
      ""
    ]);
    // Drafts preserve blanks; Rust's sanitize_settings drops them at save.
    expect(s.settings.shortcutOverrides?.window).toEqual([
      "CommandOrControl+Shift+W",
      "CommandOrControl+Alt+W",
      ""
    ]);
  });

  it("setShortcutEntry replaces the accelerator at the given index", () => {
    const s = newSettings();
    s.addShortcutEntry("region");
    s.setShortcutEntry("region", 1, "CommandOrControl+Shift+R");
    expect(s.getModeAccelerators("region")).toEqual([
      "CommandOrControl+Shift+4",
      "CommandOrControl+Shift+R"
    ]);
  });

  it("removeShortcutEntry drops the row at the given index", async () => {
    const s = loadedSettings();
    s.addShortcutEntry("window");
    await s.removeShortcutEntry("window", 0);
    expect(s.getModeAccelerators("window")).toEqual([
      "CommandOrControl+Alt+W",
      ""
    ]);
  });

  // The click that removes a row also blurs the field, and that blur handler
  // runs first — on the pre-removal draft. So removal cannot wait for a blur of
  // its own; it has to commit itself or the deletion is silently lost.
  it("removeShortcutEntry persists without waiting for a blur", async () => {
    const s = loadedSettings();
    await s.removeShortcutEntry("window", 1);
    expect(commandsMock.updateSettings).toHaveBeenCalledTimes(1);
    expect(settingsHolder.current.shortcutOverrides?.window).toEqual([
      "CommandOrControl+Shift+W"
    ]);
  });
});

describe("blur commits the recorded shortcut", () => {
  it("saves and re-registers when a chord was recorded", async () => {
    const s = loadedSettings();
    await s.beginShortcutRecording();
    s.setShortcutEntry("window", 0, "CommandOrControl+Shift+G");
    await s.endShortcutRecording();

    expect(commandsMock.updateSettings).toHaveBeenCalledTimes(1);
    expect(settingsHolder.current.shortcutOverrides?.window).toEqual([
      "CommandOrControl+Shift+G",
      "CommandOrControl+Alt+W"
    ]);
    expect(s.appliedSettings.shortcutOverrides?.window?.[0]).toBe("CommandOrControl+Shift+G");
    // update_settings re-registers everything, so a separate resume would be a
    // redundant unregister/register cycle.
    expect(commandsMock.resumeShortcuts).not.toHaveBeenCalled();
  });

  it("only resumes when nothing was recorded", async () => {
    const s = loadedSettings();
    await s.beginShortcutRecording();
    await s.endShortcutRecording();

    expect(commandsMock.resumeShortcuts).toHaveBeenCalledTimes(1);
    expect(commandsMock.updateSettings).not.toHaveBeenCalled();
  });

  // A blank row is not a change: the backend never stores one, so treating it as
  // dirty would save-and-re-register on every blur of an untouched field.
  it("treats a blank placeholder row as no change", async () => {
    const s = loadedSettings();
    s.appliedSettings = {
      ...s.appliedSettings,
      shortcutOverrides: { window: ["CommandOrControl+Shift+W"] }
    };
    s.shortcutEditorDrafts = { window: ["CommandOrControl+Shift+W"] };
    s.addShortcutEntry("window");
    await s.endShortcutRecording();

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

    const s = loadedSettings();
    s.setShortcutEntry("window", 0, "CommandOrControl+Shift+G");
    const blur = s.endShortcutRecording();
    const focus = s.beginShortcutRecording();
    await Promise.all([blur, focus]);

    expect(order).toEqual(["save", "suspend"]);
  });

  // A save triggered from one mode must not delete a blank row the user just
  // added under another: the backend strips blanks, so adopting its response
  // wholesale would make the row disappear mid-edit.
  it("keeps an unfilled row in another mode across a save", async () => {
    const s = loadedSettings();
    s.addShortcutEntry("screen");
    s.setShortcutEntry("window", 0, "CommandOrControl+Shift+G");
    await s.endShortcutRecording();

    expect(settingsHolder.current.shortcutOverrides?.screen).toEqual([
      "CommandOrControl+Shift+S"
    ]);
    expect(s.getModeAccelerators("screen")).toEqual(["CommandOrControl+Shift+S", ""]);
  });
});

describe("shortcutRowState", () => {
  it("reports the registration state of a committed row", () => {
    const s = newSettings();
    s.shortcutStatusByKey = {
      "CommandOrControl+Shift+W:window": status("CommandOrControl+Shift+W", "window", "registered"),
      "CommandOrControl+Alt+W:window": {
        ...status("CommandOrControl+Alt+W", "window", "failed"),
        error: "HotKey already registered"
      }
    };
    expect(s.shortcutRowState("window", "CommandOrControl+Shift+W")).toBe("registered");
    expect(s.shortcutRowState("window", "CommandOrControl+Alt+W")).toBe("failed");
    expect(s.shortcutRowState("window", "")).toBe("empty");
    expect(s.shortcutRowState("screen", "CommandOrControl+Shift+S")).toBe("pending");
  });

  // The collision that started this: the recorder emits Cmd+Alt+Shift+4 while
  // the region default is spelled Cmd+Shift+Alt+4. Same chord, different string
  // — so a raw compare misses it and only the OS notices, by refusing the
  // second registration.
  it("flags a duplicate chord that differs only in modifier order", () => {
    const s = newSettings();
    s.shortcutStatusByKey = {
      "CommandOrControl+Shift+W:window": status("CommandOrControl+Shift+W", "window", "registered")
    };
    s.shortcutEditorDrafts = {
      region: ["CommandOrControl+Shift+Alt+4"],
      window: ["CommandOrControl+Shift+W", "CommandOrControl+Alt+Shift+4"]
    };
    expect(s.shortcutRowState("window", "CommandOrControl+Alt+Shift+4")).toBe("duplicate");
    // Both sides of the collision are flagged; neither is the "right" one.
    expect(s.shortcutRowState("region", "CommandOrControl+Shift+Alt+4")).toBe("duplicate");
    // A chord bound once is untouched — the check flags collisions, not any
    // accelerator that happens to share modifiers with another.
    expect(s.shortcutRowState("window", "CommandOrControl+Shift+W")).toBe("registered");
  });
});

describe("toggleSetting", () => {
  it("flips a boolean setting and persists via updateSettings", async () => {
    const s = loadedSettings();
    s.settings = { ...s.settings, autoOpenEditor: true };
    s.appliedSettings = { ...s.settings };
    await s.toggleSetting("autoOpenEditor");
    expect(commandsMock.updateSettings).toHaveBeenCalledTimes(1);
    expect(s.settings.autoOpenEditor).toBe(false);
    expect(s.appliedSettings.autoOpenEditor).toBe(false);
  });

  it("toggles bring-to-front hotkey capture", async () => {
    const s = loadedSettings();
    s.settings = { ...s.settings, bringToFrontOnHotkeyCapture: false };
    s.appliedSettings = { ...s.settings };
    await s.toggleSetting("bringToFrontOnHotkeyCapture");
    expect(commandsMock.updateSettings).toHaveBeenCalledTimes(1);
    expect(s.settings.bringToFrontOnHotkeyCapture).toBe(true);
    expect(s.appliedSettings.bringToFrontOnHotkeyCapture).toBe(true);
  });

  it("rolls back when updateSettings errors", async () => {
    commandsMock.updateSettings.mockResolvedValueOnce({
      status: "error",
      error: "denied"
    });
    const s = loadedSettings();
    s.settings = { ...s.settings, copyToClipboard: false };
    s.appliedSettings = { ...s.settings };
    await s.toggleSetting("copyToClipboard");
    expect(s.settings.copyToClipboard).toBe(false);
    expect(s.appliedSettings.copyToClipboard).toBe(false);
    expect(statusLine.message).toContain("denied");
  });
});

// update_settings replaces the whole stored struct, so a save made from the
// frontend's own defaults writes `saveDirectory: null` and empty overrides over
// whatever the user had configured. Rust preserves the two fields it owns
// (last_run_version, version) unconditionally; the rest can only be protected
// here, by refusing to save a baseline that was never loaded. The control for
// these two — the gate opening once startup has loaded the stored settings —
// runs through `CaptureOrchestration.setup()` in captureOrchestration.test.ts.
describe("settings-load gate", () => {
  it("does not save a toggle made before get_settings has answered", async () => {
    const s = newSettings();
    s.settings = { ...s.settings, saveDirectory: "/stored/captures", autoOpenEditor: true };
    s.appliedSettings = { ...s.settings };

    await s.toggleSetting("autoOpenEditor");

    expect(commandsMock.updateSettings).not.toHaveBeenCalled();
    // The optimistic flip is rolled back, so the switch matches what is stored.
    expect(s.settings.autoOpenEditor).toBe(true);
    expect(statusLine.message).toContain("still loading");
  });

  it("does not save a shortcut edit made before get_settings has answered", async () => {
    const s = newSettings();
    s.setShortcutEntry("window", 0, "CommandOrControl+Shift+G");

    await s.endShortcutRecording();

    expect(commandsMock.updateSettings).not.toHaveBeenCalled();
  });

  // adoptStoredSettings is the only path that may open the gate from a backend
  // answer; it is what `CaptureOrchestration.#start` calls.
  it("opens once the stored settings have been adopted", async () => {
    const s = newSettings();
    s.adoptStoredSettings({ ...settingsHolder.current, saveDirectory: "/stored/captures" });
    expect(s.settingsLoaded).toBe(true);

    await s.toggleSetting("autoOpenEditor");

    expect(commandsMock.updateSettings).toHaveBeenCalledTimes(1);
    expect(settingsHolder.current.saveDirectory).toBe("/stored/captures");
  });
});

describe("toggleAutostart", () => {
  it("flips the OS autostart state through the command", async () => {
    const s = newSettings();
    s.autostartEnabled = false;
    await s.toggleAutostart();
    expect(commandsMock.setAutostart).toHaveBeenCalledWith(true);
    expect(s.autostartEnabled).toBe(true);
  });

  it("rolls back when setAutostart errors", async () => {
    commandsMock.setAutostart.mockResolvedValueOnce({
      status: "error",
      error: "blocked"
    });
    const s = newSettings();
    s.autostartEnabled = false;
    await s.toggleAutostart();
    expect(s.autostartEnabled).toBe(false);
    expect(statusLine.message).toContain("blocked");
  });
});

// The sanitize rules exist on both sides of the IPC boundary on purpose (a
// round trip per keystroke would be worse), so the corpus is the pin: this case
// and `settings.rs`'s `sanitize_settings_agrees_with_the_shared_frontend_fixture`
// read the same file, and drift fails on whichever side drifted.
describe("sanitizeShortcutOverrides", () => {
  it("agrees with the shared fixture the Rust side also reads", () => {
    // TypeScript widens a JSON import to the union of the literal case shapes,
    // where each case's absent mode keys are typed `undefined`; the corpus is a
    // map of mode id to accelerators and is read as one.
    const cases = sanitizeFixture.cases as {
      name: string;
      input: Record<string, string[]>;
      expected: Record<string, string[]>;
    }[];
    expect(cases.length).toBeGreaterThan(0);
    for (const testCase of cases) {
      expect(sanitizeShortcutOverrides(testCase.input), testCase.name).toEqual(testCase.expected);
    }
  });
});
