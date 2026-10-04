import type { BoxClient, BoxEvent, BoxInfo, CommandResult, PromptRun } from "./types.js";

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

/** HTTP client for the Boat public API v1 (https://boat.dev/api/v1): sandboxes, integrated agents, files, desktop. */
export class BoxHttpClient implements BoxClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;

  constructor(options: BoxHttpClientOptions) {
    if (!options.apiKey) throw new Error("BoxHttpClient requires a Box API key");
    this.baseUrl = (options.baseUrl ?? process.env.BOAT_API_URL ?? process.env.BOX_API_URL ?? "https://boat.dev/api/v1").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKey = options.apiKey;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutOverrideMs?: number): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const controller = new AbortController();
    const requestTimeoutMs = timeoutOverrideMs ?? this.requestTimeoutMs;
    const timer = setTimeout(() => controller.abort(new Error(`Box API request timed out after ${requestTimeoutMs}ms: ${path}`)), requestTimeoutMs);
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
    }
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok || json?.ok === false) {
      throw new BoxApiError(response.status, json?.code ?? json?.error?.code ?? json?.error ?? "box_api_error", json?.message ?? json?.error?.message ?? response.statusText, json?.details ?? json?.error?.details);
    }
    return json as T;
  }

  // ---------------------------------------------------------------- machine

  async create(input: { name?: string; ttlSeconds?: number | null; noEnv?: boolean; env?: Record<string, string> }): Promise<BoxInfo> {
    const body: Record<string, unknown> = {};
    if (input.ttlSeconds !== undefined) body.ttlSeconds = input.ttlSeconds;
    // noEnv withholds every owner secret; env is then the machine's whole environment.
    if (input.noEnv) body.noEnv = true;
    if (input.env && Object.keys(input.env).length) body.env = input.env;
    const json = await this.request<{ sandbox: BoxInfo }>("/sandboxes", { method: "POST", body: JSON.stringify(body) }, 120_000);
    // The API ignores `name` on create (boxes are born "Box <date>"), so the rename is a second call.
    return input.name ? this.update(json.sandbox.id, { name: input.name }) : json.sandbox;
  }

  async get(boxId: string): Promise<BoxInfo> {
    return (await this.request<{ sandbox: BoxInfo }>(`/sandboxes/${encodeURIComponent(boxId)}`)).sandbox;
  }

  async update(boxId: string, input: { name?: string; ttlSeconds?: number | null }): Promise<BoxInfo> {
    return (await this.request<{ sandbox: BoxInfo }>(`/sandboxes/${encodeURIComponent(boxId)}`, { method: "PATCH", body: JSON.stringify(input) })).sandbox;
  }

  async stop(boxId: string): Promise<BoxInfo | { ok: boolean }> {
    const json = await this.request<{ sandbox?: BoxInfo; ok: boolean }>(`/sandboxes/${encodeURIComponent(boxId)}/stop`, { method: "POST" });
    return json.sandbox ?? { ok: json.ok };
  }

  /**
   * Resume a parked box. A body `env` REPLACES the box's stored environment
   * (the API keeps that env across every later stop/resume where env is
   * omitted) — this is how a user's new provider keys reach a no-env box.
   */
  async resume(boxId: string, input: { env?: Record<string, string> } = {}): Promise<BoxInfo | { ok: boolean }> {
    const hasEnv = Boolean(input.env && Object.keys(input.env).length);
    const json = await this.request<{ sandbox?: BoxInfo; ok: boolean }>(
      `/sandboxes/${encodeURIComponent(boxId)}/resume`,
      { method: "POST", ...(hasEnv ? { body: JSON.stringify({ env: input.env }) } : {}) },
    );
    return json.sandbox ?? { ok: json.ok };
  }

  async deleteBox(boxId: string): Promise<void> {
    await this.request(`/sandboxes/${encodeURIComponent(boxId)}`, { method: "DELETE" });
  }

  async command(boxId: string, input: { command: string; cwd?: string; timeoutMs?: number }): Promise<CommandResult> {
    const timeoutSeconds = input.timeoutMs ? Math.min(600, Math.max(1, Math.ceil(input.timeoutMs / 1000))) : undefined;
    // The HTTP layer must outlive the command's box-side window or it aborts a running command.
    const httpTimeoutMs = Math.max(this.requestTimeoutMs, ((timeoutSeconds ?? 30) * 1000) + 15_000);
    // Always name a cwd: a resumed box's default cwd can be a detached FUSE overmount.
    const json = await this.request<{ result?: CommandResult; exitCode?: number; stdout?: string; stderr?: string }>(
      `/sandboxes/${encodeURIComponent(boxId)}/commands`,
      { method: "POST", body: JSON.stringify({ command: input.command, cwd: input.cwd ?? "/home/user", timeoutSeconds }) },
      httpTimeoutMs,
    );
    return json.result ?? { exitCode: json.exitCode ?? 0, stdout: json.stdout ?? "", stderr: json.stderr ?? "" };
  }

  // ---------------------------------------------------------------- integrated agents

  async prompt(boxId: string, input: { provider: string; model?: string; reasoningEffort?: string; fast?: boolean; prompt: string; new?: boolean; conversationId?: string }): Promise<PromptRun> {
    const json = await this.request<{ promptId: string; conversationId: string; status: string; promptRun?: { done?: boolean } }>(
      `/sandboxes/${encodeURIComponent(boxId)}/prompt`, { method: "POST", body: JSON.stringify(input) }, 60_000,
    );
    return { promptId: json.promptId, conversationId: json.conversationId, status: json.status, done: Boolean(json.promptRun?.done) };
  }

  async promptRun(boxId: string, promptId: string): Promise<PromptRun> {
    const json = await this.request<{ promptRun: { promptId: string; conversationId: string | null; status: string; done: boolean } }>(
      `/sandboxes/${encodeURIComponent(boxId)}/prompts/${encodeURIComponent(promptId)}`,
    );
    return { promptId: json.promptRun.promptId, conversationId: json.promptRun.conversationId ?? "", status: json.promptRun.status, done: json.promptRun.done };
  }

  async events(boxId: string, input: { conversationId?: string; cursor?: string; limit?: number } = {}): Promise<{ events: BoxEvent[]; nextCursor?: string | null }> {
    const params = new URLSearchParams({ sort: "asc", limit: String(input.limit ?? 200) });
    if (input.conversationId) params.set("conversation", input.conversationId);
    if (input.cursor) params.set("cursor", input.cursor);
    const json = await this.request<{ events: BoxEvent[]; pageInfo?: { nextCursor?: string | null } }>(`/sandboxes/${encodeURIComponent(boxId)}/events?${params}`);
    return { events: json.events ?? [], nextCursor: json.pageInfo?.nextCursor ?? null };
  }

  async interrupt(boxId: string, conversationId?: string): Promise<void> {
    const qs = conversationId ? `?${new URLSearchParams({ conversation: conversationId })}` : "";
    await this.request(`/sandboxes/${encodeURIComponent(boxId)}/interrupt${qs}`, { method: "POST" });
  }

  /** Live catalog: every harness, its models and the reasoning levels each accepts. Public, no auth. */
  async providerModels(): Promise<Record<string, { models: Array<{ id: string; label: string; provider?: string; credentialIds?: string[]; reasoningEffort?: { supported: string[]; default: string } }>; default: string; cli?: { name: string; description: string; order?: number } }>> {
    const root = this.baseUrl.replace(/\/api(\/box)?\/v1$/, "");
    const response = await this.fetchImpl(`${root}/api/provider-models`);
    if (!response.ok) throw new BoxApiError(response.status, "provider_models", `GET /api/provider-models -> ${response.status}`);
    return (await response.json()) as never;
  }

  // ---------------------------------------------------------------- files, snapshots, desktop (fs panel)

  async latestSnapshot(boxId: string): Promise<{ id: string; status: string } | undefined> {
    const json = await this.request<{ snapshot?: { id: string; status: string } | null }>(`/sandboxes/${encodeURIComponent(boxId)}/snapshots/latest`);
    return json.snapshot ?? undefined;
  }

  async snapshotTree(snapshotId: string): Promise<{ treeAvailable: boolean; truncated: boolean; entries: Array<{ path: string; kind: string; size?: number }>; reason?: string }> {
    return await this.request(`/snapshots/${encodeURIComponent(snapshotId)}/tree`);
  }

  async snapshotFileBytes(snapshotId: string, path: string): Promise<{ bytes: Buffer; kind: string }> {
    const response = await this.rawGet(`/snapshots/${encodeURIComponent(snapshotId)}/files?${new URLSearchParams({ path })}`);
    return { bytes: Buffer.from(await response.arrayBuffer()), kind: response.headers.get("X-Snapshot-Entry-Kind") ?? "file" };
  }

  async readFileBytes(boxId: string, path: string): Promise<Buffer> {
    const json = await this.request<{ content?: string; file?: { content: string } }>(`/sandboxes/${encodeURIComponent(boxId)}/files?${new URLSearchParams({ path, encoding: "base64" })}`);
    return Buffer.from(json.content ?? json.file?.content ?? "", "base64");
  }

  async writeFileBytes(boxId: string, path: string, bytes: Buffer): Promise<void> {
    await this.request(`/sandboxes/${encodeURIComponent(boxId)}/files`, { method: "PUT", body: JSON.stringify({ path, content: bytes.toString("base64"), encoding: "base64" }) });
  }

  async desktopStreamUrl(boxId: string, opts: { vnc?: boolean; theme?: "light" | "dark"; publicAccess?: boolean } = {}): Promise<{ desktopUrl?: string; provisioning: boolean; message?: string }> {
    const params = new URLSearchParams();
    if (opts.vnc) params.set("vnc", "1");
    else if (opts.theme) params.set("theme", opts.theme);
    const qs = params.size ? `?${params}` : "";
    const json = await this.request<{ desktopUrl?: string | null; provisioning?: boolean; message?: string }>(
      `/sandboxes/${encodeURIComponent(boxId)}/desktop${qs}`,
      { method: "POST", body: JSON.stringify(opts.publicAccess ? { publicAccess: true } : {}) },
    );
    return { ...(json.desktopUrl ? { desktopUrl: json.desktopUrl } : {}), provisioning: Boolean(json.provisioning), ...(json.message ? { message: json.message } : {}) };
  }

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
    const json = await this.request<{ content?: string; file?: { content: string } }>(`/sandboxes/${encodeURIComponent(boxId)}/files?${new URLSearchParams({ path, encoding: "utf8" })}`);
    return json.content ?? json.file?.content ?? "";
  }

  async writeFile(boxId: string, path: string, content: string): Promise<void> {
    await this.request(`/sandboxes/${encodeURIComponent(boxId)}/files`, { method: "PUT", body: JSON.stringify({ path, content, encoding: "utf8" }) });
  }
}
