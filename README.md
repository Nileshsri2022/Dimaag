# Dimaag v1 — Personal Knowledge Graph (Chrome extension)

A personal, local-only knowledge-graph Chrome extension (Manifest V3). Captures web pages and selections, extracts entities/relationships via a user-configured OpenAI-compatible LLM, stores the graph in IndexedDB, and answers chat questions with chunk-level source citations. No accounts, no backend server, no hosting.

## Load unpacked (development)

1. Build the bundle: `npm install && npm run build` (output in `dist/`).
2. Open Chrome → `chrome://extensions`.
3. Toggle "Developer mode" on (top-right).
4. Click "Load unpacked" and select the `dist/` folder.
5. The Dimaag icon appears in the toolbar; clicking it opens the side panel (Capture / Chat / Browse).

Manifest notes:
- `optional_host_permissions` (not `host_permissions`) — the user grants per-endpoint host access on Connect.
- `unlimitedStorage` is requested; graph data lives in IndexedDB.

## Connect an LLM

1. Open the Options tab (click the Dimaag icon → settings gear, or open the options page).
2. Enter a Base URL (any OpenAI-compatible endpoint, e.g. `https://api.openai.com/v1`).
3. Enter your API key (stored locally in `chrome.storage.local`; sent only to the endpoint you enter).
4. Click **Connect** — grants host permission, then fetches `/v1/models` and populates the Model dropdown.
5. Pick a model (used for extraction and chat) and click **Save connection**.
6. The status row shows "Connected" with a green dot.

## Capture a page

1. Open any documentation page in a tab.
2. Open the side panel (Capture tab is the default).
3. The "Current page" card shows the title, host, character count, and a text preview.
4. Click **Capture page** (replaces any previous capture of that URL) or **Capture selection only** (saves just your highlighted text).
5. Per-capture status appears: `processing → done <N> chunks, <N> entities, <N> edges` (or `failed <reason>`).
6. Sensitive pages (banking, email, sign-in) show a warning + "Add anyway" — one-tap confirm, never a hard block.

## Ask a question

1. Switch to the Chat tab.
2. Type a question and press Enter (Shift+Enter for a newline).
3. The answer cites `[Cn]` sources; expand "Sources" on an assistant message to read the supporting chunk text.
4. Questions outside the graph get "Not in the graph."

## Browse the graph

1. Switch to the Browse tab.
2. Search entities/pages; filter by label (All / Person / Tool / Concept / …).
3. Tap an entity chip to see its properties, evidence chunk texts ("older capture" badge on superseded chunks), and typed relationships (`type → other entity`).
4. Tap a relationship row to navigate to the other entity.

## Backup / restore

- Options → **Export backup (JSON)** downloads `dimaag-graph-YYYY-MM-DD.json`.
- Options → drop a `.json` backup into the import zone → confirm "This deletes X documents, Y entities. Replace?" → replaces everything.
- Options → **Delete all data** requires two confirmations.

## Verification checklist (Task 17)

1. [ ] Build and load unpacked in Chrome; verify the manifest has no required host permissions (`optional_host_permissions` only).
2. [ ] Connect a real OpenAI-compatible endpoint; model dropdown populates; select a model.
3. [ ] Capture two related documentation pages; both show per-document reports (`done N chunks, N entities, N edges`).
4. [ ] Ask one multi-hop question spanning both pages; answer cites `[Cn]` sources which resolve to real chunk text; ask something absent from the graph → answer contains `Not in the graph`.
5. [ ] Re-capture one of the pages; confirm old chunks are marked `superseded: true` and still resolve (Browse → "older capture" badge).

## Tests

`npm test` runs the Vitest suite (141 tests across 15 files, jsdom environment). `npx tsc --noEmit` checks types.
