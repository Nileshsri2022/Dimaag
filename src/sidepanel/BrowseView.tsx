import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import type { Entity, Chunk } from "../lib/types";
import { errorMessage } from "../lib/errorMessage";

interface Detail { entity: Entity; chunks: Chunk[] }

export default function BrowseView() {
  const [view, setView] = useState<"list" | "detail">("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [query, setQuery] = useState("");
  const [label, setLabel] = useState("All");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ documents: number; chunks: number; entities: number; edges: number } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = (await chrome.runtime.sendMessage({ type: "LIST_ENTITIES" })) as { ok: boolean; entities?: Entity[]; error?: string };
        if (!res || !res.ok) { setError(res?.error ?? "Request failed"); return; }
        setEntities(res.entities ?? []);
      } catch (e) { setError(errorMessage(e)); }
    })();
    void (async () => {
      try {
        const res = (await chrome.runtime.sendMessage({ type: "STATS" })) as { ok: boolean; stats?: typeof stats };
        if (res && res.ok) setStats(res.stats ?? null);
      } catch { /* ignore */ }
    })();
  }, []);

  useEffect(() => {
    if (view !== "detail" || !selectedId) return;
    void (async () => {
      setDetail(null);
      setNotFound(false);
      try {
        const res = (await chrome.runtime.sendMessage({ type: "ENTITY_DETAIL", payload: { id: selectedId } })) as { ok: boolean; detail?: Detail | null; error?: string };
        if (!res || !res.ok) { setError(res?.error ?? "Request failed"); return; }
        if (!res.detail) { setNotFound(true); return; }
        setDetail(res.detail);
      } catch (e) { setError(errorMessage(e)); }
    })();
  }, [view, selectedId]);

  const labels = useMemo(() => {
    const set = new Set(entities.map((e) => e.label));
    return ["All", ...Array.from(set).sort()];
  }, [entities]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entities.filter((e) => {
      if (label !== "All" && e.label !== label) return false;
      if (q && !e.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entities, query, label]);

  if (view === "detail") {
    if (notFound) {
      return (
        <div className="p-4">
          <button type="button" onClick={() => setView("list")} className="flex items-center gap-1 text-sm text-primary">
            <ArrowLeft className="size-4" /> Back
          </button>
          <p className="mt-4 text-sm text-[#a8a29e]">Entity not found.</p>
        </div>
      );
    }
    if (!detail) {
      return <div className="p-4 text-sm text-[#a8a29e]">Loading…</div>;
    }
    const { entity, chunks } = detail;
    return (
      <div className="p-4 space-y-3">
        <button type="button" onClick={() => setView("list")} className="flex items-center gap-1 text-sm text-primary">
          <ArrowLeft className="size-4" /> Back
        </button>
        <h2 className="text-lg font-medium">{entity.name}</h2>
        <p className="text-xs text-[#645d58]">{entity.label}</p>
        <div className="space-y-1">
          {Object.entries(entity.properties).map(([k, v]) => (
            <div key={k} className="text-sm"><span className="text-[#645d58]">{k}:</span> {String(v)}</div>
          ))}
        </div>
        <div className="space-y-2">
          {chunks.map((c) => (
            <div key={c.id} className="rounded-[10px] border border-[#e7e2d8] bg-white p-3 text-sm">
              {c.superseded && <span className="mb-1 inline-block rounded-[6px] bg-[#f4f4f0] px-1.5 py-0.5 text-[10px] text-[#645d58]">older capture</span>}
              <p>{c.text}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 items-center gap-2 rounded-[6px] border border-[#e7e2d8] bg-white px-2 py-1.5">
          <Search className="size-4 text-[#a8a29e]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search entities…"
            className="flex-1 bg-transparent text-sm outline-none"
          />
        </div>
        <select value={label} onChange={(e) => setLabel(e.target.value)} className="rounded-[6px] border border-[#e7e2d8] bg-white px-2 py-1.5 text-sm">
          {labels.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>
      {error && <p className="text-sm text-[#645d58]">{error}</p>}
      {entities.length === 0 ? (
        <p className="text-sm text-[#a8a29e]">No entities yet. Capture a page to get started.</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-[#a8a29e]">No matches.</p>
      ) : (
        <ul className="divide-y divide-[#e7e2d8]">
          {filtered.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => { setSelectedId(e.id); setView("detail"); }}
                className="flex w-full items-center justify-between py-2 text-left"
              >
                <span className="text-sm">{e.name}</span>
                <span className="text-xs text-[#645d58]">{e.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <footer className="mt-4 text-[11px] text-[#a8a29e]">
        {stats
          ? `${stats.documents} documents · ${stats.chunks} chunks · ${stats.entities} entities · ${stats.edges} edges`
          : "— · — · — · —"}
      </footer>
    </div>
  );
}