import type { HarnessCompletion } from "../src/types.js";

/**
 * DIRECT streaming for the shared (no-tools) surface.
 *
 * The shared surface is a plain chat completion — no tools, no machine state. It
 * does NOT need OpenCode. Earlier we ran it through `opencode run` (a ~6.5s cold
 * start per turn) and then a warm `opencode serve` (a single long-lived process
 * that WEDGES under the rapid-message + interrupt load this system generates —
 * one stuck generation and every later shared turn returns empty).
 *
 * A direct provider call has none of those failure modes: each turn is an
 * independent HTTP request, so there is nothing shared to wedge, an interrupt
 * just drops that one request, and we get REAL token-by-token streaming
 * (~1.25s to first token, measured). The trade-off — the shared surface no longer
 * runs the exact same binary as the Box — is acceptable: the Box still runs the
 * real tool harness; only this stateless chat line is served directly.
 *
 * Model string is "<providerID>/<modelID...>" (from the adapter's buildArgv), e.g.
 * "openrouter/anthropic/claude-haiku-4.5" or "anthropic/claude-haiku-4-5-...".
 */

export interface SharedDirectStreamArgs {
  /** "<providerID>/<modelID>" — providerID selects the API, the rest is the model. */
  modelString: string;
  /** Full prompt (already embeds system instructions + transcript + latest request). */
  prompt: string;
  onComplete?: (info: HarnessCompletion) => void;
  signal?: AbortSignal;
  timeoutMs: number;
}

interface ProviderCall {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Extract an incremental text delta from one parsed SSE data object. */
  delta: (json: unknown) => string;
}

function buildProviderCall(providerID: string, modelID: string, prompt: string): ProviderCall {
  const messages = [{ role: "user", content: prompt }];
  if (providerID === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("shared direct stream: ANTHROPIC_API_KEY is not set");
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: modelID, stream: true, max_tokens: 2048, messages }),
      delta: (j: any) => (j?.type === "content_block_delta" && j?.delta?.type === "text_delta" ? String(j.delta.text ?? "") : ""),
    };
  }
  // OpenAI-compatible chat completions (OpenRouter proxies every provider here).
  const openrouter = providerID === "openrouter";
  const key = openrouter ? process.env.OPENROUTER_API_KEY : process.env.OPENAI_API_KEY;
  if (!key) throw new Error(`shared direct stream: ${openrouter ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY"} is not set`);
  return {
    url: openrouter ? "https://openrouter.ai/api/v1/chat/completions" : "https://api.openai.com/v1/chat/completions",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({ model: modelID, stream: true, messages }),
    delta: (j: any) => String(j?.choices?.[0]?.delta?.content ?? ""),
  };
}

export async function* sharedDirectStream(args: SharedDirectStreamArgs): AsyncIterable<string> {
  const { modelString, prompt, onComplete, signal, timeoutMs } = args;
  const slash = modelString.indexOf("/");
  if (slash < 0) throw new Error(`shared direct stream: bad model string ${JSON.stringify(modelString)}`);
  const providerID = modelString.slice(0, slash);
  const modelID = modelString.slice(slash + 1);
  const call = buildProviderCall(providerID, modelID, prompt);

  // Independent request: abort just drops THIS call — nothing shared to corrupt.
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener("abort", onAbort); }
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let sawText = false;
  try {
    const res = await fetch(call.url, { method: "POST", headers: call.headers, body: call.body, signal: ac.signal });
    if (!res.ok || !res.body) throw new Error(`shared direct stream: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let parsed: unknown;
        try { parsed = JSON.parse(payload); } catch { continue; }
        const text = call.delta(parsed);
        if (text) { sawText = true; yield text; }
      }
    }
  } catch (e) {
    if (ac.signal.aborted) {
      onComplete?.({ reason: signal?.aborted ? "aborted" : "timeout", sawText });
      return;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }

  onComplete?.({
    reason: "completed",
    exitCode: 0,
    sawText,
    ...(sawText ? {} : { diagnostic: `shared direct stream (${providerID}/${modelID}) produced no text` }),
  });
}
