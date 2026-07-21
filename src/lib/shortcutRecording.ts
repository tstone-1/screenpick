// Maps a recorded keydown to a Tauri/global-hotkey accelerator string in the
// same spelled-out style as the app's defaults (e.g. "CommandOrControl+Shift+W").
// Keeping the format identical to capture_modes.rs means the recorded value
// registers through the exact same parser path as the built-in shortcuts.

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight"
]);

// Non-alphanumeric key codes we allow as the final chord key. Each value is a
// W3C `KeyboardEvent.code` that also matches a global-hotkey `Code` token, so it
// round-trips through the plugin's accelerator parser. Toggle keys (CapsLock,
// NumLock, ScrollLock) are intentionally excluded — they make poor shortcuts.
const ALLOWED_CODES = new Set([
  "PrintScreen",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Insert",
  "Delete",
  "Space",
  "Enter",
  "Tab",
  "Minus",
  "Equal",
  "Comma",
  "Period",
  "Slash",
  "Semicolon",
  "Quote",
  "Backquote",
  "Backslash",
  "BracketLeft",
  "BracketRight"
]);

const MODIFIER_REQUIRED_WITHOUT_PRIMARY = new Set([
  "Space",
  "Enter"
]);

// Translate a `KeyboardEvent.code` into the accelerator key token, or null if
// it isn't a key we can bind. Letters collapse to a single uppercase character
// and digits to a single digit (matching the built-in defaults like `Shift+W`);
// function keys and the allow-listed special keys pass through unchanged.
export function keyTokenFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (ALLOWED_CODES.has(code)) return code;
  return null;
}

export function codeFromKeyToken(token: string): string | null {
  if (/^[A-Z]$/.test(token)) return `Key${token}`;
  if (/^[0-9]$/.test(token)) return `Digit${token}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(token)) return token;
  if (ALLOWED_CODES.has(token)) return token;
  return null;
}

export function acceleratorMatches(
  event: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  accelerator: string,
  isMac: boolean
): boolean {
  const parts = new Set(accelerator.split("+"));
  const expected = codeFromKeyToken(accelerator.split("+").at(-1) ?? "");
  const needsCtrl =
    parts.has("Control") || (!isMac && parts.has("CommandOrControl"));
  const needsMeta =
    parts.has("Command") ||
    parts.has("Super") ||
    (isMac && parts.has("CommandOrControl"));
  const needsAlt = parts.has("Alt") || parts.has("Option");
  const needsShift = parts.has("Shift");

  return (
    expected !== null &&
    event.code === expected &&
    event.shiftKey === needsShift &&
    event.altKey === needsAlt &&
    event.ctrlKey === needsCtrl &&
    event.metaKey === needsMeta
  );
}

// Build an accelerator string from a recorded keydown, or null when the event
// is a modifier-only press or an unbindable key — letting the caller keep
// waiting for a complete chord. `isMac` controls which physical modifier maps
// to `CommandOrControl` (Cmd on macOS, Ctrl elsewhere).
export function acceleratorFromKeyboardEvent(
  event: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  isMac: boolean
): string | null {
  if (!event.code || MODIFIER_CODES.has(event.code)) return null;
  const key = keyTokenFromCode(event.code);
  if (!key) return null;

  const mods: string[] = [];
  // Order mirrors the built-in defaults: primary, then Alt, then Shift.
  if (isMac) {
    if (event.metaKey) mods.push("CommandOrControl");
    if (event.altKey) mods.push("Alt");
    if (event.shiftKey) mods.push("Shift");
    if (event.ctrlKey) mods.push("Control");
  } else {
    if (event.ctrlKey) mods.push("CommandOrControl");
    if (event.altKey) mods.push("Alt");
    if (event.shiftKey) mods.push("Shift");
    if (event.metaKey) mods.push("Super");
  }

  if (
    mods.length === 0 &&
    (/^[A-Z0-9]$/.test(key) || MODIFIER_REQUIRED_WITHOUT_PRIMARY.has(key))
  ) {
    return null;
  }

  return [...mods, key].join("+");
}
