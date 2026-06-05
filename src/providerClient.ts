/**
 * Minimal streaming LLM clients used ONLY for the restricted shared prewarm
 * answer (text-only, no tools, no Box access). The full agentic work is done by
 * the developer's real harness inside the user Box, not here.
 */

export interface SharedLlmInput {
  provider: string;
  model: string;
  system: string;
  user: string;
  apiKey: string;
  maxTokens?: number;
}

export async function* streamSharedAnswer(input: SharedLlmInput): AsyncIterable<string> {
  if (input.provider === "anthropic") return yield* streamAnthropic(input);
  if (input.provider === "openai") return yield* streamOpenAI(input);
  throw new Error(`No shared-answer client for provider '${input.provider}'`);
}

async function* streamAnthropic(input: SharedLlmInput): AsyncIterable<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.maxTokens ?? 400,
      system: input.system,
      stream: true,
      messages: [{ role: "user", content: input.user }],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Anthropic shared answer failed: ${res.status} ${await res.text()}`);
  for await (const data of sse(res.body)) {
    try {
      const j = JSON.parse(data);
      if (j.type === "content_block_delta" && j.delta?.type === "text_delta") yield j.delta.text as string;
    } catch { /* ignore keepalives */ }
  }
}

async function* streamOpenAI(input: SharedLlmInput): AsyncIterable<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
    body: JSON.stringify({
      model: input.model,
      stream: true,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`OpenAI shared answer failed: ${res.status} ${await res.text()}`);
  for await (const data of sse(res.body)) {
    if (data === "[DONE]") return;
    try {
      const j = JSON.parse(data);
      const delta = j.choices?.[0]?.delta?.content;
      if (delta) yield delta as string;
    } catch { /* ignore */ }
  }
}

async function* sse(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) yield trimmed.slice(5).trim();
    }
  }
}
