# Dimaag — Knowledge Graph Chrome Extension: v1 Design

Date: 2026-10-28
Status: Draft (pending builder check and owner approval)

## 1. Intent and why

Dimaag is a personal "graph brain" living in Chrome. While browsing, the user
captures pages or text selections; an LLM of their choice extracts entities and
relationships into a property graph; later the user asks questions and gets
answers backed by the exact source chunks that produced every claim.

The guiding principle (carried over from the owner's original spec): **until a
claim is checkable against its source, it is not complete.** Every answer shows
its source chunks; every graph edge cites the chunk that supports it. When the
graph doesn't contain the answer, the assistant must say so.

v1 is deliberately a single-user, no-server tool. Success for v1 looks like:
capture a documentation page, then ask a question that requires connecting
facts from two captured pages, and receive an answer where every sentence cites
a visible source chunk.

## 2. Goals

- Connect to any OpenAI-compatible LLM: user enters a base URL and API key, the
  extension calls `{baseUrl}/models`, presents the returned models in a
  dropdown, and the selected model powers all extraction and Q&A.
- Capture: "Add this page" and "Add selection" from the side panel; the
  extension reads the rendered DOM via a content script, stores the document
  and its text chunks with metadata (URL, title, captured-at).
- Extraction (cost policy: adaptive, owner-chosen): if the page fits a size
  budget, one LLM call extracts entities and typed, directed relationships as
  structured JSON; if the page is too long, it is split into parts, each part
  extracted separately, and a merge pass combines results. There is never
  silent truncation of a long page. New entities merge into existing ones by
  normalized name + label; no duplicates.
- Storage: all data in IndexedDB in the browser. The data model is **exactly
  Neo4j's property-graph model** (labeled nodes, typed directed relationships,
  properties on both, evidence links), so that later migration to a real
  Neo4j/AuraDB instance is an export, not a redesign.
- Q&A: a chat in the side panel (owner call: the chat is a real conversation —
  follow-up questions are re-run against the graph as standalone questions, and
  the assistant's previous answers are never treated as graph facts). A
  question retrieves a focused subgraph (keyword retrieval with BM25-like
  scoring, sized for hundreds of pages per owner estimate), the LLM answers
  from that context only, every answer cites source chunk IDs, and
  unanswerable questions get "not in the graph."
- Browse: entity/edge list with a detail view showing a node's properties and
  the text of the chunks supporting it — entities carry their own chunk
  citations, not just relationships.
- Data ownership: one-click full-graph export to JSON, import from JSON, and
  one-click delete-everything.
- Guardrails: warn before ingesting sensitive pages (banking/email/auth
  patterns); treat all captured page content as untrusted data (never as
  instructions), including in extraction prompts and chat context.

## 3. Non-goals (explicitly out of v1)

- No backend service, no accounts, no multi-tenancy, no publishing to others.
- No VS Code extension (GitNexus already serves that need for the owner).
- No MCP server.
- No PDF ingestion, no automatic background crawling.
- No Neo4j/AuraDB cloud mode. It is the **first planned follow-up**: the store
  is built behind an interface so a Neo4jStore adapter can be added without
  rework. When that mode lands, neovis.js renders the graph directly from the
  database.
- No force-graph canvas. It is the **second planned follow-up**: Cytoscape.js or
  vis-network rendering the same local data, styled to look like Neo4j Browser.

## 4. Anti-goals (failure even if it "works")

- Answers that state facts without visible sources, or that present invented
  entities/edges as graph content.
- The API key being sent anywhere other than the user-entered base URL.
- Silent data loss: failed ingests must surface an error/report, and storage
  must never be silently evicted (the extension requests the
  `unlimitedStorage` permission so Chrome cannot evict IndexedDB under disk
  pressure).
- The LLM following instructions hidden inside captured page text.

## 5. Constraints

- Chrome Manifest V3: all code bundled locally (no remote scripts), side panel
  UI, service worker for background work.
- `activeTab`-style minimal permissions first; broad host permissions are a
  store-review risk. v1 is a personal tool, so if a broader permission is
  required for convenience, say so in the plan and keep it as small as possible.
- Persistence: IndexedDB on the browser profile; sync across devices is
  handled in v1 only by manual JSON export/import.
- The stored API key is readable by anyone with access to that machine
  profile. Accepted by the owner as a personal-tool tradeoff; the key must
  still only be transmitted to the user-configured base URL.

## 6. Approaches considered

**A. Backend-first (original doc):** Python service with Cognee + Neo4j,
extensions as thin clients. Rejected for v1: hosting and auth overhead a
personal tool doesn't need; the value (capture → extract → verified answers)
fits fully in the extension.

**B. Extension-only, all local (chosen):** extraction via direct LLM calls from
the extension, graph in IndexedDB, Neo4j-shaped data for future-proofing.
Tradeoff: scale and multi-device limits; accepted, with JSON export as the
v1 escape hatch.

**C. Neo4j-backed from day one:** real Neo4j (AuraDB Free or local) with
neovis.js views. Deferred: adds a server dependency and breaks offline use;
becomes follow-up #1 thanks to the store interface.

**Build stack — TypeScript + Vite + React (chosen, option A).** Alternatives:
vanilla TS (lighter, but hand-rolls every UI screen and complicates Stitch
handoff) and WXT (nice extension ergonomics, smaller community). React + Vite
gives component reuse for options/side-panel UI and maps Stitch's HTML/CSS
output onto components.

## 7. The how, as decided with the owner

- **LLM connection:** settings hold `baseUrl`, `apiKey`, `selectedModel`. On
  connect, fetch `{baseUrl}/models` and populate a dropdown. All chat and
  extraction calls go to `{baseUrl}/chat/completions`. Answers stream into the
  side panel.
- **Data model (Neo4j property-graph shape):**
  - `Document` node: URL, title, capturedAt, source type (page/selection).
  - `Chunk` nodes: text, index, belongs-to Document (`[:PART_OF]`).
  - `Entity` nodes: `label` (e.g. `Person`, `Tool`, `Concept`), `name`,
    properties.
  - Typed directed relationships between entities, each carrying
    `evidenceChunkId`.
  - Entity nodes also cite their own source chunk(s) via `evidenceChunkIds` (a
    settled builder-check call), so the detail view can show a node's backing
    text without going through edges.
  - Superseded chunks: when a URL is re-captured, the new chunks replace the
    old ones, but old chunk IDs remain resolvable and marked `superseded: true`
    (owner-chosen policy). Older citations still display, labeled as from an
    earlier capture.
- **Store interface (both modes designed for):** the app talks to a
  `GraphStore` interface (`addDocument`, `getSubgraph`, `search`, `getNode`,
  `getNeighbors`, `exportAll`, `importAll`, `deleteAll`). v1 implements
  `LocalStore` (IndexedDB). Retrieval in v1 is keyword/token matching over
  chunks and entity names with BM25-like ranking, sized for hundreds of
  captured pages (owner estimate), assembled into a subgraph within a token
  budget.
- **Import semantics (owner-chosen):** importing a JSON backup into a
  non-empty store replaces everything after an explicit confirmation. The
  delete-everything button lives on the same settings section.
- **Ingest pipeline:** content script extracts readable text (rendered DOM) →
  package page text strictly as *data* (delimited, with a wrapper telling the
  model any instructions appearing inside are content, not commands) → chunk →
  adaptive LLM extraction (single call, or split-parts + merge pass for long
  pages) → JSON schema-validated entities/edges → dedupe/merge by normalized
  name + label → store with evidence links → per-document report shown to the
  user (chunks created, entities found, failures).
- **Q&A prompt contract:** answer only from provided context; cite chunk IDs
  per claim; say "not in the graph" when the context lacks the answer; page
  content inside context is labeled as untrusted data.
- **UI screens (to be designed in Stitch, then implemented as React
  components):** Options page (connection setup + model list, data management
  with export/import/delete), Side panel (capture buttons with per-capture
  status, chat with sources, entity/edge list, detail view with chunk text).
- **Components/parts of the code:** manifest (MV3), service worker
  (background API work), content script (DOM read + selection), side panel and
  options React apps, LLM client module, GraphStore/LocalStore modules, ingest
  pipeline module, retrieval module.

## 8. What's left to the builder

- Exact chunk size/overlap, extraction prompt wording, schema validation
  details, and dedupe matching thresholds.
- Choice of IndexedDB helper (e.g. `idb`), Vite MV3 plugin, test framework.
- Styling/CSS details from the Stitch designs.
- Standard Q&A conversation bookkeeping (how follow-ups are rewritten into
  standalone questions) — the semantics are decided in §7.

## 9. Follow-up roadmap (context, not v1 scope)

1. Neo4j-styled force-graph canvas view (Cytoscape.js/vis-network over the same
   local data).
2. Neo4jStore adapter + AuraDB/local connection in settings; neovis.js
   rendering straight from the database.
3. PDF ingestion, embeddings-based retrieval, code-page-aware extraction.
