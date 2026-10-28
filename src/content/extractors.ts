// Content readers injected into web pages via chrome.scripting.executeScript.
// These run in the page's isolated world: no imports, no chrome.* calls, and
// no free variables beyond `document` / `window`, so they serialize
// standalone (fn.toString()). Privacy posture (T10 family): extract text
// only — never inspect page content for decisions; that is guardrail's job,
// upstream, URL-only.
//
// Strategy: try Defuddle first (if injected as global), then fall back to
// the built-in clutter-removal + selector approach.
export function pageReader(): { title: string; text: string } | null {
  // Built-in clutter removal (Defuddle-style: removes nav, ads, sidebars, etc.)
  function cleanNode(node: Element): Element {
    const clone = node.cloneNode(true) as Element;
    const junk = clone.querySelectorAll(
      "nav, header, footer, aside, script, style, noscript, " +
      "[role='navigation'], [role='banner'], [role='complementary'], " +
      "[role='search'], [aria-hidden='true'], " +
      ".sidebar, .nav, .navbar, .menu, .footer, .header, .ad, .ads, " +
      ".advertisement, .social, .share, .comments, .related, .breadcrumb",
    );
    for (let i = 0; i < junk.length; i++) {
      junk[i].remove();
    }
    return clone;
  }

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

  const selector = "main, article, [role='main']";
  let node: Element | null = null;
  for (const part of selector.split(",")) {
    node = document.querySelector(part.trim());
    if (node !== null) break;
  }

  if (node === null) {
    const candidates = document.querySelectorAll("div, section");
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

  let raw: string;
  if (node !== null) {
    const cleaned = cleanNode(node);
    raw = (cleaned.textContent || "") + collectShadowText(node);
  } else {
    raw = (document.body?.innerText ?? "") + collectShadowText(document);
  }

  const text = raw.replace(/\s+/g, " ").trim();
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