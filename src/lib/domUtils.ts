// Small shared DOM predicates used by multiple UI entry points that would
// otherwise each keep their own copy — and risk drifting, silently, the way
// EditorStage.svelte's `targetIsEditable` and +page.svelte's
// `eventTargetIsEditable` did before this module existed (N2 in the 2026-07
// code review: same intent, two slightly different implementations).

// Input types that take typed text. Every other input (range, checkbox, radio,
// color, button, file, ...) keeps focus after a click or drag but consumes no
// typing, so treating it as editable would leave Ctrl+Z, Delete and Space-pan
// dead until focus moved elsewhere. An empty or unknown type attribute is a
// text field by the HTML default, and `HTMLInputElement.type` already reports
// that as "text".
const TEXT_ENTRY_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number"
]);

// Whether `target` is inside an editable field (a text-entry input, textarea,
// select, or a contenteditable element) — used to bail out of keyboard
// shortcuts and tool pointer handlers while the user is typing, so typing never
// triggers a shortcut or gesture. `instanceof HTMLElement` guards the
// `isContentEditable` read so a non-HTMLElement EventTarget (rare, but the
// type allows it) can't throw.
export function targetIsEditable(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) return TEXT_ENTRY_INPUT_TYPES.has(target.type);
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable === true)
  );
}

// Suppress the browser/webview's middle-click autoscroll puck, so a
// middle-press can be used for something else instead (closing a Recent tab
// in +page.svelte, panning the canvas in EditorStage.svelte) without the OS
// autoscroll cursor popping up first. A Svelte action (`use:` directive) so
// both call sites share one implementation.
export function suppressMiddleClickAutoscroll(node: HTMLElement) {
  const onMouseDown = (event: MouseEvent) => {
    if (event.button === 1) event.preventDefault();
  };
  node.addEventListener("mousedown", onMouseDown);
  return {
    destroy: () => node.removeEventListener("mousedown", onMouseDown)
  };
}
