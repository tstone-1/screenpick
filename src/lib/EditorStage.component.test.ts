// @vitest-environment jsdom
//
// W9 in the 2026-07 code review: the codebase had zero Svelte component
// tests (vitest.config.ts was node-env only), so pointer/event wiring on the
// biggest interactive component had no test harness at all. This is the
// first component test — see vitest.config.ts for how the jsdom environment
// is scoped to just `*.component.test.ts` files via the `@vitest-environment`
// docblock above (Vitest 4 removed `environmentMatchGlobs`, the glob-based
// mechanism referenced in the review).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import EditorStage from "./EditorStage.svelte";
import { editor, type RecentCapture } from "./editor.svelte";

// jsdom has no PointerEvent constructor and doesn't implement the pointer
// capture API at all (a long-standing jsdom gap:
// https://github.com/jsdom/jsdom/issues/2527) — EditorStage's pointer
// handlers call set/release/hasPointerCapture unconditionally, so without
// this polyfill every pointer gesture throws "not a function" the instant it
// starts, before any of the tool logic under test even runs.
beforeAll(() => {
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = vi.fn();
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  }
  if (!HTMLElement.prototype.hasPointerCapture) {
    HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  }
});

afterEach(() => {
  cleanup();
});

// A MouseEvent carries every field EditorStage's handlers actually read
// (button/clientX/clientY); `pointerId` is stapled on top since the handlers
// pass it straight through to the polyfilled set/releasePointerCapture calls
// above, which ignore it. Avoids depending on jsdom's absent PointerEvent
// constructor.
function pointerEvent(
  type: "pointerdown" | "pointermove" | "pointerup",
  init: { clientX: number; clientY: number; button?: number; pointerId?: number }
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
    button: init.button ?? 0
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  return event;
}

function testCapture(): RecentCapture {
  return {
    mode: "region",
    title: "Component Test Capture",
    path: "/component-test.png",
    width: 200,
    height: 150,
    assetUrl: "asset://component-test.png"
  };
}

describe("EditorStage", () => {
  beforeEach(() => {
    // `editor` is the real module singleton (EditorStage imports it directly,
    // not via props), so each test opens a fresh in-memory capture rather
    // than relying on cross-test isolation of shared state.
    editor.openCapture(testCapture());
    editor.activeTool = "select";
    editor.annotations = [];
  });

  it("mounts and renders the capture frame", () => {
    const { container } = render(EditorStage);

    const frame = container.querySelector(".image-frame");
    expect(frame).not.toBeNull();

    const img = container.querySelector("img.capture-preview");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("asset://component-test.png");
  });

  it("pen tool pointerdown/move/up produces exactly one committed stroke and stays on the pen tool", () => {
    editor.activeTool = "pen";

    const { container } = render(EditorStage);
    const frame = container.querySelector(".image-frame");
    expect(frame).not.toBeNull();

    frame!.dispatchEvent(pointerEvent("pointerdown", { clientX: 10, clientY: 10, pointerId: 1 }));
    frame!.dispatchEvent(pointerEvent("pointermove", { clientX: 40, clientY: 40, pointerId: 1 }));
    frame!.dispatchEvent(pointerEvent("pointerup", { clientX: 40, clientY: 40, pointerId: 1 }));

    expect(editor.annotations).toHaveLength(1);
    expect(editor.annotations[0]?.kind).toBe("pen");
    expect(editor.activeTool).toBe("pen");
  });
});
