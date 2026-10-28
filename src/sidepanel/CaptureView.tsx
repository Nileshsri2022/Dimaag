import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bookmark,
  CheckCircle2,
  Globe,
  LoaderCircle,
  Quote,
  Shield,
  TriangleAlert,
} from "lucide-react";
import { errorMessage } from "../lib/errorMessage";
import type { IngestResult } from "../background/router";
import type { SourceType } from "../lib/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/** Numbers shown in a done capture's report line. */
interface CaptureReport {
  chunkCount: number;
  entityCount: number;
  edgeCount: number;
  errors?: string[];
}

/**
 * One row of the "After capture" list. Lives in component state only (the
 * plan's ruling) — a reload loses the history, the graph itself does not.
 */
interface CaptureItem {
  id: number;
  sourceType: SourceType;
  title: string;
  state: "processing" | "sensitive" | "done" | "failed";
  report?: CaptureReport;
  error?: string;
}

/**
 * Capture view (the approved Task 12A Capture design, ported): the current
 * page card, the two capture actions, the sensitive-page note, and the
 * per-capture status list.
 *
 * All work happens in the background: the view only sends
 * `chrome.runtime.sendMessage({ type: "CAPTURE" })` — the service worker
 * queries the active tab, runs the readers via `chrome.scripting
 * .executeScript`, and answers with the router's IngestResult. Sensitive
 * pages are caught up front with the URL-only guardrail: a warning plus an
 * explicit "Add anyway" confirmation, never a silent send.
 */
export default function CaptureView() {
  const [tab, setTab] = useState<{ url: string; title: string } | null>(null);
  const [items, setItems] = useState<CaptureItem[]>([]);
  const nextId = useRef(1);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    function refreshTab() {
      void chrome.runtime
        .sendMessage({ type: "GET_ACTIVE_TAB" })
        .then((res: { ok?: boolean; tab?: { url: string; title: string } } | undefined) => {
          if (mounted.current && res?.ok && res.tab?.url) {
            setTab({ url: res.tab.url, title: res.tab.title?.trim() || res.tab.url });
          } else if (mounted.current && res && !res.ok) {
            setTab(null);
          }
        })
        .catch(() => {
          /* no active tab: the cards below show the "no page" state */
        });
    }

    refreshTab();

    const onActivated = () => refreshTab();
    const onUpdated = (_tabId: number, changeInfo: { url?: string; title?: string; status?: string }) => {
      if (changeInfo.status === "complete" || changeInfo.url || changeInfo.title) {
        refreshTab();
      }
    };

    if (typeof chrome !== "undefined" && chrome.tabs?.onActivated?.addListener) {
      chrome.tabs.onActivated.addListener(onActivated);
      chrome.tabs.onUpdated?.addListener(onUpdated);
    }
    window.addEventListener("focus", refreshTab);

    return () => {
      mounted.current = false;
      if (typeof chrome !== "undefined" && chrome.tabs?.onActivated?.removeListener) {
        chrome.tabs.onActivated.removeListener(onActivated);
        chrome.tabs.onUpdated?.removeListener(onUpdated);
      }
      window.removeEventListener("focus", refreshTab);
    };
  }, []);

  function patchItem(id: number, patch: Partial<CaptureItem>) {
    if (!mounted.current) return;
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  const sendCapture = useCallback(
    async (id: number, sourceType: SourceType, sensitiveConfirmed: boolean) => {
      try {
        const res = (await chrome.runtime.sendMessage({
          type: "CAPTURE",
          payload: { sourceType, sensitiveConfirmed },
        })) as Awaited<IngestResult> | undefined;
        if (!res) {
          patchItem(id, { state: "failed", error: "The background did not respond." });
        } else if (res.ok) {
          const { chunkCount, entityCount, edgeCount, errors } = res.report;
          patchItem(id, { state: "done", report: { chunkCount, entityCount, edgeCount, errors } });
        } else if ("needsSensitiveConfirm" in res && res.needsSensitiveConfirm) {
          // Defense in depth: the URL-only pre-check below normally catches
          // this first; the router re-checks with the URL it actually saw.
          patchItem(id, { state: "sensitive" });
        } else {
          patchItem(id, { state: "failed", error: (res as { error?: string }).error });
        }
      } catch (err) {
        patchItem(id, { state: "failed", error: errorMessage(err) });
      }
    },
    [],
  );

  function startCapture(sourceType: SourceType) {
    const title = tab?.title ?? "Untitled page";
    const id = nextId.current++;
    setItems((prev) => [{ id, sourceType, title, state: "processing" }, ...prev]);
    void sendCapture(id, sourceType, false);
  }

  function confirmCapture(item: CaptureItem) {
    patchItem(item.id, { state: "processing" });
    void sendCapture(item.id, item.sourceType, true);
  }

  return (
    <div className="space-y-4 px-4 py-4">
      {/* Current page card */}
      <Card className="gap-0 space-y-3 rounded-[10px] border-[#e7e2d8] p-4 shadow-[0_1px_2px_rgba(28,25,23,0.02)]">
        <div>
          <h1 className="text-[18px] font-medium leading-[28px] text-foreground">
            {tab ? tab.title : "No active page"}
          </h1>
          <div className="mt-1 flex items-center gap-1.5 text-[#645d58]">
            <Globe aria-hidden className="size-3.5 text-[#a8a29e]" />
            <span className="max-w-[290px] truncate text-[13px] leading-[20.8px]">
              {tab ? tab.url : "Open a page to capture it."}
            </span>
          </div>
        </div>
        <p className="text-[11px] tracking-[0.04em] text-[#a8a29e]">
          Will extract entities and relationships.
        </p>
      </Card>

      {/* Actions */}
      <section className="space-y-2.5 pt-0.5">
        <div>
          <Button
            type="button"
            onClick={() => startCapture("page")}
            disabled={!tab}
            className="h-auto w-full bg-[#4f46b8] py-2.5 hover:bg-[#433ba2]"
          >
            <Bookmark aria-hidden />
            Capture page
          </Button>
          <p className="mt-1.5 text-center text-[12px] leading-[16px] text-[#645d58]">
            Replaces the previous capture of this URL.
          </p>
        </div>

        <div className="py-1">
          <div className="h-px w-full bg-[#e7e2d8]" />
        </div>

        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => startCapture("selection")}
            disabled={!tab}
            className="h-auto w-full border-[#e7e2d8] py-2.5 hover:bg-[#f4f4f0]"
          >
            <Quote aria-hidden className="text-[#645d58]" />
            Capture selection only
          </Button>
          <p className="mt-1.5 text-center text-[12px] leading-[16px] text-[#645d58]">
            Saves just your highlighted text.
          </p>
        </div>
      </section>

      {/* Quiet note */}
      <div className="flex items-center gap-2 px-1 pb-0.5 pt-1">
        <Shield aria-hidden className="size-3.5 shrink-0 text-[#645d58]" />
        <span className="text-[12px] leading-[16px] text-[#645d58]">
          Sensitive pages (banking, email, sign-in) ask for confirmation first.
        </span>
      </div>

      <div className="h-px w-full bg-[#e7e2d8]" />

      {/* After capture — status list, component state only */}
      {items.length > 0 && (
        <section className="space-y-2 pb-2 pt-1">
          <span className="px-0.5 text-[11px] font-semibold uppercase tracking-wider text-[#a8a29e]">
            After capture
          </span>
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.id}>
                <StatusCard item={item} onConfirm={() => confirmCapture(item)} onCancel={() => setItems((prev) => prev.filter((x) => x.id !== item.id))} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function StatusCard({ item, onConfirm, onCancel }: { item: CaptureItem; onConfirm: () => void; onCancel: () => void }) {
  const header =
    item.state === "processing" ? (
      <>
        <LoaderCircle aria-hidden className="size-4 animate-spin text-[#4f46b8]" />
        Capturing…
      </>
    ) : item.state === "done" ? (
      <>
        <CheckCircle2 aria-hidden className="size-4 text-[#2e7d32]" />
        Captured
      </>
    ) : item.state === "failed" ? (
      <>
        <TriangleAlert aria-hidden className="size-4 text-destructive" />
        Failed
      </>
    ) : (
      <>
        <TriangleAlert aria-hidden className="size-4 text-[#9c6044]" />
        Sensitive page
      </>
    );

  return (
    <Card className="gap-0 overflow-hidden rounded-[10px] border-[#e7e2d8] p-0 shadow-[0_1px_2px_rgba(28,25,23,0.02)]">
      <div className="flex items-center justify-between border-b border-[#e7e2d8]/70 bg-[#f0eff9] px-3.5 py-2">
        <span className="flex items-center gap-1.5 text-[14px] font-medium text-foreground">{header}</span>
        <span className="text-[12px] text-[#645d58]">just now</span>
      </div>
      <div className="space-y-2 p-3.5">
        <div className="truncate text-[13px] font-medium text-foreground">{item.title}</div>
        {item.state === "done" && item.report && (
          <>
            <p className="text-[12px] leading-[16px] text-[#645d58]">
              1 document · {item.report.chunkCount} chunks · {item.report.entityCount} entities ·{" "}
              {item.report.edgeCount} relationships
              {item.report.errors?.length ? ` (${item.report.errors.length} schema errors)` : ""}
            </p>
          </>
        )}
        {item.state === "failed" && <p className="text-[13px] text-destructive">{item.error}</p>}
        {item.state === "sensitive" && (
          <>
            <p className="text-[13px] text-[#9c6044]">
              This page looks sensitive (banking, email, or sign-in). Capture anyway?
            </p>
            <Button type="button" variant="outline" onClick={onConfirm}>
              Add anyway
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}
