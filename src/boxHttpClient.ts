import type { BoxClient, BoxInfo, CommandResult } from "./types.js";

export class BoxApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export interface BoxHttpClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

/** Shell-quote a value for safe inline `KEY='value'` env prefixes. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * HTTP client for the Box public API v1. Box is used strictly as a runtime
 * substrate: boxes are created/resumed/stopped and commands/files run inside
 * them. This client intentionally exposes NO method to call Box's built-in
 * `/prompt` agent — the acting agents are the developer's own harnesses.
 */
export class BoxHttpClient implements BoxClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;

  constructor(options: BoxHttpClientOptions) {
    if (!options.apiKey) throw new Error("BoxHttpClient requires a Box API key");
    this.baseUrl = (options.baseUrl ?? "https://ascii.dev/api/box/v1").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKey = options.apiKey;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const controller = new AbortController();
    const upstreamSignal = init.signal;
    const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
    if (upstreamSignal?.aborted) abortFromUpstream();
    else upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`Box API request timed out after ${this.requestTimeoutMs}ms: ${path}`)), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof Error ? reason : new Error(`Box API request aborted: ${path}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      upstreamSignal?.removeEventListener("abort", abortFromUpstream);
    }
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok || json?.ok === false) {
      throw new BoxApiError(response.status, json?.code ?? json?.error?.code ?? "box_api_error", json?.message ?? json?.error?.message ?? response.statusText, json?.details ?? json?.error?.details);
    }
    return json as T;
  }

  async create(input: { name?: string; ttlSeconds?: number | null }): Promise<BoxInfo> {
    const body: Record<string, unknown> = {};
    if (input.ttlSeconds !== undefined) body.ttlSeconds = input.ttlSeconds;
    const json = await this.request<{ box: BoxInfo }>("/boxes", { method: "POST", body: JSON.stringify(body) });
    if (input.name) {
      const update: { name?: string; ttlSeconds?: number | null } = { name: input.name };
      if (input.ttlSeconds !== undefined) update.ttlSeconds = input.ttlSeconds;
      return this.update(json.box.id, update);
    }
    return json.box;
  }

  async list(): Promise<BoxInfo[]> {
    const json = await this.request<{ boxes?: BoxInfo[] }>("/boxes");
    return json.boxes ?? [];
  }

  async get(boxId: string): Promise<BoxInfo> {
    return (await this.request<{ box: BoxInfo }>(`/boxes/${encodeURIComponent(boxId)}`)).box;
  }

  async update(boxId: string, input: { name?: string; ttlSeconds?: number | null }): Promise<BoxInfo> {
    return (await this.request<{ box: BoxInfo }>(`/boxes/${encodeURIComponent(boxId)}`, { method: "PATCH", body: JSON.stringify(input) })).box;
  }

  async stop(boxId: string): Promise<BoxInfo | { ok: boolean }> {
    const json = await this.request<{ box?: BoxInfo; ok: boolean }>(`/boxes/${encodeURIComponent(boxId)}/stop`, { method: "POST" });
    return json.box ?? { ok: json.ok };
  }

  async resume(boxId: string): Promise<BoxInfo | { ok: boolean }> {
    const json = await this.request<{ box?: BoxInfo; ok: boolean }>(`/boxes/${encodeURIComponent(boxId)}/resume`, { method: "POST" });
    return json.box ?? { ok: json.ok };
  }

  async fork(boxId: string): Promise<BoxInfo> {
    const json = await this.request<{ box?: BoxInfo; id?: string }>(`/boxes/${encodeURIComponent(boxId)}/fork`, { method: "POST", body: JSON.stringify({}) });
    const box = json.box ?? (json.id ? await this.get(json.id) : undefined);
    if (!box) throw new BoxApiError(500, "fork_no_box", `fork of ${boxId} returned no box`);
    return box;
  }

  async command(boxId: string, input: { command: string; cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<CommandResult> {
    const prefix = input.env && Object.keys(input.env).length
      ? Object.entries(input.env).map(([k, v]) => `export ${k}=${shq(v)}; `).join("")
      : "";
    const command = prefix ? `${prefix}${input.command}` : input.command;
    // The Box API documents timeoutSeconds range 1-60 (default 30). Clamp instead
    // of sending an out-of-range value; anything longer must run detached (nohup)
    // and be polled — which is exactly how runHarness executes agent loops.
    const timeoutSeconds = input.timeoutMs ? Math.min(60, Math.max(1, Math.ceil(input.timeoutMs / 1000))) : undefined;
    const json = await this.request<{ result?: CommandResult; exitCode?: number; stdout?: string; stderr?: string }>(`/boxes/${encodeURIComponent(boxId)}/commands`, { method: "POST", body: JSON.stringify({ command, cwd: input.cwd, timeoutSeconds }) });
    return json.result ?? { exitCode: json.exitCode ?? 0, stdout: json.stdout ?? "", stderr: json.stderr ?? "" };
  }

  /** Latest completed snapshot of a box, or undefined when none exists. */
  async latestSnapshot(boxId: string): Promise<{ id: string; status: string } | undefined> {
    const json = await this.request<{ snapshot?: { id: string; status: string } | null }>(`/boxes/${encodeURIComponent(boxId)}/snapshots/latest`);
    return json.snapshot ?? undefined;
  }

  /** File tree of a snapshot (user-written files; base image excluded). */
  async snapshotTree(snapshotId: string): Promise<{ treeAvailable: boolean; truncated: boolean; entries: Array<{ path: string; kind: string; size?: number }>; reason?: string }> {
    return await this.request(`/snapshots/${encodeURIComponent(snapshotId)}/tree`);
  }

  /** Raw bytes of one file inside a snapshot (409s on dirs/symlinks/base-image files). */
  async snapshotFileBytes(snapshotId: string, path: string): Promise<{ bytes: Buffer; kind: string }> {
    const response = await this.rawGet(`/snapshots/${encodeURIComponent(snapshotId)}/files?${new URLSearchParams({ path })}`);
    return { bytes: Buffer.from(await response.arrayBuffer()), kind: response.headers.get("X-Snapshot-Entry-Kind") ?? "file" };
  }

  /** Read a live-box file as raw bytes via base64 encoding. */
  async readFileBytes(boxId: string, path: string): Promise<Buffer> {
    const json = await this.request<{ content?: string; file?: { content: string } }>(`/boxes/${encodeURIComponent(boxId)}/files?${new URLSearchParams({ path, encoding: "base64" })}`);
    return Buffer.from(json.content ?? json.file?.content ?? "", "base64");
  }

  /** Write raw bytes to a live-box file via base64 encoding. */
  async writeFileBytes(boxId: string, path: string, bytes: Buffer): Promise<void> {
    await this.request(`/boxes/${encodeURIComponent(boxId)}/files`, { method: "PUT", body: JSON.stringify({ path, content: bytes.toString("base64"), encoding: "base64" }) });
  }

  /** GET returning the raw Response (binary endpoints; throws on !ok). */
  private async rawGet(path: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Box API request timed out: ${path}`)), Math.max(this.requestTimeoutMs, 120_000));
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { Authorization: `Bearer ${this.apiKey}` }, signal: controller.signal });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new BoxApiError(response.status, "box_api_error", text.slice(0, 300) || response.statusText);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async readFile(boxId: string, path: string): Promise<string> {
    const json = await this.request<{ content?: string; file?: { content: string } }>(`/boxes/${encodeURIComponent(boxId)}/files?${new URLSearchParams({ path, encoding: "utf8" })}`);
    return json.content ?? json.file?.content ?? "";
  }

  async writeFile(boxId: string, path: string, content: string): Promise<void> {
    await this.request(`/boxes/${encodeURIComponent(boxId)}/files`, { method: "PUT", body: JSON.stringify({ path, content, encoding: "utf8" }) });
  }
}

/**
 * Wraps a BoxClient so any attempt to reach Box's built-in agent throws. Used as
 * runtime, auditable proof that this framework never delegates the agent loop to
 * Box's embedded default agent/prompt.
 */
export function assertNoBoxAgent<T extends BoxClient>(box: T): T {
  return new Proxy(box, {
    get(target, prop, receiver) {
      if (prop === "prompt" || prop === "events" || prop === "chat" || prop === "agent") {
        throw new Error(`Box built-in agent is disabled: '${String(prop)}' is forbidden. ConsumerBoxAgents only uses external harnesses via command/readFile/writeFile.`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
