import { describe, expect, it } from "vitest";

import {
  acceleratorFromKeyboardEvent,
  acceleratorMatches,
  codeFromKeyToken,
  keyTokenFromCode
} from "./shortcutRecording";

type KeyEventLike = Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

function ev(code: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

describe("keyTokenFromCode", () => {
  it("collapses letters and digits to a single character", () => {
    expect(keyTokenFromCode("KeyW")).toBe("W");
    expect(keyTokenFromCode("Digit4")).toBe("4");
  });

  it("passes function keys and allow-listed specials through unchanged", () => {
    expect(keyTokenFromCode("F5")).toBe("F5");
    expect(keyTokenFromCode("F24")).toBe("F24");
    expect(keyTokenFromCode("PrintScreen")).toBe("PrintScreen");
    expect(keyTokenFromCode("ArrowUp")).toBe("ArrowUp");
  });

  it("rejects unbindable and toggle keys", () => {
    expect(keyTokenFromCode("CapsLock")).toBeNull();
    expect(keyTokenFromCode("F25")).toBeNull();
    expect(keyTokenFromCode("ShiftLeft")).toBeNull();
  });
});

describe("codeFromKeyToken", () => {
  it("inverts recordable letters, digits, function keys, and specials", () => {
    expect(codeFromKeyToken("W")).toBe("KeyW");
    expect(codeFromKeyToken("4")).toBe("Digit4");
    expect(codeFromKeyToken("F5")).toBe("F5");
    expect(codeFromKeyToken("PrintScreen")).toBe("PrintScreen");
  });
});

describe("acceleratorMatches", () => {
  it("matches CommandOrControl to Ctrl off macOS", () => {
    expect(
      acceleratorMatches(
        ev("KeyW", { ctrlKey: true, shiftKey: true }),
        "CommandOrControl+Shift+W",
        false
      )
    ).toBe(true);
  });

  it("requires modifiers to match exactly", () => {
    expect(
      acceleratorMatches(
        ev("KeyW", { ctrlKey: true, metaKey: true, shiftKey: true }),
        "CommandOrControl+Shift+W",
        false
      )
    ).toBe(false);
  });
});

describe("acceleratorFromKeyboardEvent", () => {
  it("emits the spelled-out default style on Windows/Linux", () => {
    expect(acceleratorFromKeyboardEvent(ev("KeyW", { ctrlKey: true, shiftKey: true }), false)).toBe(
      "CommandOrControl+Shift+W"
    );
    expect(acceleratorFromKeyboardEvent(ev("Digit4", { ctrlKey: true, shiftKey: true }), false)).toBe(
      "CommandOrControl+Shift+4"
    );
  });

  it("orders modifiers primary, Alt, Shift", () => {
    expect(
      acceleratorFromKeyboardEvent(ev("KeyW", { ctrlKey: true, altKey: true, shiftKey: true }), false)
    ).toBe("CommandOrControl+Alt+Shift+W");
  });

  it("supports Alt+PrintScreen", () => {
    expect(acceleratorFromKeyboardEvent(ev("PrintScreen", { altKey: true }), false)).toBe(
      "Alt+PrintScreen"
    );
  });

  it("maps Cmd to CommandOrControl and Ctrl to Control on macOS", () => {
    expect(acceleratorFromKeyboardEvent(ev("KeyS", { metaKey: true, shiftKey: true }), true)).toBe(
      "CommandOrControl+Shift+S"
    );
    expect(acceleratorFromKeyboardEvent(ev("KeyS", { ctrlKey: true }), true)).toBe("Control+S");
  });

  it("maps the Windows key to Super on Windows/Linux", () => {
    expect(acceleratorFromKeyboardEvent(ev("KeyW", { metaKey: true }), false)).toBe("Super+W");
  });

  it("returns null for modifier-only or unbindable presses", () => {
    expect(acceleratorFromKeyboardEvent(ev("ShiftLeft", { shiftKey: true }), false)).toBeNull();
    expect(acceleratorFromKeyboardEvent(ev("CapsLock"), false)).toBeNull();
  });

  it("allows a bare special or function key with no modifier", () => {
    expect(acceleratorFromKeyboardEvent(ev("F5"), false)).toBe("F5");
    expect(acceleratorFromKeyboardEvent(ev("PrintScreen"), false)).toBe("PrintScreen");
  });

  it("rejects bare text-entry keys that would become global hotkeys", () => {
    expect(acceleratorFromKeyboardEvent(ev("KeyE"), false)).toBeNull();
    expect(acceleratorFromKeyboardEvent(ev("Digit5"), false)).toBeNull();
    expect(acceleratorFromKeyboardEvent(ev("Space"), false)).toBeNull();
    expect(acceleratorFromKeyboardEvent(ev("Enter"), false)).toBeNull();
  });
});
