import type {
  SandboxBackend,
  SandboxBackendCreateInput,
  SandboxBackendHandle,
  SandboxBackendPrewarmInput,
  SandboxBackendSessionState,
  SandboxCommandResult,
  SandboxNetworkPolicy,
  SandboxProcess,
  SandboxReadFileOptions,
  SandboxReadTextFileOptions,
  SandboxRunOptions,
  SandboxSession,
  SandboxSpawnOptions,
  SandboxWriteFileOptions,
  SandboxWriteBinaryFileOptions,
  SandboxWriteTextFileOptions,
} from "eve/sandbox";
import { BoxHttpClient, type BoxHttpClientOptions } from "./boxHttpClient.js";
import type { BoxClient, BoxInfo, CommandResult } from "./types.js";

export const ASCII_BOX_EVE_BACKEND_NAME = "ascii-box";
const WORKSPACE = "/workspace";
const BOX_WORKSPACE_DIR = "workspace";
const SPAWN_DIR = ".eve-spawn";

type SandboxBackendPrewarmResult = { readonly reused: boolean };

type EveBoxNetworkPolicyMode = "allow-all-only" | "unsupported";

export interface EveBoxBackendOptions {
  /** Existing low-level Box client. Useful for tests and applications that already wrap the Box API. */
  client?: EveBoxClient;
  /** API key used when `client` is omitted. Defaults to `process.env.BOX_API_KEY`. */
  apiKey?: string;
  /** Box API base URL. Defaults to BoxHttpClient's public API URL. */
  baseUrl?: string;
  /** Name or name prefix for boxes created by Eve. */
  name?: string | ((input: SandboxBackendCreateInput) => string);
  /** Auto-archive TTL for Eve boxes. `null` disables auto-stop when the API supports it. */
  ttlSeconds?: number | null;
  /** Poll cadence for `spawn().wait()` and stream tails. */
  pollMs?: number;
  /** Box command timeout for blocking `run()`. The Box v1 API currently caps this at 60 seconds. */
  commandTimeoutMs?: number;
  /** Initial network policy. Box currently cannot enforce Eve's fine-grained policies. */
  networkPolicy?: SandboxNetworkPolicy;
  /** How to handle network policy calls. Default accepts only `allow-all` as a no-op and throws for stricter policies. */
  networkPolicyMode?: EveBoxNetworkPolicyMode;
  /** Optional fetch implementation for the default BoxHttpClient. */
  fetchImpl?: BoxHttpClientOptions["fetchImpl"];
}

export interface EveBoxClient extends BoxClient {
  readFileBinary?(boxId: string, path: string): Promise<Uint8Array | null>;
  writeFileBinary?(boxId: string, path: string, content: Uint8Array): Promise<void>;
}

interface TemplateRecord {
  seedFiles: ReadonlyArray<{ path: string; content: string | Buffer }>;
  bootstrap?: SandboxBackendPrewarmInput<EveBoxUseOptions>["bootstrap"];
}

export interface EveBoxUseOptions {
  networkPolicy?: SandboxNetworkPolicy;
}

export class EveBoxUnsupportedError extends Error {
  constructor(feature: string, detail: string) {
    super(`Ascii Box Eve backend does not support ${feature}: ${detail}`);
    this.name = "EveBoxUnsupportedError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createClient(options: EveBoxBackendOptions): EveBoxClient {
  if (options.client) return options.client;
  const apiKey = options.apiKey ?? process.env.BOX_API_KEY;
  if (!apiKey) {
    throw new Error("asciiBox() requires a Box API key via options.apiKey or BOX_API_KEY");
  }
  const clientOptions: BoxHttpClientOptions = { apiKey };
  if (options.baseUrl !== undefined) clientOptions.baseUrl = options.baseUrl;
  if (options.fetchImpl !== undefined) clientOptions.fetchImpl = options.fetchImpl;
  return new BoxHttpClient(clientOptions);
}

function resolveWorkspacePath(path: string): string {
  if (path === "" || path === ".") return WORKSPACE;
  if (path.startsWith("/")) return path;
  return `${WORKSPACE}/${path.replace(/^\.\//, "")}`;
}

function toBoxPath(path: string): string {
  const resolved = resolveWorkspacePath(path);
  if (resolved === WORKSPACE) return BOX_WORKSPACE_DIR;
  if (resolved.startsWith(`${WORKSPACE}/`)) return `${BOX_WORKSPACE_DIR}/${resolved.slice(WORKSPACE.length + 1)}`;
  throw new EveBoxUnsupportedError("paths outside /workspace", `received ${JSON.stringify(path)}; Box file APIs are scoped to Eve's /workspace namespace`);
}

function toWorkspaceRelativePath(path: string): string {
  const resolved = resolveWorkspacePath(path);
  if (resolved === WORKSPACE) return ".";
  if (resolved.startsWith(`${WORKSPACE}/`)) return resolved.slice(WORKSPACE.length + 1);
  throw new EveBoxUnsupportedError("paths outside /workspace", `received ${JSON.stringify(path)}; Box commands are scoped to Eve's /workspace namespace`);
}

function toBoxCwd(path: string | undefined): string {
  const workspaceRelative = toWorkspaceRelativePath(path ?? ".");
  return workspaceRelative === "." ? BOX_WORKSPACE_DIR : `${BOX_WORKSPACE_DIR}/${workspaceRelative}`;
}

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "." : path.slice(0, index);
}

function envPrefix(env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) return "";
  return Object.entries(env).map(([key, value]) => `export ${key}=${shq(value)}; `).join("");
}

function timeoutFromOptions(options: EveBoxBackendOptions, runOptions?: SandboxRunOptions): number | undefined {
  const explicit = options.commandTimeoutMs;
  // SandboxRunOptions currently exposes abortSignal/env/workingDirectory but no timeout. Keep this helper isolated for future Eve additions.
  const possible = runOptions as SandboxRunOptions & { timeoutMs?: number; timeout?: number };
  return possible.timeoutMs ?? possible.timeout ?? explicit;
}

function assertSupportedNetworkPolicy(policy: SandboxNetworkPolicy | undefined, mode: EveBoxNetworkPolicyMode): void {
  if (policy === undefined) return;
  if (policy === "allow-all" && mode === "allow-all-only") return;
  if (policy === "allow-all" && mode === "unsupported") {
    throw new EveBoxUnsupportedError("network policy", "Box does not expose Eve network-policy enforcement; omit networkPolicy or use networkPolicyMode: 'allow-all-only'");
  }
  throw new EveBoxUnsupportedError(
    "network policy",
    `Box currently cannot enforce ${JSON.stringify(policy)}. Use allow-all, or run this Eve agent on Vercel/microsandbox for firewall-backed policies.`,
  );
}

function bufferToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function decodeText(bytes: Uint8Array, encoding = "utf-8"): string {
  if (encoding === "utf-8" || encoding === "utf8") return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return Buffer.from(bytes).toString(encoding as BufferEncoding);
}

function encodeText(text: string, encoding = "utf-8"): Uint8Array {
  if (encoding === "utf-8" || encoding === "utf8") return new TextEncoder().encode(text);
  return Buffer.from(text, encoding as BufferEncoding);
}

function sliceLines(text: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined && endLine === undefined) return text;
  const lines = text.split(/(?<=\n)/);
  const start = Math.max((startLine ?? 1) - 1, 0);
  const end = endLine === undefined ? lines.length : Math.max(endLine, 0);
  return lines.slice(start, end).join("");
}

async function maybeMissing<T>(operation: Promise<T>): Promise<T | null> {
  try {
    return await operation;
  } catch (error) {
    if (isRecord(error)) {
      const status = error.status;
      const code = error.code;
      const details = isRecord(error.details) ? error.details : undefined;
      const message = typeof error.message === "string" ? error.message : typeof details?.message === "string" ? details.message : "";
      if (status === 404 || code === "not_found" || code === "file_not_found" || (status === 400 && code === "box_direct_failed" && message.includes("ENOENT"))) return null;
    }
    throw error;
  }
}

async function readBinary(client: EveBoxClient, boxId: string, path: string): Promise<Uint8Array | null> {
  const boxPath = toBoxPath(path);
  if (client.readFileBinary) return maybeMissing(client.readFileBinary(boxId, boxPath));
  const base64 = await maybeMissing(client.readFile(boxId, boxPath));
  if (base64 === null) return null;
  // BoxHttpClient.readFile currently reads UTF-8. Prefer API-native binary when the client provides it.
  return new TextEncoder().encode(base64);
}

async function writeBinary(client: EveBoxClient, boxId: string, path: string, content: Uint8Array): Promise<void> {
  const boxPath = toBoxPath(path);
  const parent = dirname(boxPath);
  if (parent !== ".") await client.command(boxId, { command: `mkdir -p ${shq(parent)}`, timeoutMs: 10_000 });
  if (client.writeFileBinary) return client.writeFileBinary(boxId, boxPath, content);
  await client.writeFile(boxId, boxPath, decodeText(content));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(client: EveBoxClient, box: BoxInfo, timeoutMs = 300_000): Promise<BoxInfo> {
  const started = Date.now();
  let current = box;
  for (;;) {
    if (current.state === "ready" || current.state === "idle" || current.state === "running") return current;
    if (current.state === "error") throw new Error(`Box ${current.id} entered error state while waiting for readiness`);
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for Box ${current.id} to become ready; last state was ${current.state}`);
    await sleep(2_000);
    current = await client.get(current.id);
  }
}

async function ensureEveWorkspace(client: EveBoxClient, boxId: string): Promise<void> {
  const checkFile = `.eve-workspace-check-${Date.now().toString(36)}`;
  const command = [
    `mkdir -p ${shq(BOX_WORKSPACE_DIR)}`,
    `if [ ! -L ${shq(WORKSPACE)} ] && ! findmnt -rn --target ${shq(WORKSPACE)} >/dev/null 2>&1; then sudo rmdir ${shq(WORKSPACE)} 2>/dev/null || true; fi`,
    `if [ ! -e ${shq(WORKSPACE)} ]; then sudo ln -s "$PWD/${BOX_WORKSPACE_DIR}" ${shq(WORKSPACE)} 2>/dev/null || true; fi`,
    `if [ ! -L ${shq(WORKSPACE)} ] && ! findmnt -rn --target ${shq(WORKSPACE)} >/dev/null 2>&1; then sudo mkdir -p ${shq(WORKSPACE)} 2>/dev/null && sudo mount --bind "$PWD/${BOX_WORKSPACE_DIR}" ${shq(WORKSPACE)} 2>/dev/null || true; fi`,
    `touch ${shq(`${WORKSPACE}/${checkFile}`)} && test -e ${shq(`${BOX_WORKSPACE_DIR}/${checkFile}`)} && rm -f ${shq(`${WORKSPACE}/${checkFile}`)} ${shq(`${BOX_WORKSPACE_DIR}/${checkFile}`)}`,
  ].join("; ");
  const result = await client.command(boxId, { command, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(`Failed to initialize Eve /workspace in Box ${boxId}: ${result.stderr || result.stdout}`);
}

function commandResultExitCode(result: CommandResult): number {
  return typeof result.exitCode === "number" ? result.exitCode : 0;
}

function makeTailStream(input: {
  client: EveBoxClient;
  boxId: string;
  path: string;
  statusPath: string;
  pollMs: number;
  signal?: AbortSignal;
}): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let offset = 0;
      const encoder = new TextEncoder();
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      try {
        for (;;) {
          if (input.signal?.aborted) throw input.signal.reason ?? new Error("spawn stream aborted");
          const text = await maybeMissing(input.client.readFile(input.boxId, toBoxPath(input.path)));
          if (text && text.length > offset) {
            controller.enqueue(encoder.encode(text.slice(offset)));
            offset = text.length;
          }
          const status = await maybeMissing(input.client.readFile(input.boxId, toBoxPath(input.statusPath)));
          if (status !== null) {
            const finalText = await maybeMissing(input.client.readFile(input.boxId, toBoxPath(input.path)));
            if (finalText && finalText.length > offset) controller.enqueue(encoder.encode(finalText.slice(offset)));
            controller.close();
            return;
          }
          await sleep(input.pollMs);
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

class EveBoxSession implements SandboxSession {
  constructor(
    readonly id: string,
    private readonly client: EveBoxClient,
    private readonly boxId: string,
    private readonly options: { pollMs: number; networkPolicyMode: EveBoxNetworkPolicyMode; commandTimeoutMs?: number },
  ) {}

  resolvePath(path: string): string {
    return resolveWorkspacePath(path);
  }

  async setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void> {
    assertSupportedNetworkPolicy(policy, this.options.networkPolicyMode);
  }

  async run(options: SandboxRunOptions): Promise<SandboxCommandResult> {
    const commandInput: { command: string; cwd?: string; timeoutMs?: number } = { command: `${envPrefix(options.env)}${options.command}` };
    const cwd = toBoxCwd(options.workingDirectory);
    const timeoutMs = timeoutFromOptions(this.options, options);
    commandInput.cwd = cwd;
    if (timeoutMs !== undefined) commandInput.timeoutMs = timeoutMs;
    const result = await this.client.command(this.boxId, commandInput);
    return { exitCode: commandResultExitCode(result), stdout: result.stdout ?? "", stderr: result.stderr ?? "" } as SandboxCommandResult;
  }

  async spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
    const spawnId = `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const stdoutPath = `${SPAWN_DIR}/${spawnId}.stdout`;
    const stderrPath = `${SPAWN_DIR}/${spawnId}.stderr`;
    const statusPath = `${SPAWN_DIR}/${spawnId}.status`;
    const pidPath = `${SPAWN_DIR}/${spawnId}.pid`;
    const cwdRelative = toWorkspaceRelativePath(options.workingDirectory ?? ".");
    const workspaceRoot = `"$PWD"/${shq(BOX_WORKSPACE_DIR)}`;
    const shellPath = (path: string) => `"$workspace_root"/${shq(path)}`;
    const shellCwd = cwdRelative === "." ? `"$workspace_root"` : shellPath(cwdRelative);
    const command = [
      `workspace_root=${workspaceRoot}`,
      `mkdir -p ${shellPath(SPAWN_DIR)}`,
      `rm -f ${shellPath(stdoutPath)} ${shellPath(stderrPath)} ${shellPath(statusPath)} ${shellPath(pidPath)}`,
      `touch ${shellPath(stdoutPath)} ${shellPath(stderrPath)}`,
      `( cd ${shellCwd} && ${envPrefix(options.env)}( ${options.command} ) > ${shellPath(stdoutPath)} 2> ${shellPath(stderrPath)}; code=$?; echo "$code" > ${shellPath(statusPath)} ) & echo $! | tee ${shellPath(pidPath)}`,
    ].join("; ");
    const started = await this.client.command(this.boxId, { command, timeoutMs: 10_000 });
    if (commandResultExitCode(started) !== 0) throw new Error(`Failed to spawn process in Box ${this.boxId}: ${started.stderr || started.stdout}`);
    const pid = Number.parseInt((started.stdout ?? "").trim().split(/\s+/).at(-1) ?? "", 10);
    const signal = options.abortSignal;
    let killed = false;
    const kill = async () => {
      if (killed) return;
      killed = true;
      await this.client.command(this.boxId, { command: `if test -f ${shq(toBoxPath(pidPath))}; then kill -TERM $(cat ${shq(toBoxPath(pidPath))}) 2>/dev/null || true; fi`, timeoutMs: 5_000 });
    };
    if (signal) {
      if (signal.aborted) await kill();
      else signal.addEventListener("abort", () => { void kill(); }, { once: true });
    }
    const wait = async (): Promise<{ exitCode: number }> => {
      for (;;) {
        if (signal?.aborted) throw signal.reason ?? new Error("spawn aborted");
        const status = await maybeMissing(this.client.readFile(this.boxId, toBoxPath(statusPath)));
        if (status !== null) return { exitCode: Number.parseInt(status.trim(), 10) || 0 };
        await new Promise((resolve) => setTimeout(resolve, this.options.pollMs));
      }
    };
    return {
      ...(Number.isFinite(pid) ? { pid } : {}),
      stdout: makeTailStream({ client: this.client, boxId: this.boxId, path: stdoutPath, statusPath, pollMs: this.options.pollMs, ...(signal ? { signal } : {}) }),
      stderr: makeTailStream({ client: this.client, boxId: this.boxId, path: stderrPath, statusPath, pollMs: this.options.pollMs, ...(signal ? { signal } : {}) }),
      wait,
      kill,
    } as SandboxProcess;
  }

  async readFile(options: SandboxReadFileOptions): Promise<ReadableStream<Uint8Array> | null> {
    const bytes = await this.readBinaryFile(options);
    return bytes === null ? null : bufferToStream(bytes);
  }

  async readBinaryFile(options: SandboxReadFileOptions): Promise<Uint8Array | null> {
    return readBinary(this.client, this.boxId, options.path);
  }

  async readTextFile(options: SandboxReadTextFileOptions): Promise<string | null> {
    const bytes = await this.readBinaryFile(options);
    if (bytes === null) return null;
    return sliceLines(decodeText(bytes, options.encoding), options.startLine, options.endLine);
  }

  async writeFile(options: SandboxWriteFileOptions): Promise<void> {
    await writeBinary(this.client, this.boxId, options.path, await streamToBuffer(options.content));
  }

  async writeBinaryFile(options: SandboxWriteBinaryFileOptions): Promise<void> {
    await writeBinary(this.client, this.boxId, options.path, options.content);
  }

  async writeTextFile(options: SandboxWriteTextFileOptions): Promise<void> {
    await writeBinary(this.client, this.boxId, options.path, encodeText(options.content, options.encoding));
  }

  async removePath(options: { path: string; force?: boolean; recursive?: boolean; abortSignal?: AbortSignal }): Promise<void> {
    const flag = `${options.force ? "f" : ""}${options.recursive ? "r" : ""}`;
    const rmFlag = flag ? `-${flag}` : "";
    await this.client.command(this.boxId, { command: `rm ${rmFlag} -- ${shq(toBoxPath(options.path))}`, timeoutMs: 10_000 });
  }
}

class EveBoxHandle implements SandboxBackendHandle<EveBoxUseOptions> {
  constructor(
    readonly session: SandboxSession,
    private readonly boxId: string,
    private readonly backendName: string,
    private readonly sessionKey: string,
    private readonly applyNetworkPolicy: (policy: SandboxNetworkPolicy | undefined) => void,
  ) {}

  readonly useSessionFn = async (options?: EveBoxUseOptions): Promise<SandboxSession> => {
    this.applyNetworkPolicy(options?.networkPolicy);
    if (options?.networkPolicy) await this.session.setNetworkPolicy(options.networkPolicy);
    return this.session;
  };

  async captureState(): Promise<SandboxBackendSessionState> {
    return {
      backendName: this.backendName,
      sessionKey: this.sessionKey,
      metadata: { boxId: this.boxId },
    };
  }

  async dispose(): Promise<void> {
    // Eve may reconnect to the same logical session later. Leave the Box alive/archivable.
  }
}

export function asciiBox(options: EveBoxBackendOptions = {}): SandboxBackend<EveBoxUseOptions, EveBoxUseOptions> {
  const templates = new Map<string, TemplateRecord>();
  const client = createClient(options);
  const pollMs = options.pollMs ?? 500;
  const networkPolicyMode = options.networkPolicyMode ?? "allow-all-only";
  assertSupportedNetworkPolicy(options.networkPolicy, networkPolicyMode);

  async function prepareSessionFromTemplate(session: EveBoxSession, record: TemplateRecord | undefined): Promise<void> {
    if (!record) return;
    for (const seed of record.seedFiles) {
      const bytes = typeof seed.content === "string" ? encodeText(seed.content) : seed.content;
      await session.writeBinaryFile({ path: seed.path, content: bytes });
    }
    if (record.bootstrap) {
      await record.bootstrap({ use: async (useOptions?: EveBoxUseOptions) => {
        if (useOptions?.networkPolicy) await session.setNetworkPolicy(useOptions.networkPolicy);
        return session;
      } });
    }
  }

  return {
    name: ASCII_BOX_EVE_BACKEND_NAME,
    async prewarm(input: SandboxBackendPrewarmInput<EveBoxUseOptions>): Promise<SandboxBackendPrewarmResult> {
      const reused = templates.has(input.templateKey);
      if (!reused) {
        templates.set(input.templateKey, { seedFiles: input.seedFiles, bootstrap: input.bootstrap });
      }
      input.log?.("Ascii Box backend recorded Eve sandbox seed/bootstrap; Box template snapshots are not cloned, so setup is replayed when each session is first created.");
      return { reused };
    },
    async create(input: SandboxBackendCreateInput): Promise<SandboxBackendHandle<EveBoxUseOptions>> {
      assertSupportedNetworkPolicy(options.networkPolicy, networkPolicyMode);
      const metadata = input.existingMetadata;
      const existingBoxId = typeof metadata?.boxId === "string" ? metadata.boxId : undefined;
      let box: BoxInfo;
      if (existingBoxId) {
        await client.resume(existingBoxId).catch(() => undefined);
        box = await client.get(existingBoxId);
      } else {
        const name = typeof options.name === "function"
          ? options.name(input)
          : options.name ?? `eve-${input.sessionKey}`;
        box = await client.create({ name, ttlSeconds: options.ttlSeconds ?? 3600 });
      }
      box = await waitForReady(client, box);
      await ensureEveWorkspace(client, box.id);
      const sessionOptions: { pollMs: number; networkPolicyMode: EveBoxNetworkPolicyMode; commandTimeoutMs?: number } = { pollMs, networkPolicyMode };
      if (options.commandTimeoutMs !== undefined) sessionOptions.commandTimeoutMs = options.commandTimeoutMs;
      const session = new EveBoxSession(input.sessionKey, client, box.id, sessionOptions);
      if (!existingBoxId && input.templateKey !== null) {
        await prepareSessionFromTemplate(session, templates.get(input.templateKey));
      }
      return new EveBoxHandle(session, box.id, ASCII_BOX_EVE_BACKEND_NAME, input.sessionKey, (policy) => assertSupportedNetworkPolicy(policy, networkPolicyMode));
    },
  };
}

export const box = asciiBox;
