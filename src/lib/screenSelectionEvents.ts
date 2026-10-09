// The one webview-to-webview event of the screen picker: each per-display
// overlay reports whether the pointer is over it, and the picker window
// highlights the matching row. It is a plain Tauri event, outside the specta
// contract, so this module is where its name and payload are pinned down and
// where the `@tauri-apps/api/event` import lives (the routes stay free of it).
import { emit, listen } from "@tauri-apps/api/event";

export type ScreenTargetChanged = {
  monitorId: number;
  hovered: boolean;
};

export const screenTargetChangedEvent = "screen-target-changed";

export function emitScreenTargetChanged(payload: ScreenTargetChanged): Promise<void> {
  return emit(screenTargetChangedEvent, payload);
}

// Resolves to the unlisten function.
export function listenForScreenTargetChanged(
  handler: (payload: ScreenTargetChanged) => void
): Promise<() => void> {
  return listen<ScreenTargetChanged>(screenTargetChangedEvent, (event) => handler(event.payload));
}
