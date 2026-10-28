import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../src/lib/prompts";
import {
  chat,
  chatStream,
  ensureHostPermission,
  getSettings,
  listModels,
  setSettings,
  type LlmSettings,
} from "../src/lib/llmClient";

// Minimal chrome globals (storage.local + permissions.request) per test.
const store = new Map<string, unknown>();
const requestMock = vi.fn<() => Promise<boolean>>();

beforeEach(() => {
  store.clear();
  requestMock.mockReset();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string) =>
          store.has(key) ? { [key]: store.get(key) } : {},
        ),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        }),
      },
    },
    permissions: { request: requestMock },
  };
});

function settingsFixture(over: Partial<LlmSettings> = {}): LlmSettings {
  return { baseUrl: "https://api.test/v1/", apiKey: "sk-test", model: "gpt-x", ...over };
}

function messagesFixture(): ChatMessage[] {
  return [
    { role: "system", content: "You answer from the graph." },
    { role: "user", content: "Who built Kestrel Labs?" },
  ];
}

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

function captureFetch(
  respond: () => Response,
): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("llmClient settings", () => {
  it("setSettings stores under 'llmSettings' and getSettings round-trips", async () => {
    const s = settingsFixture();
    await setSettings(s);
    expect(store.get("llmSettings")).toEqual(s);
    await expect(getSettings()).resolves.toEqual(s);
  });

  it("getSettings returns null when nothing stored or fields missing/empty", async () => {
    await expect(getSettings()).resolves.toBeNull();
    await setSettings({ ...settingsFixture(), apiKey: "" });
    await expect(getSettings()).resolves.toBeNull();
    await setSettings({ ...settingsFixture(), model: undefined as unknown as string });
    await expect(getSettings()).resolves.toBeNull();
  });
});

describe("listModels", () => {
  it("(a) hits `${baseUrl}/models` (trailing slash stripped) and returns data[].id", async () => {
    const { fetchImpl, calls } = captureFetch(() =>
      new Response(JSON.stringify({ data: [{ id: "gpt-x" }, { id: "local-7b" }] }), {
        status: 200,
      }),
    );
    const models = await listModels(settingsFixture(), fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.test/v1/models");
    expect(models).toEqual(["gpt-x", "local-7b"]);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test",
    );
  });
});

describe("chat", () => {
  it("(b) posts to `${baseUrl}/chat/completions` and returns choices[0].message.content", async () => {
    const { fetchImpl, calls } = captureFetch(() =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Ada built it." } }],
        }),
        { status: 200 },
      ),
    );
    const answer = await chat(settingsFixture(), messagesFixture(), fetchImpl);
    expect(answer).toBe("Ada built it.");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.test/v1/chat/completions");
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.model).toBe("gpt-x");
    expect(body.messages).toEqual(messagesFixture());
  });

  it("(d) Review Focus #5: request targets only the user-entered baseUrl origin", async () => {
    const { fetchImpl, calls } = captureFetch(() =>
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
      }),
    );
    await chat(settingsFixture(), messagesFixture(), fetchImpl);
    for (const call of calls) {
      expect(new URL(call.url).origin).toBe("https://api.test");
      expect(call.url.startsWith("https://api.test/")).toBe(true);
    }
  });

  it("non-2xx throws an Error containing the status and the body's first 200 chars", async () => {
    const longBody = "b".repeat(200) + "TAIL";
    const { fetchImpl } = captureFetch(() => new Response(longBody, { status: 502 }));
    const err: Error = await chat(settingsFixture(), messagesFixture(), fetchImpl).then(
      () => {
        throw new Error("expected chat to reject");
      },
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("502");
    expect(err.message).toContain("b".repeat(200));
    expect(err.message).not.toContain("TAIL");
  });
});

describe("chatStream", () => {
  const SSE_FIXTURE =
    'data: {"choices":[{"delta":{"content":"He"}}]}\n\ndata: {"choices":[{"delta":{"content":"llo"}}]}\n\ndata: [DONE]\n\n';

  function sseFetch(text: string): typeof fetch {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    const fake = {
      ok: true,
      status: 200,
      body: stream,
      text: async () => text,
    };
    return (async () => fake as unknown as Response) as unknown as typeof fetch;
  }

  it("(c) calls onDelta with ['He','llo'] and returns 'Hello'", async () => {
    const deltas: string[] = [];
    let answer = "";
    answer = await chatStream(
      settingsFixture(),
      messagesFixture(),
      (text) => deltas.push(text),
      sseFetch(SSE_FIXTURE),
    );
    expect(deltas).toEqual(["He", "llo"]);
    expect(answer).toBe("Hello");
  });

  it("tolerates \\n separators and ignores non-JSON data: frames until [DONE]", async () => {
    const tolerant =
      "data: not-json\n\n" +
      ": comment frame\n" +
      'data: {"choices":[{"delta":{"content":"A"}}]}\n' +
      'data: {"unrelated":true}\n' +
      "data: [DONE]\n\n";
    const deltas: string[] = [];
    const answer = await chatStream(
      settingsFixture(),
      messagesFixture(),
      (text) => deltas.push(text),
      sseFetch(tolerant),
    );
    expect(deltas).toEqual(["A"]);
    expect(answer).toBe("A");
  });
});

describe("ensureHostPermission", () => {
  it("(e) returns the granted boolean passed by the stub", async () => {
    requestMock.mockResolvedValueOnce(true);
    await expect(ensureHostPermission("https://api.test/v1/")).resolves.toBe(true);
    expect(requestMock).toHaveBeenCalledWith({ origins: ["https://api.test/*"] });

    requestMock.mockResolvedValueOnce(false);
    await expect(ensureHostPermission("https://api.test/v1/")).resolves.toBe(false);
  });

  it("returns false when the permissions call throws", async () => {
    requestMock.mockRejectedValueOnce(new Error("no user gesture"));
    await expect(ensureHostPermission("https://api.test/v1/")).resolves.toBe(false);
  });
});
