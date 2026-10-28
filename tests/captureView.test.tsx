import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import CaptureView from "../src/sidepanel/CaptureView";

// ---------------------------------------------------------------------------
// chrome.* stubs (same style as tests/options.test.tsx)
// ---------------------------------------------------------------------------

const sendMessageMock = vi.fn<(msg: unknown) => Promise<unknown>>();

const NORMAL_TAB = { id: 7, url: "https://en.wikipedia.org/wiki/Knowledge_graph", title: "Knowledge graph" };
const SENSITIVE_TAB = { id: 7, url: "https://www.bankofindia.co.in/login", title: "Sign in" };

const REPORT_OK = {
  ok: true,
  report: { documentId: "doc-1", chunkCount: 12, entityCount: 34, edgeCount: 18, errors: [] },
};

// Active tab returned for GET_ACTIVE_TAB; per-test override via setActiveTab.
let activeTab: { id: number; url: string; title: string } = NORMAL_TAB;
// Capture response returned for CAPTURE; per-test override via setCaptureResponse.
let captureResponse: unknown = REPORT_OK;

beforeEach(() => {
  sendMessageMock.mockReset();
  activeTab = NORMAL_TAB;
  captureResponse = REPORT_OK;
  sendMessageMock.mockImplementation(async (msg: unknown) => {
    const m = msg as { type?: string };
    if (m?.type === "GET_ACTIVE_TAB") {
      return { ok: true, tab: { url: activeTab.url, title: activeTab.title } };
    }
    return captureResponse;
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: sendMessageMock },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe("CaptureView", () => {
  it("shows the active tab's title and URL on mount", async () => {
    render(<CaptureView />);

    await screen.findByText("Knowledge graph");
    expect(screen.getByText(/en\.wikipedia\.org/)).toBeTruthy();
    expect(sendMessageMock).toHaveBeenCalledWith({ type: "GET_ACTIVE_TAB" });
  });

  it("clicking capture: message first, processing status, then the done report", async () => {
    render(<CaptureView />);
    await screen.findByText("Knowledge graph");

    fireEvent.click(screen.getByRole("button", { name: "Capture page" }));

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: "CAPTURE",
      payload: { sourceType: "page", sensitiveConfirmed: false },
    });
    expect(await screen.findByText("Captured")).toBeTruthy();
    expect(screen.getByText(/1 document · 12 chunks · 34 entities · 18 relationships/i)).toBeTruthy();
  });

  it("failure surfaces the error text and state is failed", async () => {
    captureResponse = { ok: false, error: "LLM not connected" };
    render(<CaptureView />);
    await screen.findByText("Knowledge graph");

    fireEvent.click(screen.getByRole("button", { name: "Capture page" }));

    expect(await screen.findByText("LLM not connected")).toBeTruthy();
  });

  it("sensitive URL: clicking capture shows the warning after router response", async () => {
    activeTab = SENSITIVE_TAB;
    captureResponse = { ok: false, needsSensitiveConfirm: true };
    render(<CaptureView />);
    await screen.findByText("Sign in");

    fireEvent.click(screen.getByRole("button", { name: "Capture page" }));

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: "CAPTURE",
      payload: { sourceType: "page", sensitiveConfirmed: false },
    });
    expect(await screen.findByText("This page looks sensitive (banking, email, or sign-in). Capture anyway?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add anyway" })).toBeTruthy();
  });

  it("'Add anyway' on a sensitive page resends with sensitiveConfirmed: true", async () => {
    activeTab = SENSITIVE_TAB;
    captureResponse = { ok: false, needsSensitiveConfirm: true };
    // First capture returns sensitive; "Add anyway" returns the report.
    let callCount = 0;
    sendMessageMock.mockImplementation(async (msg: unknown) => {
      const m = msg as { type?: string };
      if (m?.type === "GET_ACTIVE_TAB") {
        return { ok: true, tab: { url: activeTab.url, title: activeTab.title } };
      }
      callCount++;
      if (callCount === 1) return { ok: false, needsSensitiveConfirm: true };
      return REPORT_OK;
    });

    render(<CaptureView />);
    await screen.findByText("Sign in");
    fireEvent.click(screen.getByRole("button", { name: "Capture page" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add anyway" }));

    expect(sendMessageMock).toHaveBeenCalledTimes(3); // GET_ACTIVE_TAB + 2 CAPTURE
    expect(sendMessageMock).toHaveBeenLastCalledWith({
      type: "CAPTURE",
      payload: { sourceType: "page", sensitiveConfirmed: true },
    });
    expect(await screen.findByText(/1 document · 12 chunks · 34 entities · 18 relationships/i)).toBeTruthy();
  });

  it("Capture selection only sends sourceType selection", async () => {
    render(<CaptureView />);
    await screen.findByText("Knowledge graph");

    fireEvent.click(screen.getByRole("button", { name: "Capture selection only" }));

    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith({
        type: "CAPTURE",
        payload: { sourceType: "selection", sensitiveConfirmed: false },
      });
    });
  });
});
