// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { targetIsEditable } from "./domUtils";

function input(type?: string): HTMLInputElement {
  const element = document.createElement("input");
  if (type !== undefined) element.setAttribute("type", type);
  return element;
}

describe("targetIsEditable", () => {
  it.each(["text", "search", "url", "tel", "email", "password", "number", "bogus-type"])(
    "treats a %s input as editable",
    (type) => {
      expect(targetIsEditable(input(type))).toBe(true);
    }
  );

  it("treats an input with no type attribute as editable", () => {
    expect(targetIsEditable(input())).toBe(true);
  });

  // These keep focus after a click or drag but take no typing, so shortcuts
  // must keep working while one is focused.
  it.each(["range", "checkbox", "radio", "color", "button", "file"])(
    "does not treat a %s input as editable",
    (type) => {
      expect(targetIsEditable(input(type))).toBe(false);
    }
  );

  it("treats textarea and select as editable", () => {
    expect(targetIsEditable(document.createElement("textarea"))).toBe(true);
    expect(targetIsEditable(document.createElement("select"))).toBe(true);
  });

  it("treats a contenteditable element as editable", () => {
    const element = document.createElement("div");
    // jsdom does not implement isContentEditable, so define what a browser reports.
    Object.defineProperty(element, "isContentEditable", { value: true });
    expect(targetIsEditable(element)).toBe(true);
  });

  it("does not treat a plain element, a button or null as editable", () => {
    expect(targetIsEditable(document.createElement("div"))).toBe(false);
    expect(targetIsEditable(document.createElement("button"))).toBe(false);
    expect(targetIsEditable(null)).toBe(false);
  });
});
