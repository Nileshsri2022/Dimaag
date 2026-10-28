import { extractDocument } from "../lib/extraction";
import { chat, getSettings } from "../lib/llmClient";
import { createLocalStore } from "../lib/localStore";
import { handleRequest, type Req } from "./router";

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error(err));

// Real deps: IndexedDB-backed local graph, chrome.storage-backed LLM settings.
const deps = {
  store: createLocalStore,
  llm: getSettings,
  chat,
  extract: extractDocument,
};

// sendResponse is used asynchronously, so the listener must return true to
// keep the message channel open.
chrome.runtime.onMessage.addListener((req: Req, _sender, sendResponse) => {
  handleRequest(req, deps)
    .then(sendResponse)
    .catch((err) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  return true;
});
