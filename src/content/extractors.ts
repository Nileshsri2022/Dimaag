// Content readers injected into web pages via chrome.scripting.executeScript.
// These run in the page's isolated world: no imports, no chrome.* calls, and
// no free variables beyond `document` / `window`, so they serialize
// standalone (fn.toString()). Privacy posture (T10 family): extract text
// only — never inspect page content for decisions; that is guardrail's job,
// upstream, URL-only.
export function pageReader(): { title: string; text: string } | null {
  // Collect text from shadow DOM roots recursively (SPAs, web components).
  function collectShadowText(root: ParentNode): string {
    let text = "";
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node: Node | null = walker.currentNode;
      while (node) {
        if (node instanceof Element && node.shadowRoot) {
          text += " " + collectShadowText(node.shadowRoot);
        }
        node = walker.nextNode();
      }
    } catch {
      // ignore traversal errors
    }
    return text;
  }

  // Selector preference order (first match wins): main -> article -> [role='main'].
  const selector = "main, article, [role='main']";
  let node: Element | null = null;
  for (const part of selector.split(",")) {
    node = document.querySelector(part.trim());
    if (node !== null) break;
  }

  // Fallback: largest text-bearing container (handles pages without semantic landmarks).
  if (node === null) {
    const candidates = document.querySelectorAll("div, section, main, article");
    let best: Element | null = null;
    let bestLen = 0;
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const len = (el.textContent || "").trim().length;
      if (len > bestLen) {
        bestLen = len;
        best = el;
      }
    }
    if (best && bestLen >= 120) {
      node = best;
    }
  }

  const raw =
    node !== null
      ? (node.textContent || "") + collectShadowText(node)
      : (document.body?.innerText ?? "") + collectShadowText(document);

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