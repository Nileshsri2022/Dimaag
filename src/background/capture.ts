/**
 * Background capture flow: the service worker owns `chrome.scripting
 * .executeScript` (the side panel never injects scripts), so a CAPTURE
 * request here queries the active tab, runs the Task 12 reader in the page's
 * isolated world, and hands the result to the router's INGEST orchestration.
 *
 * Every failure — no tab, unreadable page, no selection, no host access —
 * surfaces as `{ ok: false, error }`, never a throw across the message
 * boundary.
 */

import { pageReader, selectionReader } from "../content/extractors";
import type { SourceType } from "../lib/types";
import { handleRequest, type IngestResult, type RouterDeps } from "./router";

export interface CaptureRequest {
  sourceType: SourceType;
  sensitiveConfirmed: boolean;
}

export type CaptureResult = IngestResult | { ok: false; error: string };

export interface CaptureDeps extends RouterDeps {
  queryTabs: (query: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>;
  /** Narrow slice of chrome.scripting.executeScript used here (func injection). */
  executeScript: (injection: { target: { tabId: number }; func: () => unknown }) => Promise<Array<{ result?: unknown }>>;
}

export async function handleCapture(
  req: { type: "CAPTURE"; payload: CaptureRequest },
  deps: CaptureDeps,
): Promise<CaptureResult> {
  try {
    let [tab] = await deps.queryTabs({ active: true, lastFocusedWindow: true });
    if (!tab || tab.id === undefined || !tab.url) {
      [tab] = await deps.queryTabs({ active: true, currentWindow: true });
    }
    if (!tab || tab.id === undefined || !tab.url) {
      return { ok: false, error: "No active tab to capture." };
    }

    const isPage = req.payload.sourceType === "page";
    const [injection] = isPage
      ? await deps.executeScript({ target: { tabId: tab.id }, func: pageReader })
      : await deps.executeScript({ target: { tabId: tab.id }, func: selectionReader });

    if (isPage) {
      const read = injection?.result as { title: string; text: string } | null | undefined;
      if (!read) {
        return { ok: false, error: "Could not read this page's text." };
      }
      return await ingestFromCapture(deps, tab.url, read.title, read.text, req.payload);
    }

    const selection = injection?.result as string | null | undefined;
    if (!selection) {
      return { ok: false, error: "No text selection found on this page." };
    }
    // Selection documents keep the page's URL and get the tab's title.
    return await ingestFromCapture(deps, tab.url, tab.title?.trim() || tab.url, selection, req.payload);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// The request is INGEST by construction, so the router's result is an
// IngestResult; the cast just records that.
function ingestFromCapture(
  deps: CaptureDeps,
  url: string,
  title: string,
  text: string,
  payload: CaptureRequest,
): Promise<IngestResult> {
  return handleRequest(
    {
      type: "INGEST",
      payload: { url, title, text, sourceType: payload.sourceType, sensitiveConfirmed: payload.sensitiveConfirmed },
    },
    deps,
  ) as Promise<IngestResult>;
}
