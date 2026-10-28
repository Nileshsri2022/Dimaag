import { extractDocument } from "../lib/extraction";
import { errorMessage } from "../lib/errorMessage";
import { chat, getSettings } from "../lib/llmClient";
import { createLocalStore } from "../lib/localStore";
import { handleCapture, type CaptureDeps, type CaptureRequest } from "./capture";
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

// Capture deps: the service worker owns tabs.query and executeScript; the
// side panel only ever asks the background to capture (Task 14 contract).
const captureDeps: CaptureDeps = {
  ...deps,
  queryTabs: (query) => chrome.tabs.query(query),
  executeScript: (injection) => chrome.scripting.executeScript(injection),
};

// sendResponse is used asynchronously, so the listener must return true to
// keep the message channel open.
chrome.runtime.onMessage.addListener((req: Req | { type: "CAPTURE"; payload: CaptureRequest } | { type: "GET_ACTIVE_TAB" }, _sender, sendResponse) => {
  const pending =
    req.type === "CAPTURE"
      ? handleCapture(req, captureDeps)
      : req.type === "GET_ACTIVE_TAB"
        ? (async () => {
            try {
              const [tab] = await captureDeps.queryTabs({ active: true, currentWindow: true });
              if (!tab || !tab.url) return { ok: false, error: "No active tab." };
              return { ok: true, tab: { url: tab.url, title: tab.title?.trim() || tab.url } };
            } catch (err) {
              return { ok: false, error: errorMessage(err) };
            }
          })()
        : handleRequest(req, deps);
  pending
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: errorMessage(err) }));
  return true;
});
