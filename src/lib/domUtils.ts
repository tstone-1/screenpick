// Small shared DOM predicates used by multiple UI entry points that would
// otherwise each keep their own copy — and risk drifting, silently, the way
// EditorStage.svelte's `targetIsEditable` and +page.svelte's
// `eventTargetIsEditable` did before this module existed (N2 in the 2026-07
// code review: same intent, two slightly different implementations).

// Whether `target` is inside an editable field (a text input/textarea, or a
// contenteditable element) — used to bail out of keyboard shortcuts and tool
// pointer handlers while the user is typing, so typing never triggers a
// shortcut or gesture. `instanceof HTMLElement` guards the
// `isContentEditable` read so a non-HTMLElement EventTarget (rare, but the
// type allows it) can't throw.
export function targetIsEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
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
