import Connection from "./Connection";
import DataManagement from "./DataManagement";

/**
 * Options page (full-width browser tab): page header, "LLM Connection"
 * section, "Data Management" section — Parts 1–3 of the approved Options
 * design, with the design's copy kept verbatim.
 */
export default function App() {
  return (
    <main className="min-h-screen bg-background font-sans text-foreground antialiased">
      <div className="mx-auto max-w-[880px] px-6 py-10">
        {/* PART 1: Page Header */}
        <section className="space-y-1">
          <h1 className="text-[28px] font-semibold leading-10 tracking-[-0.015em]">Dimaag</h1>
          <p className="text-[17px] leading-[27.2px] text-secondary">Personal knowledge graph</p>
          <p className="pt-1 text-[13px] leading-[20.8px] text-[#6a635e]">
            Capture pages, extract entities, ask questions. Everything stays in your browser.
          </p>
        </section>

        <div className="my-8 border-t" />

        <Connection />

        <div className="my-8 border-t" />

        <DataManagement />

        {/* Page footer note */}
        <footer className="mb-6 mt-12 text-center text-[11px] tracking-[0.04em] text-[#a8a29e]">
          All data stays in your browser. No accounts, no backend.
        </footer>
      </div>
    </main>
  );
}
