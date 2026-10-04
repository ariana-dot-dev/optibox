import type { SandboxClient, SandboxEvent, SandboxInfo, CommandResult, PromptRun } from "./types.js";

export class BoatApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export interface BoatHttpClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

/** HTTP client for the Boat public API v1 (https://boat.dev/api/v1): sandboxes, integrated agents, files, desktop. */
export class BoatHttpClient implements SandboxClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;

  constructor(options: BoatHttpClientOptions) {
    if (!options.apiKey) throw new Error("BoatHttpClient requires a Boat API key");
    this.baseUrl = (options.baseUrl || process.env.BOAT_API_URL || "https://boat.dev/api/v1").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKey = options.apiKey;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  /**
   * Reads (GET) ride out a short API outage: a backend deploy answers 502/503/504 or drops
   * the connection for a few seconds, and that used to crash a streaming turn
   * ("sandbox.round.crashed: Bad Gateway"). Writes are never retried: a repeated POST /prompt
   * would run the prompt twice.
   */
  private async request<T>(path: string, init: RequestInit = {}, timeoutOverrideMs?: number): Promise<T> {
    const isRead = !init.method || init.method === "GET";
    const deadline = Date.now() + 60_000;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce<T>(path, init, timeoutOverrideMs);
      } catch (error) {
        const transient = error instanceof BoatApiError ? [502, 503, 504].includes(error.status) : !(error instanceof Error && /timed out/.test(error.message));
        if (!isRead || !transient || Date.now() > deadline) throw error;
        await new Promise((r) => setTimeout(r, Math.min(4_000, 500 * 2 ** attempt)));
      }
    }
  }

  private async requestOnce<T>(path: string, init: RequestInit = {}, timeoutOverrideMs?: number): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const controller = new AbortController();
    const requestTimeoutMs = timeoutOverrideMs ?? this.requestTimeoutMs;
    const timer = setTimeout(() => controller.abort(new Error(`Boat API request timed out after ${requestTimeoutMs}ms: ${path}`)), requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof Error ? reason : new Error(`Boat API request aborted: ${path}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok || json?.ok === false) {
      throw new BoatApiError(response.status, json?.code ?? json?.error?.code ?? json?.error ?? "boat_api_error", json?.message ?? json?.error?.message ?? response.statusText, json?.details ?? json?.error?.details);
    }
    return json as T;
  }

  // ---------------------------------------------------------------- machine

  async create(input: { name?: string; ttlSeconds?: number | null; noEnv?: boolean; env?: Record<string, string> }): Promise<SandboxInfo> {
    const body: Record<string, unknown> = {};
    if (input.ttlSeconds !== undefined) body.ttlSeconds = input.ttlSeconds;
    // noEnv withholds every owner secret; env is then the machine's whole environment.
    if (input.noEnv) body.noEnv = true;
    if (input.env && Object.keys(input.env).length) body.env = input.env;
    const json = await this.request<{ sandbox: SandboxInfo }>("/sandboxes", { method: "POST", body: JSON.stringify(body) }, 120_000);
    // The API ignores `name` on create (sandboxes are born "Sandbox <date>"), so the rename is a second call.
    return input.name ? this.update(json.sandbox.id, { name: input.name }) : json.sandbox;
  }

  async get(sandboxId: string): Promise<SandboxInfo> {
    return (await this.request<{ sandbox: SandboxInfo }>(`/sandboxes/${encodeURIComponent(sandboxId)}`)).sandbox;
  }

  async update(sandboxId: string, input: { name?: string; ttlSeconds?: number | null }): Promise<SandboxInfo> {
    return (await this.request<{ sandbox: SandboxInfo }>(`/sandboxes/${encodeURIComponent(sandboxId)}`, { method: "PATCH", body: JSON.stringify(input) })).sandbox;
  }

  async stop(sandboxId: string): Promise<SandboxInfo | { ok: boolean }> {
    const json = await this.request<{ sandbox?: SandboxInfo; ok: boolean }>(`/sandboxes/${encodeURIComponent(sandboxId)}/stop`, { method: "POST" });
    return json.sandbox ?? { ok: json.ok };
  }

  /**
   * Resume a parked sandbox. A body `env` REPLACES the sandbox's stored environment
   * (the API keeps that env across every later stop/resume where env is
   * omitted) — this is how a user's new provider keys reach a no-env sandbox.
   */
  async resume(sandboxId: string, input: { env?: Record<string, string> } = {}): Promise<SandboxInfo | { ok: boolean }> {
    const hasEnv = Boolean(input.env && Object.keys(input.env).length);
    const json = await this.request<{ sandbox?: SandboxInfo; ok: boolean }>(
      `/sandboxes/${encodeURIComponent(sandboxId)}/resume`,
      { method: "POST", ...(hasEnv ? { body: JSON.stringify({ env: input.env }) } : {}) },
    );
    return json.sandbox ?? { ok: json.ok };
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    await this.request(`/sandboxes/${encodeURIComponent(sandboxId)}`, { method: "DELETE" });
  }

  async command(sandboxId: string, input: { command: string; cwd?: string; timeoutMs?: number }): Promise<CommandResult> {
    const timeoutSeconds = input.timeoutMs ? Math.min(600, Math.max(1, Math.ceil(input.timeoutMs / 1000))) : undefined;
    // The HTTP layer must outlive the command's sandbox-side window or it aborts a running command.
    const httpTimeoutMs = Math.max(this.requestTimeoutMs, ((timeoutSeconds ?? 30) * 1000) + 15_000);
    // Always name a cwd: a resumed sandbox's default cwd can be a detached FUSE overmount.
    const json = await this.request<{ result?: CommandResult; exitCode?: number; stdout?: string; stderr?: string }>(
      `/sandboxes/${encodeURIComponent(sandboxId)}/commands`,
      { method: "POST", body: JSON.stringify({ command: input.command, cwd: input.cwd ?? "/home/user", timeoutSeconds }) },
      httpTimeoutMs,
    );
    return json.result ?? { exitCode: json.exitCode ?? 0, stdout: json.stdout ?? "", stderr: json.stderr ?? "" };
  }

  // ---------------------------------------------------------------- integrated agents

  async prompt(sandboxId: string, input: { provider: string; model?: string; reasoningEffort?: string; fast?: boolean; prompt: string; new?: boolean; conversationId?: string }): Promise<PromptRun> {
    const json = await this.request<{ promptId: string; conversationId: string; status: string; promptRun?: { done?: boolean } }>(
      `/sandboxes/${encodeURIComponent(sandboxId)}/prompt`, { method: "POST", body: JSON.stringify(input) }, 60_000,
    );
    return { promptId: json.promptId, conversationId: json.conversationId, status: json.status, done: Boolean(json.promptRun?.done) };
  }

  async promptRun(sandboxId: string, promptId: string): Promise<PromptRun> {
    const json = await this.request<{ promptRun: { promptId: string; conversationId: string | null; status: string; done: boolean } }>(
      `/sandboxes/${encodeURIComponent(sandboxId)}/prompts/${encodeURIComponent(promptId)}`,
    );
    return { promptId: json.promptRun.promptId, conversationId: json.promptRun.conversationId ?? "", status: json.promptRun.status, done: json.promptRun.done };
  }

  async events(sandboxId: string, input: { conversationId?: string; cursor?: string; limit?: number } = {}): Promise<{ events: SandboxEvent[]; nextCursor?: string | null }> {
    const params = new URLSearchParams({ sort: "asc", limit: String(input.limit ?? 200) });
    if (input.conversationId) params.set("conversation", input.conversationId);
    if (input.cursor) params.set("cursor", input.cursor);
    const json = await this.request<{ events: SandboxEvent[]; pageInfo?: { nextCursor?: string | null } }>(`/sandboxes/${encodeURIComponent(sandboxId)}/events?${params}`);
    return { events: json.events ?? [], nextCursor: json.pageInfo?.nextCursor ?? null };
  }

  async interrupt(sandboxId: string, conversationId?: string): Promise<void> {
    const qs = conversationId ? `?${new URLSearchParams({ conversation: conversationId })}` : "";
    await this.request(`/sandboxes/${encodeURIComponent(sandboxId)}/interrupt${qs}`, { method: "POST" });
  }

  /** Live catalog: every harness, its models and the reasoning levels each accepts. Public, no auth. */
  async providerModels(): Promise<Record<string, { models: Array<{ id: string; label: string; provider?: string; credentialIds?: string[]; reasoningEffort?: { supported: string[]; default: string } }>; default: string; cli?: { name: string; description: string; order?: number } }>> {
    const root = this.baseUrl.replace(/\/api\/v1$/, "");
    const response = await this.fetchImpl(`${root}/api/provider-models`);
    if (!response.ok) throw new BoatApiError(response.status, "provider_models", `GET /api/provider-models -> ${response.status}`);
    return (await response.json()) as never;
  }

  // ---------------------------------------------------------------- files, snapshots, desktop (fs panel)

  async latestSnapshot(sandboxId: string): Promise<{ id: string; status: string } | undefined> {
    const json = await this.request<{ snapshot?: { id: string; status: string } | null }>(`/sandboxes/${encodeURIComponent(sandboxId)}/snapshots/latest`);
    return json.snapshot ?? undefined;
  }

  async snapshotTree(snapshotId: string): Promise<{ treeAvailable: boolean; truncated: boolean; entries: Array<{ path: string; kind: string; size?: number }>; reason?: string }> {
    return await this.request(`/snapshots/${encodeURIComponent(snapshotId)}/tree`);
  }

  async snapshotFileBytes(snapshotId: string, path: string): Promise<{ bytes: Buffer; kind: string }> {
    const response = await this.rawGet(`/snapshots/${encodeURIComponent(snapshotId)}/files?${new URLSearchParams({ path })}`);
    return { bytes: Buffer.from(await response.arrayBuffer()), kind: response.headers.get("X-Snapshot-Entry-Kind") ?? "file" };
  }

  async readFileBytes(sandboxId: string, path: string): Promise<Buffer> {
    const json = await this.request<{ content?: string; file?: { content: string } }>(`/sandboxes/${encodeURIComponent(sandboxId)}/files?${new URLSearchParams({ path, encoding: "base64" })}`);
    return Buffer.from(json.content ?? json.file?.content ?? "", "base64");
  }

  async writeFileBytes(sandboxId: string, path: string, bytes: Buffer): Promise<void> {
    await this.request(`/sandboxes/${encodeURIComponent(sandboxId)}/files`, { method: "PUT", body: JSON.stringify({ path, content: bytes.toString("base64"), encoding: "base64" }) });
  }

  async desktopStreamUrl(sandboxId: string, opts: { vnc?: boolean; theme?: "light" | "dark"; publicAccess?: boolean } = {}): Promise<{ desktopUrl?: string; provisioning: boolean; message?: string }> {
    const params = new URLSearchParams();
    if (opts.vnc) params.set("vnc", "1");
    else if (opts.theme) params.set("theme", opts.theme);
    const qs = params.size ? `?${params}` : "";
    const json = await this.request<{ desktopUrl?: string | null; provisioning?: boolean; message?: string }>(
      `/sandboxes/${encodeURIComponent(sandboxId)}/desktop${qs}`,
      { method: "POST", body: JSON.stringify(opts.publicAccess ? { publicAccess: true } : {}) },
    );
    return { ...(json.desktopUrl ? { desktopUrl: json.desktopUrl } : {}), provisioning: Boolean(json.provisioning), ...(json.message ? { message: json.message } : {}) };
  }

  private async rawGet(path: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Boat API request timed out: ${path}`)), Math.max(this.requestTimeoutMs, 120_000));
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { Authorization: `Bearer ${this.apiKey}` }, signal: controller.signal });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new BoatApiError(response.status, "boat_api_error", text.slice(0, 300) || response.statusText);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async readFile(sandboxId: string, path: string): Promise<string> {
    const json = await this.request<{ content?: string; file?: { content: string } }>(`/sandboxes/${encodeURIComponent(sandboxId)}/files?${new URLSearchParams({ path, encoding: "utf8" })}`);
    return json.content ?? json.file?.content ?? "";
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    await this.request(`/sandboxes/${encodeURIComponent(sandboxId)}/files`, { method: "PUT", body: JSON.stringify({ path, content, encoding: "utf8" }) });
  }
}
