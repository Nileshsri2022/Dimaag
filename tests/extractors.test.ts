import { afterEach, describe, expect, it } from "vitest";
import { buildScriptStr, pageReader, selectionReader } from "../src/content/extractors";

// The readers run in a page context via chrome.scripting; jsdom does not
// implement innerText, so fixtures that exercise the body fallback stub it
// with the value a real browser would compute from the rendered text.
function setBodyInnerText(value: string): void {
  Object.defineProperty(document.body, "innerText", {
    value,
    configurable: true,
    writable: true,
  });
}

function makeParagraph(): string {
  return "The quick brown fox jumps over the lazy dog near the riverbank at dawn. ";
}

afterEach(() => {
  document.body.innerHTML = "";
  document.title = "";
});

describe("pageReader", () => {
  it("(a) returns trimmed document.title and main's collapsed text when <main> exists", () => {
    document.title = "  Example Page  ";
    const main = document.createElement("main");
    main.textContent = `  ${makeParagraph()}  ${makeParagraph()}  Some   spaced   out   words. `;
    document.body.appendChild(main);

    const result = pageReader();

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Example Page");
    expect(result?.text).toBe(
      `${makeParagraph()}${makeParagraph()}Some spaced out words.`.trim(),
    );
  });

  it("(b) falls back to document.body.innerText collapsed when no main/article/[role='main']", () => {
    document.title = "Fallback Page";
    document.body.innerHTML = "<div><p>Only body content here.</p></div>";
    setBodyInnerText(
      `  Line one\n  ${makeParagraph()}  ${makeParagraph()}\t\tand   more   lines  `,
    );

    const result = pageReader();

    expect(result).not.toBeNull();
    expect(result?.text).toBe(
      `Line one ${makeParagraph()}${makeParagraph()}and more lines`.trim(),
    );
  });

  it("(c) returns null when collapsed body text is under 120 chars", () => {
    setBodyInnerText("This body text is only fifty characters long-ish....");
    const result = pageReader();
    expect(result).toBeNull();
  });

  it("returns an empty title when document.title is empty (gate is text-only)", () => {
    const main = document.createElement("main");
    main.textContent = makeParagraph().repeat(3);
    document.body.appendChild(main);

    const result = pageReader();

    expect(result).not.toBeNull();
    expect(result?.title).toBe("");
  });

  it("prefers main over article and [role='main'] regardless of document order", () => {
    document.title = "Preference";
    document.body.innerHTML = [
      `<article>${makeParagraph()}${makeParagraph()}Article body text. Second sentence.</article>`,
      `<main>${makeParagraph()}${makeParagraph()}Main body text. Second sentence.</main>`,
      `<section role='main'>${makeParagraph()}Role body text.</section>`,
    ].join("");

    const result = pageReader();

    expect(result?.text).toContain("Main body text.");
    expect(result?.text).not.toContain("Article body text.");
  });

  it("prefers article over [role='main'] when no main exists", () => {
    document.title = "Preference 2";
    document.body.innerHTML = [
      `<section role='main'>${makeParagraph()}${makeParagraph()}Role body text. Second sentence.</section>`,
      `<article>${makeParagraph()}${makeParagraph()}Article body text. Second sentence.</article>`,
    ].join("");

    const result = pageReader();

    expect(result?.text).toContain("Article body text.");
    expect(result?.text).not.toContain("Role body text.");
  });
});

describe("selectionReader", () => {
  it("(d) returns the selected text as-is (verbatim, no collapsing)", () => {
    document.body.innerHTML =
      "<p>Selected   verbatim   quote with odd spacing</p>";
    const selection = window.getSelection();
    expect(selection).not.toBeNull();
    selection!.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("p")!);
    selection!.addRange(range);

    expect(selectionReader()).toBe(
      "Selected   verbatim   quote with odd spacing",
    );
  });

  it("returns short selections (no 120-char gate on selections)", () => {
    document.body.innerHTML = "<p>Short quote</p>";
    const selection = window.getSelection();
    selection!.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("p")!);
    selection!.addRange(range);

    expect(selectionReader()).toBe("Short quote");
  });

  it("returns null when there is no selection", () => {
    const original = window.getSelection;
    window.getSelection = () =>
      ({ toString: () => "" }) as unknown as Selection;
    try {
      expect(selectionReader()).toBeNull();
    } finally {
      window.getSelection = original;
    }
  });

  it("returns null for a whitespace-only selection", () => {
    const original = window.getSelection;
    window.getSelection = () =>
      ({ toString: () => "   \n\t  " }) as unknown as Selection;
    try {
      expect(selectionReader()).toBeNull();
    } finally {
      window.getSelection = original;
    }
  });
});

describe("buildScriptStr", () => {
  it("returns the function source for pageReader", () => {
    const src = buildScriptStr(pageReader);
    expect(typeof src).toBe("string");
    expect(src).toContain("main, article");
    expect(src).toContain("[role='main']");
  });

  it("returns the function source for selectionReader", () => {
    const src = buildScriptStr(selectionReader);
    expect(src).toContain("getSelection");
  });

  it("serialized pageReader is self-contained: runs when reconstructed outside module scope", () => {
    // executeScript serializes the function body alone; any free variable
    // beyond document/window would throw here (ReferenceError).
    const rebuilt = new Function(
      `return (${buildScriptStr(pageReader)})`,
    )() as typeof pageReader;
    document.title = "Injected";
    const main = document.createElement("main");
    main.textContent = makeParagraph().repeat(3);
    document.body.appendChild(main);

    expect(rebuilt()).toEqual(pageReader());
    expect(rebuilt()).toEqual({
      title: "Injected",
      text: makeParagraph().repeat(3).trim(),
    });
  });

  it("serialized selectionReader is self-contained: runs when reconstructed outside module scope", () => {
    const rebuilt = new Function(
      `return (${buildScriptStr(selectionReader)})`,
    )() as typeof selectionReader;
    document.body.innerHTML = "<p>Injected selection probe</p>";
    const selection = window.getSelection();
    selection!.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("p")!);
    selection!.addRange(range);

    expect(rebuilt()).toBe("Injected selection probe");
  });

  it("round-trips: Function() reconstructs the reader from the serialized source", () => {
    const rebuilt = new Function(
      `return (${buildScriptStr(selectionReader)})`,
    )() as typeof selectionReader;
    expect(rebuilt).toBeInstanceOf(Function);
  });
});
