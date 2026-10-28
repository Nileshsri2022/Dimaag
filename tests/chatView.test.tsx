import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatView from "../src/sidepanel/ChatView";

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

describe("ChatView", () => {
  it("asking renders the user bubble and the assistant answer", async () => {
    sendMessageMock.mockResolvedValue({ ok: true, answer: "Hello answer", citations: {} });
    render(<ChatView />);
    const textarea = screen.getByPlaceholderText("Ask your graph…");
    fireEvent.change(textarea, { target: { value: "Hi there" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText("Hi there");
    await screen.findByText("Hello answer");
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: "ASK",
      payload: { question: "Hi there", history: [] },
    });
  });

  it("citations render as an expandable list showing chunk text", async () => {
    sendMessageMock.mockResolvedValue({
      ok: true,
      answer: "Answer with sources",
      citations: { 0: { chunkId: "c1", text: "chunk one text" } },
    });
    render(<ChatView />);
    const textarea = screen.getByPlaceholderText("Ask your graph…");
    fireEvent.change(textarea, { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText("Answer with sources");
    expect(screen.getByText(/\[C1\] chunk one text/)).toBeTruthy();
  });

  it("second ask sends the accumulated history", async () => {
    sendMessageMock
      .mockResolvedValueOnce({ ok: true, answer: "first answer", citations: {} })
      .mockResolvedValueOnce({ ok: true, answer: "second answer", citations: {} });

    render(<ChatView />);
    const textarea = screen.getByPlaceholderText("Ask your graph…");

    fireEvent.change(textarea, { target: { value: "first question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("first answer");

    fireEvent.change(textarea, { target: { value: "second question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("second answer");

    expect(sendMessageMock).toHaveBeenLastCalledWith({
      type: "ASK",
      payload: {
        question: "second question",
        history: [
          { role: "user", content: "first question" },
          { role: "assistant", content: "first answer" },
        ],
      },
    });
  });
});
