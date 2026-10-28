import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import CaptureView from "../src/sidepanel/CaptureView";

// ---------------------------------------------------------------------------
// chrome.* stubs (same style as tests/options.test.tsx)
// ---------------------------------------------------------------------------

const tabsQueryMock = vi.fn<(query: unknown) => Promise<unknown>>();
const sendMessageMock = vi.fn<(msg: unknown) => Promise<unknown>>();

const NORMAL_TAB = { id: 7, url: "https://en.wikipedia.org/wiki/Knowledge_graph", title: "Knowledge graph" };
const SENSITIVE_TAB = { id: 7, url: "https://www.bankofindia.co.in/login", title: "Sign in" };

const REPORT_OK = {
  ok: true,
  report: { documentId: "doc-1", chunkCount: 12, entityCount: 34, edgeCount: 18, errors: [] },
};

beforeEach(() => {
  tabsQueryMock.mockReset();
  sendMessageMock.mockReset();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: { query: tabsQueryMock },
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
    tabsQueryMock.mockResolvedValue([NORMAL_TAB]);
    render(<CaptureView />);

    await screen.findByText("Knowledge graph");
    expect(screen.getByText(/en\.wikipedia\.org/)).toBeTruthy();
    expect(tabsQueryMock).toHaveBeenCalledWith({ active: true, currentWindow: true });
  });

  it("clicking capture: message first, processing status, then the done report", async () => {
    tabsQueryMock.mockResolvedValue([NORMAL_TAB]);
    let resolveSend!: (value: unknown) => void;
    sendMessageMock.mockImplementation(
      () => new Promise((resolve) => (resolveSend = resolve)),
    );

    render(<CaptureView />);
    await screen.findByText("Knowledge graph");
    fireEvent.click(screen.getByRole("button", { name: "Capture page" }));

    // The request leaves with no confirmation flag...
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: "CAPTURE",
      payload: { sourceType: "page", sensitiveConfirmed: false },
    });
    // ...and the capture is visibly in progress while it runs.
    expect(await screen.findByText("Capturing…")).toBeTruthy();

    resolveSend(REPORT_OK);
    await screen.findByText("Captured");
    expect(screen.getByText("1 document · 12 chunks · 34 entities · 18 relationships")).toBeTruthy();
  });

  it("a failed capture surfaces the router's error text", async () => {
    tabsQueryMock.mockResolvedValue([NORMAL_TAB]);
    sendMessageMock.mockResolvedValue({ ok: false, error: "LLM not connected" });

    render(<CaptureView />);
    await screen.findByText("Knowledge graph");
    fireEvent.click(screen.getByRole("button", { name: "Capture page" }));

    await screen.findByText("Failed");
    expect(screen.getByText("LLM not connected")).toBeTruthy();
  });

  it("sensitive URL: clicking capture shows the warning and sends nothing yet", async () => {
    tabsQueryMock.mockResolvedValue([SENSITIVE_TAB]);
    render(<CaptureView />);
    await screen.findByText("Sign in");

    fireEvent.click(screen.getByRole("button", { name: "Capture page" }));

    expect(await screen.findByText("This page looks sensitive (banking, email, or sign-in). Capture anyway?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add anyway" })).toBeTruthy();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("'Add anyway' on a sensitive page resends with sensitiveConfirmed: true", async () => {
    tabsQueryMock.mockResolvedValue([SENSITIVE_TAB]);
    sendMessageMock.mockResolvedValue(REPORT_OK);

    render(<CaptureView />);
    await screen.findByText("Sign in");
    fireEvent.click(screen.getByRole("button", { name: "Capture page" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add anyway" }));

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: "CAPTURE",
      payload: { sourceType: "page", sensitiveConfirmed: true },
    });
    await screen.findByText("Captured");
    expect(screen.getByText("1 document · 12 chunks · 34 entities · 18 relationships")).toBeTruthy();
  });

  it("selection capture sends sourceType 'selection'", async () => {
    tabsQueryMock.mockResolvedValue([NORMAL_TAB]);
    sendMessageMock.mockResolvedValue(REPORT_OK);

    render(<CaptureView />);
    await screen.findByText("Knowledge graph");
    fireEvent.click(screen.getByRole("button", { name: "Capture selection only" }));

    await waitFor(() =>
      expect(sendMessageMock).toHaveBeenCalledWith({
        type: "CAPTURE",
        payload: { sourceType: "selection", sensitiveConfirmed: false },
      }),
    );
    await screen.findByText("Captured");
  });

  it("a needsSensitiveConfirm router response also enters the warning state", async () => {
    tabsQueryMock.mockResolvedValue([NORMAL_TAB]);
    sendMessageMock.mockResolvedValueOnce({ ok: false, needsSensitiveConfirm: true }).mockResolvedValueOnce(REPORT_OK);

    render(<CaptureView />);
    await screen.findByText("Knowledge graph");
    fireEvent.click(screen.getByRole("button", { name: "Capture page" }));

    const warning = await screen.findByText("This page looks sensitive (banking, email, or sign-in). Capture anyway?");
    expect(warning).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add anyway" }));
    expect(sendMessageMock).toHaveBeenLastCalledWith({
      type: "CAPTURE",
      payload: { sourceType: "page", sensitiveConfirmed: true },
    });
    await screen.findByText("Captured");
  });
});
