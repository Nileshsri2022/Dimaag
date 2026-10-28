import { useState } from "react";
import { BookOpen, Send } from "lucide-react";
import type { ChatMessage } from "../lib/prompts";

interface Citation {
  chunkId: string;
  text: string;
}

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Record<number, Citation>;
  loading?: boolean;
  error?: string;
}

let nextId = 1;

export default function ChatView() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function send() {
    const question = input.trim();
    if (!question || loading) return;
    const userMsg: ChatMsg = { id: `m${nextId++}`, role: "user", content: question };
    const assistantMsg: ChatMsg = { id: `m${nextId++}`, role: "assistant", content: "", loading: true };
    setMessages((m) => [...m, userMsg, assistantMsg]);
    setInput("");
    setLoading(true);
    const priorHistory = history;
    try {
      const res = (await chrome.runtime.sendMessage({
        type: "ASK",
        payload: { question, history: priorHistory },
      })) as { ok: boolean; answer?: string; citations?: Record<number, Citation>; error?: string };
      if (!res || !res.ok) {
        const err = res?.error ?? "Request failed";
        setMessages((m) =>
          m.map((x) => (x.id === assistantMsg.id ? { ...x, loading: false, error: err, content: "" } : x)),
        );
        return;
      }
      const answer = res.answer ?? "";
      const citations = res.citations;
      setMessages((m) =>
        m.map((x) =>
          x.id === assistantMsg.id ? { ...x, loading: false, content: answer, citations } : x,
        ),
      );
      setHistory((h) => [
        ...h,
        { role: "user", content: question },
        { role: "assistant", content: answer },
      ]);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      setMessages((m) =>
        m.map((x) => (x.id === assistantMsg.id ? { ...x, loading: false, error: err, content: "" } : x)),
      );
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[80%] rounded-[10px] bg-primary/10 px-3 py-2 text-sm text-foreground">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex justify-start">
              <div className="max-w-[90%] rounded-[10px] border border-[#e7e2d8] bg-white px-3 py-2 text-sm">
                {m.loading ? (
                  <span className="text-[#a8a29e]">Thinking…</span>
                ) : m.error ? (
                  <span className="text-[#645d58]">{m.error}</span>
                ) : (
                  <>
                    <p className="whitespace-pre-wrap">{m.content}</p>
                    {m.citations && Object.keys(m.citations).length > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-[#645d58]">Sources</summary>
                        <ul className="mt-1 space-y-1">
                          {Object.entries(m.citations).map(([i, c]) => (
                            <li key={i} className="flex items-start gap-1.5 text-xs text-[#645d58]">
                              <BookOpen className="mt-0.5 size-3.5 shrink-0" />
                              <span>
                                [C{Number(i) + 1}] {c.text}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {m.citations && Object.keys(m.citations).length === 0 && (
                      <p className="mt-2 text-xs text-[#a8a29e]">No sources</p>
                    )}
                  </>
                )}
              </div>
            </div>
          ),
        )}
      </div>
      <div className="border-t border-[#e7e2d8] bg-white px-3 py-2">
        <div className="flex items-end gap-2 rounded-[10px] border border-[#e7e2d8] bg-white p-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask your graph…"
            rows={1}
            className="flex-1 resize-none bg-transparent text-sm outline-none"
          />
          <button
            type="button"
            aria-label="Send"
            disabled={loading || input.trim() === ""}
            onClick={() => void send()}
            className="flex size-8 items-center justify-center rounded-full bg-primary text-white disabled:opacity-40"
          >
            <Send className="size-4" />
          </button>
        </div>
        <p className="mt-1 text-[11px] text-[#a8a29e]">
          Answers cite the passages they use — or say what isn't in the graph.
        </p>
      </div>
    </div>
  );
}
