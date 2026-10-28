import { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, Eye, EyeOff } from "lucide-react";
import {
  ensureHostPermission,
  getSettings,
  listModels,
  setSettings,
} from "../lib/llmClient";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * "LLM Connection" section (Part 2 of the approved Options design).
 *
 * Connect: asks for host permission first, then fetches the model list from
 * the endpoint. Save: persists baseUrl + apiKey + model via setSettings.
 * Current settings are loaded and displayed on mount. Errors surface as muted
 * text near the action row — never thrown.
 */
export default function Connection() {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((settings) => {
        if (cancelled || !settings) return;
        setBaseUrl(settings.baseUrl);
        setApiKey(settings.apiKey);
        setModel(settings.model);
        setConnected(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const baseUrlValid = (() => {
    if (!baseUrl) return false;
    try {
      new URL(baseUrl);
      return true;
    } catch {
      return false;
    }
  })();

  async function handleConnect() {
    setError(null);
    setBusy(true);
    try {
      // Permission gate FIRST: only on a grant do we touch the network.
      const granted = await ensureHostPermission(baseUrl);
      if (!granted) {
        setError("Host permission was not granted, so the model list could not be fetched.");
        return;
      }
      const list = await listModels({ baseUrl, apiKey, model });
      if (list.length === 0) {
        setError("The endpoint returned no models.");
        return;
      }
      setModels(list);
      if (!list.includes(model)) setModel(list[0]);
      setConnected(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    setError(null);
    setBusy(true);
    try {
      await setSettings({ baseUrl, apiKey, model });
      setConnected(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const canSave = Boolean(baseUrl && apiKey && model) && !busy;

  return (
    <section>
      <div className="mb-6">
        <h2 className="text-[22px] font-medium leading-8 tracking-[-0.01em]">LLM Connection</h2>
        <p className="mt-1 text-[13px] leading-[20.8px] text-secondary">
          Connect any OpenAI-compatible endpoint. Your API key is stored locally and sent only to
          the endpoint you enter.
        </p>
      </div>

      {/* White settings card */}
      <Card className="gap-5 rounded-xl p-6">
        {/* Field: Base URL */}
        <div>
          <Label htmlFor="base-url-input" className="mb-2 block">
            Base URL
          </Label>
          <div className="relative flex items-center">
            <Input
              id="base-url-input"
              type="text"
              spellCheck={false}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
              className="pr-10 font-mono text-[13px]"
            />
            {baseUrlValid && (
              <CheckCircle2
                aria-hidden
                className="absolute right-3 size-[18px] text-emerald-600"
              />
            )}
          </div>
        </div>

        {/* Field: API Key */}
        <div>
          <Label htmlFor="api-key-input" className="mb-2 block">
            API Key
          </Label>
          <div className="relative flex items-center">
            <Input
              id="api-key-input"
              type={showKey ? "text" : "password"}
              spellCheck={false}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="pr-10 font-mono text-[13px]"
            />
            <button
              type="button"
              title="Toggle key visibility"
              aria-label="Toggle key visibility"
              onClick={() => setShowKey((visible) => !visible)}
              className="absolute right-2.5 rounded-[4px] p-1 text-secondary transition-colors hover:text-foreground"
            >
              {showKey ? (
                <EyeOff aria-hidden className="size-[18px]" />
              ) : (
                <Eye aria-hidden className="size-[18px]" />
              )}
            </button>
          </div>
        </div>

        {/* Action row */}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button type="button" onClick={() => void handleConnect()} disabled={busy}>
            Connect
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleSave()}
            disabled={!canSave}
          >
            Save connection
          </Button>
          <span className="text-[11px] tracking-[0.04em] text-secondary">
            Fetches the model list from the endpoint.
          </span>
        </div>

        {/* Errors surface as muted text near the action row, never thrown. */}
        {error && (
          <p role="alert" className="text-[13px] leading-[20.8px] text-secondary">
            {error}
          </p>
        )}

        {/* Hairline divider */}
        <div className="border-t" />

        {/* Field: Model Selection */}
        <div>
          <Label htmlFor="model-select" className="mb-2 block">
            Model
          </Label>
          <div className="relative">
            <select
              id="model-select"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full cursor-pointer appearance-none rounded-md border border-input bg-card px-3.5 py-2.5 pr-10 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {models === null ? (
                <option value={model}>{model || "Connect to fetch models"}</option>
              ) : (
                models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))
              )}
            </select>
            <ChevronDown
              aria-hidden
              className="pointer-events-none absolute right-3 top-1/2 size-5 -translate-y-1/2 text-secondary"
            />
          </div>
          <p className="mt-1.5 text-[11px] tracking-[0.04em] text-secondary">
            Used for extraction and chat.
          </p>
        </div>

        {/* Quiet connection status row */}
        {connected && (
          <div className="flex items-center gap-2 pt-1 text-[13px] leading-[20.8px] text-secondary">
            <span aria-hidden className="inline-block size-2 rounded-full bg-emerald-600" />
            <span>Connected</span>
          </div>
        )}
      </Card>
    </section>
  );
}
