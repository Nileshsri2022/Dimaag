import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import BrowseView from "../src/sidepanel/BrowseView";

const sendMessageMock = vi.fn<(msg: unknown) => Promise<unknown>>();

beforeEach(() => {
  sendMessageMock.mockReset();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: sendMessageMock },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

const ENTITIES = [
  { id: "e1", label: "Person", name: "Ada", nameNormalized: "ada", properties: {}, evidenceChunkIds: [] },
  { id: "e2", label: "Tool", name: "Engine", nameNormalized: "engine", properties: {}, evidenceChunkIds: [] },
];

describe("BrowseView", () => {
  it("(a) list renders labels and names from stub", async () => {
    sendMessageMock.mockImplementation(async (msg: unknown) => {
      const m = msg as { type: string };
      if (m.type === "LIST_ENTITIES") return { ok: true, entities: ENTITIES };
      if (m.type === "STATS") return { ok: true, stats: { documents: 1, chunks: 2, entities: 2, edges: 0 } };
      return { ok: true };
    });
    render(<BrowseView />);
    await screen.findByText("Ada");
    expect(screen.getByText("Engine")).toBeTruthy();
    expect(screen.getAllByText("Person").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Tool").length).toBeGreaterThan(0);
  });

  it("(b) label filter narrows", async () => {
    sendMessageMock.mockImplementation(async (msg: unknown) => {
      const m = msg as { type: string };
      if (m.type === "LIST_ENTITIES") return { ok: true, entities: ENTITIES };
      if (m.type === "STATS") return { ok: true, stats: { documents: 1, chunks: 2, entities: 2, edges: 0 } };
      return { ok: true };
    });
    render(<BrowseView />);
    await screen.findByText("Ada");
    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "Tool" } });
    await waitFor(() => expect(screen.queryByText("Ada")).toBeNull());
    expect(screen.getByText("Engine")).toBeTruthy();
  });

  it("(c) detail renders chunk texts and older capture badge", async () => {
    const detail = {
      entity: { id: "e1", label: "Person", name: "Ada", nameNormalized: "ada", properties: { born: 1815 }, evidenceChunkIds: [] },
      chunks: [
        { id: "c1", documentId: "d", text: "alpha text", index: 0, superseded: false },
        { id: "c2", documentId: "d", text: "old text", index: 1, superseded: true },
      ],
    };
    sendMessageMock.mockImplementation(async (msg: unknown) => {
      const m = msg as { type: string };
      if (m.type === "LIST_ENTITIES") return { ok: true, entities: ENTITIES };
      if (m.type === "ENTITY_DETAIL") return { ok: true, detail };
      if (m.type === "STATS") return { ok: true, stats: { documents: 1, chunks: 2, entities: 2, edges: 0 } };
      return { ok: true };
    });
    render(<BrowseView />);
    fireEvent.click(await screen.findByText("Ada"));
    await screen.findByText("alpha text");
    expect(screen.getByText("old text")).toBeTruthy();
    expect(screen.getByText("older capture")).toBeTruthy();
  });

  it("(d) empty edge case (no edges rendered) asserts detail still loads", async () => {
    const detail = {
      entity: { id: "e1", label: "Person", name: "Ada", nameNormalized: "ada", properties: {}, evidenceChunkIds: [] },
      chunks: [],
    };
    sendMessageMock.mockImplementation(async (msg: unknown) => {
      const m = msg as { type: string };
      if (m.type === "LIST_ENTITIES") return { ok: true, entities: ENTITIES };
      if (m.type === "ENTITY_DETAIL") return { ok: true, detail };
      if (m.type === "STATS") return { ok: true, stats: { documents: 1, chunks: 0, entities: 1, edges: 0 } };
      return { ok: true };
    });
    render(<BrowseView />);
    fireEvent.click(await screen.findByText("Ada"));
    await screen.findByText("Ada");
  });
});
