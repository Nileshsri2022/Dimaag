import { useCallback, useEffect, useRef, useState } from "react";
import { Download, UploadCloud } from "lucide-react";
import { graphExportToBlobUrl, parseGraphExport } from "../lib/exportImport";
import { createLocalStore } from "../lib/localStore";
import type { GraphExport, GraphStore } from "../lib/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

type Stats = { documents: number; chunks: number; entities: number; edges: number };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * "Data Management" section (Part 3 of the approved Options design).
 *
 * Stats come from the background router via `chrome.runtime.sendMessage
 * ({type:"STATS"})` — the same numbers feed the confirm-dialog copy, so no
 * fake numbers are ever shown. Export/import/delete use the shared IndexedDB
 * store directly (the router only exposes STATS for read-only counters in
 * this task). Every failure surfaces as text in the UI.
 */
export default function DataManagement() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingImport, setPendingImport] = useState<GraphExport | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDeleteFinal, setConfirmDeleteFinal] = useState(false);

  const storePromise = useRef<Promise<GraphStore> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const getStore = useCallback((): Promise<GraphStore> => {
    storePromise.current ??= createLocalStore();
    return storePromise.current;
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const res = (await chrome.runtime.sendMessage({ type: "STATS" })) as
        | { ok: true; stats: Stats }
        | { ok: false; error: string };
      if (!mounted.current) return;
      if (!res || !res.ok) {
        setStats(null);
        setStatsError(res && "error" in res ? res.error : "Could not load graph stats.");
        return;
      }
      setStats(res.stats);
      setStatsError(null);
    } catch (err) {
      if (mounted.current) setStatsError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  async function handleExport() {
    setError(null);
    setBusy(true);
    try {
      const store = await getStore();
      const data = await store.exportAll();
      const url = graphExportToBlobUrl(data);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `dimaag-graph-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleFileChosen(file: File) {
    setError(null);
    try {
      const parsed = parseGraphExport(await file.text());
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      setPendingImport(parsed.data);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleImportConfirmed() {
    if (!pendingImport) return;
    setError(null);
    setBusy(true);
    try {
      const store = await getStore();
      await store.importReplace(pendingImport);
      setPendingImport(null);
      await loadStats();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteConfirmed() {
    setError(null);
    setBusy(true);
    try {
      const store = await getStore();
      await store.deleteAll();
      setConfirmDelete(false);
      setConfirmDeleteFinal(false);
      await loadStats();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="mb-6">
        <h2 className="text-[22px] font-medium leading-8 tracking-[-0.01em]">Data Management</h2>
        <p className="mt-1 text-[13px] leading-[20.8px] text-secondary">
          Your graph lives in local IndexedDB storage.
        </p>
      </div>

      {/* 4 stat cards in one row */}
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Documents" value={stats ? `${stats.documents} pages` : "—"} />
        <StatCard label="Chunks" value={stats ? `${stats.chunks} text passages` : "—"} />
        <StatCard label="Entities" value={stats ? `${stats.entities} nodes` : "—"} />
        <StatCard label="Edges" value={stats ? `${stats.edges} relationships` : "—"} />
      </div>

      {statsError && (
        <p role="alert" className="mb-6 text-[13px] leading-[20.8px] text-secondary">
          {statsError}
        </p>
      )}

      {/* Action row: Export */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => void handleExport()}
          disabled={busy}
        >
          <Download aria-hidden />
          Export backup (JSON)
        </Button>
        <span className="text-[11px] tracking-[0.04em] text-secondary">
          Downloads the full graph as a JSON file.
        </span>
      </div>

      {/* Import drop zone */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files?.[0];
          if (file) void handleFileChosen(file);
        }}
        className="group cursor-pointer rounded-xl border border-dashed border-[#d6cfc4] bg-background p-6 text-center transition-colors hover:border-ring"
      >
        <div className="mb-2 flex justify-center text-secondary group-hover:text-primary">
          <UploadCloud aria-hidden className="size-[26px]" />
        </div>
        <div className="text-[14px] font-medium text-foreground">
          Drop a .json backup here or browse
        </div>
        <div className="mt-2">
          <span className="inline-block rounded border border-amber-200/60 bg-amber-50/80 px-2.5 py-1 text-[11px] tracking-[0.04em] text-amber-800">
            Importing replaces ALL existing data after you confirm.
          </span>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFileChosen(file);
            e.target.value = "";
          }}
        />
      </div>

      {/* Danger zone */}
      <div className="mt-6 flex flex-col justify-between gap-4 rounded-xl border border-rose-200/80 bg-rose-50/50 p-5 sm:flex-row sm:items-center">
        <div>
          <h3 className="text-[14px] font-medium text-rose-900">Danger zone</h3>
          <p className="mt-0.5 text-[11px] tracking-[0.04em] text-rose-700">
            Erases the local graph permanently. Export a backup first.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => setConfirmDelete(true)}
          disabled={busy}
          className="shrink-0 self-start border-rose-300 text-rose-700 hover:bg-rose-100/60 hover:text-rose-700 sm:self-auto"
        >
          Delete all data
        </Button>
      </div>

      {/* Import confirm: exact copy required by the plan. */}
      <AlertDialog
        open={pendingImport !== null}
        onOpenChange={(open) => {
          if (!open) setPendingImport(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace current graph?</AlertDialogTitle>
            {stats ? (
              <AlertDialogDescription>
                {`This deletes ${stats.documents} documents, ${stats.entities} entities. Replace?`}
              </AlertDialogDescription>
            ) : (
              <AlertDialogDescription>
                {statsError
                  ? `Current counts are unavailable: ${statsError}`
                  : "Current counts are unavailable."}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!stats || busy}
              onClick={() => void handleImportConfirmed()}
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmations (two sequential steps). */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all data?</AlertDialogTitle>
            <AlertDialogDescription>
              Erases the local graph permanently. Export a backup first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmDelete(false);
                setConfirmDeleteFinal(true);
              }}
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDeleteFinal} onOpenChange={setConfirmDeleteFinal}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Export a backup first — delete anyway?</AlertDialogTitle>
            <AlertDialogDescription>
              This erases every document, chunk, entity, and edge from local storage. It cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void handleDeleteConfirmed()}>
              Delete everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="gap-1 rounded-xl p-4">
      <span className="block text-[11px] uppercase tracking-wider text-secondary">{label}</span>
      <div className="mt-1 text-[18px] font-medium leading-7">{value}</div>
    </Card>
  );
}
