import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Connection from "../src/options/Connection";
import DataManagement from "../src/options/DataManagement";
import type { GraphExport, GraphStore } from "../src/lib/types";

// ---------------------------------------------------------------------------
// chrome.* stubs (same style as tests/llmClient.test.ts)
// ---------------------------------------------------------------------------

const storage = new Map<string, unknown>();
const permissionMock = vi.fn<() => Promise<boolean>>();
const sendMessageMock = vi.fn<(msg: unknown) => Promise<unknown>>();

beforeEach(() => {
  storage.clear();
  permissionMock.mockReset();
  sendMessageMock.mockReset();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const wanted = Array.isArray(keys) ? keys : keys ? [keys] : [];
          const out: Record<string, unknown> = {};
          for (const key of wanted) {
            if (storage.has(key)) out[key] = storage.get(key);
          }
          return out;
        }),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) storage.set(k, v);
        }),
      },
    },
    permissions: { request: permissionMock },
    runtime: { sendMessage: sendMessageMock },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Radix dialogs (AlertDialog) need ResizeObserver + scrollIntoView in jsdom.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= ResizeObserverStub;
  (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView ??= () => {};
});

// ---------------------------------------------------------------------------
// Fake graph store for DataManagement (createLocalStore is mocked)
// ---------------------------------------------------------------------------

const EXPORT_FIXTURE: GraphExport = {
  version: 1,
  documents: [
    {
      id: "doc-1",
      url: "https://example.test/ada",
      title: "Ada Lovelace",
      sourceType: "page",
      capturedAt: 1700000000000,
    },
  ],
  chunks: [
    { id: "chunk-1", documentId: "doc-1", text: "Ada Lovelace wrote the first algorithm.", index: 0, superseded: false },
  ],
  entities: [
    {
      id: "entity-1",
      label: "Person",
      name: "Ada Lovelace",
      nameNormalized: "ada lovelace",
      properties: {},
      evidenceChunkIds: ["chunk-1"],
    },
  ],
  edges: [
    { id: "edge-1", from: "entity-1", to: "entity-1", type: "related", evidenceChunkId: "chunk-1" },
  ],
};

const fake = vi.hoisted(() => {
  return {
    store: {
      addDocument: vi.fn(),
      listEntities: vi.fn(async () => []),
      getEntityDetail: vi.fn(async () => null),
      getNeighbors: vi.fn(async () => ({ entities: [], edges: [] })),
      search: vi.fn(),
      exportAll: vi.fn(),
      importReplace: vi.fn(async () => {}),
      deleteAll: vi.fn(async () => {}),
      stats: vi.fn(),
    } satisfies GraphStore,
  };
});

vi.mock("../src/lib/localStore", () => ({
  createLocalStore: vi.fn(async () => fake.store),
}));

afterEach(() => {
  fake.store.exportAll.mockReset();
  fake.store.importReplace.mockReset();
  fake.store.deleteAll.mockReset();
});

const STATS_OK = { ok: true, stats: { documents: 12, chunks: 148, entities: 96, edges: 214 } };

// ---------------------------------------------------------------------------

function typeConnectionFields() {
  fireEvent.change(screen.getByLabelText("Base URL"), {
    target: { value: "https://api.test/v1" },
  });
  fireEvent.change(screen.getByLabelText("API Key"), {
    target: { value: "sk-test" },
  });
}

describe("Connection", () => {
  it("connect fetches models after host permission, lists them in the select, and Save persists them", async () => {
    permissionMock.mockResolvedValue(true);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<Connection />);
    typeConnectionFields();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    // The select ends up listing the fetched models.
    await screen.findByRole("option", { name: "model-a" });
    expect(screen.getByRole("option", { name: "model-b" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() =>
      expect(storage.get("llmSettings")).toEqual({
        baseUrl: "https://api.test/v1",
        apiKey: "sk-test",
        model: "model-a",
      }),
    );
  });

  it("connect asks for host permission first, and on denial shows an error and never fetches", async () => {
    permissionMock.mockResolvedValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<Connection />);
    typeConnectionFields();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(permissionMock).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/permission was not granted/i)).toBeTruthy();
  });
});

describe("DataManagement", () => {
  it("renders live stats from the STATS message", async () => {
    sendMessageMock.mockResolvedValue(STATS_OK);
    render(<DataManagement />);

    await screen.findByText("12 pages");
    expect(screen.getByText("148 text passages")).toBeTruthy();
    expect(screen.getByText("96 nodes")).toBeTruthy();
    expect(screen.getByText("214 relationships")).toBeTruthy();
  });

  it("import: picking a valid file shows the confirm dialog, and confirming calls importReplace once", async () => {
    sendMessageMock.mockResolvedValue(STATS_OK);
    const { container } = render(<DataManagement />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    const file = new File([JSON.stringify(EXPORT_FIXTURE)], "backup.json", {
      type: "application/json",
    });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);

    // The confirm copy uses the CURRENT counts from STATS.
    await screen.findByText("This deletes 12 documents, 96 entities. Replace?");

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(fake.store.importReplace).toHaveBeenCalledTimes(1));
    expect(fake.store.importReplace).toHaveBeenCalledWith(EXPORT_FIXTURE);
  });

  it("delete requires the double confirm: one confirm does not delete, the second does", async () => {
    sendMessageMock.mockResolvedValue(STATS_OK);
    render(<DataManagement />);

    fireEvent.click(screen.getByRole("button", { name: "Delete all data" }));

    // First confirmation...
    await screen.findByText("Delete all data?");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(fake.store.deleteAll).not.toHaveBeenCalled();

    // ...asks again before deleting.
    await screen.findByText("Export a backup first — delete anyway?");
    fireEvent.click(screen.getByRole("button", { name: "Delete everything" }));
    await waitFor(() => expect(fake.store.deleteAll).toHaveBeenCalledTimes(1));
  });

  it("export downloads dimaag-graph-<today>.json via an anchor with the exported graph", async () => {
    sendMessageMock.mockResolvedValue(STATS_OK);
    fake.store.exportAll.mockResolvedValue(EXPORT_FIXTURE);

    const createObjectURL = vi.fn(() => "blob:fake");
    const revokeObjectURL = vi.fn();
    (URL as unknown as Record<string, unknown>).createObjectURL = createObjectURL;
    (URL as unknown as Record<string, unknown>).revokeObjectURL = revokeObjectURL;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    try {
      render(<DataManagement />);
      fireEvent.click(screen.getByRole("button", { name: /Export backup \(JSON\)/ }));

      await waitFor(() => expect(clickSpy).toHaveBeenCalled());
      expect(fake.store.exportAll).toHaveBeenCalledTimes(1);
      const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement;
      expect(anchor.download).toMatch(/^dimaag-graph-\d{4}-\d{2}-\d{2}\.json$/);
      expect(anchor.href).toContain("blob:fake");
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
    } finally {
      delete (URL as unknown as Record<string, unknown>).createObjectURL;
      delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
      clickSpy.mockRestore();
    }
  });
});

afterAll(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});
