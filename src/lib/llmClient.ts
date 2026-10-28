import type { ChatMessage } from "./prompts";

// OpenAI-compatible LLM client. The API key is sent ONLY to the user-entered
// baseUrl (Review Focus #5); every request targets `joinUrl(s.baseUrl, ...)`.

export interface LlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const SETTINGS_KEY = "llmSettings";

// Pin behavior: strip ONE trailing "/" from baseUrl, then append "/path".
// (Not `new URL(path, base)` — that would replace the last path segment when
// the baseUrl ends in a filename.)
function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, baseUrl.length - 1) : baseUrl;
  return `${base}/${path}`;
}

function isLlmSettings(value: unknown): value is LlmSettings {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.baseUrl === "string" &&
    s.baseUrl !== "" &&
    typeof s.apiKey === "string" &&
    s.apiKey !== "" &&
    typeof s.model === "string" &&
    s.model !== ""
  );
}

function authHeaders(s: LlmSettings): Record<string, string> {
  return { Authorization: `Bearer ${s.apiKey}` };
}

// Errors must carry the status and enough of the body to be visible in UI later.
async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  throw new Error(
    `LLM request failed with status ${res.status}: ${body.slice(0, 200)}`,
  );
}

export async function getSettings(): Promise<LlmSettings | null> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const value = (stored as Record<string, unknown>)?.[SETTINGS_KEY];
  return isLlmSettings(value) ? value : null;
}

export async function setSettings(s: LlmSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
}

export async function listModels(
  s: LlmSettings,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const res = await fetchImpl(joinUrl(s.baseUrl, "models"), {
    headers: authHeaders(s),
  });
  await ensureOk(res);
  const json = (await res.json()) as { data?: Array<{ id: string }> };
  return (json.data ?? []).map((m) => m.id);
}

export async function chat(
  s: LlmSettings,
  messages: ChatMessage[],
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(joinUrl(s.baseUrl, "chat/completions"), {
    method: "POST",
    headers: { ...authHeaders(s), "Content-Type": "application/json" },
    body: JSON.stringify({ model: s.model, messages }),
  });
  await ensureOk(res);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.choices?.[0]?.message?.content ?? "";
}

export async function chatStream(
  s: LlmSettings,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(joinUrl(s.baseUrl, "chat/completions"), {
    method: "POST",
    headers: { ...authHeaders(s), "Content-Type": "application/json" },
    body: JSON.stringify({ model: s.model, messages, stream: true }),
  });
  await ensureOk(res);

  let full = "";

  // Returns true when a [DONE] frame is seen.
  function processLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return false; // blank lines, comments, etc.
    const payload = trimmed.slice("data:".length).trim();
    if (payload === "[DONE]") return true;
    try {
      const parsed = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        full += delta;
        onDelta(delta);
      }
    } catch {
      // Tolerate data: frames that are not JSON; keep reading until [DONE].
    }
    return false;
  }

  // Feed chunks in; returns true once [DONE] is seen.
  function processChunkText(text: string): boolean {
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") {
        if (processLine(text.slice(start, i))) return true;
        start = i + 1;
      }
    }
    if (start < text.length && processLine(text.slice(start))) return true;
    return false;
  }

  const reader = res.body ? res.body.getReader() : null;
  if (reader) {
    const decoder = new TextDecoder();
    let carry = "";
    let finished = false;
    while (!finished) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      // SSE frames are line-delimited; carry the trailing partial line.
      const text = carry + decoder.decode(value, { stream: true });
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline === -1) {
        carry = text;
        continue;
      }
      carry = text.slice(lastNewline + 1);
      if (processChunkText(text.slice(0, lastNewline + 1))) finished = true;
    }
    if (!finished && carry.length > 0) processChunkText(carry);
  } else {
    // Fallback when no stream body is available: read the full text at once.
    processChunkText(await res.text());
  }

  return full;
}

export async function ensureHostPermission(baseUrl: string): Promise<boolean> {
  try {
    const granted = await chrome.permissions.request({
      origins: [`${new URL(baseUrl).origin}/*`],
    });
    return granted;
  } catch {
    // e.g. called outside a user gesture — the UI must invoke this in a click.
    return false;
  }
}
