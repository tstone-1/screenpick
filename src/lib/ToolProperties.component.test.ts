// @vitest-environment jsdom
//
// The sliders and the colour input of a selected annotation record one undo
// step per adjustment. Pressing a control without changing its value is not an
// adjustment, and must not leave an undo step that does nothing.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import ToolProperties from "./ToolProperties.svelte";
import { editor, type Annotation, type RecentCapture } from "./editor.svelte";

function testCapture(): RecentCapture {
  return {
    mode: "region",
    title: "Properties Test Capture",
    path: "/properties-test.png",
    width: 200,
    height: 150,
    assetUrl: "asset://properties-test.png"
  };
}

const shape: Annotation = {
  kind: "shape",
  id: 1,
  shape: "rectangle",
  rect: { x: 10, y: 10, width: 40, height: 30 },
  color: "#000000",
  width: 2,
  fill: false,
  fillOpacity: 0.2
};

afterEach(() => {
  cleanup();
});

describe("ToolProperties, selected annotation", () => {
  beforeEach(() => {
    editor.openCapture(testCapture());
    editor.annotations = [shape];
    editor.activeTool = "select";
    editor.selectedAnnotationId = 1;
  });

  function widthSlider(container: HTMLElement): HTMLInputElement {
    const slider = container.querySelector<HTMLInputElement>('.selection-panel input[type="range"]');
    if (!slider) throw new Error("no width slider rendered");
    return slider;
  }

  function colourInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>('.selection-panel input[type="color"]');
    if (!input) throw new Error("no colour input rendered");
    return input;
  }

  it("pressing the slider without moving it records no undo step", () => {
    const { container } = render(ToolProperties);
    const slider = widthSlider(container);
    const before = editor.historyPast.length;

    slider.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    slider.dispatchEvent(new Event("blur"));

    expect(editor.historyPast.length).toBe(before);
  });

  it("moving the slider records exactly one undo step for the whole drag", () => {
    const { container } = render(ToolProperties);
    const slider = widthSlider(container);
    const before = editor.historyPast.length;

    slider.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    for (const value of ["4", "6", "8"]) {
      slider.value = value;
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    }
    slider.dispatchEvent(new Event("change", { bubbles: true }));

    expect(editor.historyPast.length).toBe(before + 1);
    expect(editor.annotations[0]).toMatchObject({ width: 8 });
    editor.undo();
    expect(editor.annotations[0]).toMatchObject({ width: 2 });
  });

  it("opening the colour input without choosing a colour records no undo step", () => {
    const { container } = render(ToolProperties);
    const input = colourInput(container);
    const before = editor.historyPast.length;

    input.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    input.dispatchEvent(new Event("blur"));

    expect(editor.historyPast.length).toBe(before);
  });

  it("choosing a colour records one undo step", () => {
    const { container } = render(ToolProperties);
    const input = colourInput(container);
    const before = editor.historyPast.length;

    input.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    input.value = "#ff0000";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    expect(editor.historyPast.length).toBe(before + 1);
    expect(editor.annotations[0]).toMatchObject({ color: "#ff0000" });
  });
});
