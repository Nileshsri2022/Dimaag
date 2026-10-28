// Content readers injected into web pages via chrome.scripting.executeScript.
// These run in the page's isolated world: no imports, no chrome.* calls, and
// no free variables beyond `document` / `window`, so they serialize
// standalone (fn.toString()). Privacy posture (T10 family): extract text
// only — never inspect page content for decisions; that is guardrail's job,
// upstream, URL-only.

export function pageReader(): { title: string; text: string } | null {
  // Selector preference order (first match wins): main -> article -> [role='main'].
  const selector = "main, article, [role='main']";
  let node: Element | null = null;
  for (const part of selector.split(",")) {
    node = document.querySelector(part.trim());
    if (node !== null) break;
  }

  const raw =
    node !== null
      ? node.textContent
      : document.body?.innerText ?? "";
  const text = raw.replace(/\s+/g, " ").trim();
  // 120 is inlined, not a module const: executeScript serializes the function
  // body alone, so every reference inside must resolve to document/window.
  if (text.length < 120) return null;
  return { title: document.title.trim(), text };
}

export function selectionReader(): string | null {
  const sel = window.getSelection();
  return sel && sel.toString().trim() !== "" ? sel.toString() : null;
}

export function buildScriptStr(
  fn: typeof pageReader | typeof selectionReader,
): string {
  return fn.toString();
}
