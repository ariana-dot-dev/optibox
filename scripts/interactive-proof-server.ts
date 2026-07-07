import http from "node:http";
import { createHash } from "node:crypto";
import { URL } from "node:url";
import {
  BoxHttpClient,
  assertNoBoxAgent,
  BOX_PRICING,
  ConsumerBoxAgentOrchestrator,
  InMemorySessionStore,
  createRestrictedSharedCapabilities,
  createSharedInfraCapabilities,
  RUNTIME_FEASIBILITY,
  type ConsumerTurnEvent,
} from "../src/index.js";
import { realCliHarness, type RealCliHarnessSpec } from "../examples/shared.js";
import { spec as claudeSpec } from "../examples/claude-sdk/adapter.js";
import { spec as codebaseDaemonSpec } from "../examples/codebase-daemon/adapter.js";
import { spec as codexSpec } from "../examples/codex-sdk/adapter.js";
import { spec as hermesSpec } from "../examples/hermes/adapter.js";
import { spec as openclaudeSpec } from "../examples/openclaude/adapter.js";
import { spec as opencodeSpec } from "../examples/opencode/adapter.js";
import { spec as piSpec } from "../examples/pi/adapter.js";

const port = Number(process.env.PORT ?? 4178);

// Public task-agent previews must never reuse the task agent's real Box/LLM keys.
// Alfred/private previews can opt into the old zero-config behavior with
// OPTIBOX_ALLOW_SERVER_KEYS=1; non-agent private runtimes also keep it by default.
const allowServerKeys =
  process.env.OPTIBOX_ALLOW_SERVER_KEYS === "1" ||
  (process.env.PRODUCT_MODE !== "agent" &&
    process.env.OPTIBOX_ALLOW_SERVER_KEYS !== "0");

const allSpecs: RealCliHarnessSpec[] = [
  claudeSpec,
  codebaseDaemonSpec,
  codexSpec,
  hermesSpec,
  openclaudeSpec,
  opencodeSpec,
  piSpec,
];

interface DemoCredentials {
  boxApiKey: string | undefined;
  providerEnv: Record<string, string>;
  source: "server" | "byok";
}

const serverProviderEnv = allowServerKeys ? providerEnvFromProcess() : {};
const serverBoxApiKey = allowServerKeys ? process.env.BOX_API_KEY : undefined;
const orchestrators = new Map<string, ConsumerBoxAgentOrchestrator>();
const serverRunId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const auditRing: unknown[] = [];
const AUDIT_RING_LIMIT = Number(process.env.OPTIBOX_AUDIT_RING_LIMIT ?? 5000);

function rememberAudit(entry: unknown): void {
  auditRing.push(entry);
  while (auditRing.length > AUDIT_RING_LIMIT) auditRing.shift();
}

function providerEnvFromProcess(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY_SCOPED ?? process.env.OPENAI_API_KEY;
  if (openaiKey) {
    env.OPENAI_API_KEY = openaiKey;
    env.OPENAI_API_KEY_SCOPED = openaiKey;
  }
  if (process.env.OPENROUTER_API_KEY) env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  return env;
}

function providerEnvFromBody(raw: any): Record<string, string> {
  const apiKeys = raw && typeof raw === "object" ? raw.apiKeys ?? raw.keys ?? {} : {};
  const env: Record<string, string> = {};
  const put = (name: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) env[name] = value.trim();
  };
  put("ANTHROPIC_API_KEY", apiKeys.anthropicApiKey ?? apiKeys.ANTHROPIC_API_KEY);
  const openai = apiKeys.openaiApiKey ?? apiKeys.OPENAI_API_KEY ?? apiKeys.OPENAI_API_KEY_SCOPED;
  put("OPENAI_API_KEY", openai);
  put("OPENAI_API_KEY_SCOPED", openai);
  put("OPENROUTER_API_KEY", apiKeys.openrouterApiKey ?? apiKeys.OPENROUTER_API_KEY);
  return env;
}

function boxApiKeyFromBody(raw: any): string | undefined {
  const apiKeys = raw && typeof raw === "object" ? raw.apiKeys ?? raw.keys ?? {} : {};
  const value = apiKeys.boxApiKey ?? apiKeys.BOX_API_KEY;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function credentialsFromBody(raw: any): DemoCredentials {
  const byokProviderEnv = providerEnvFromBody(raw);
  const byokBoxApiKey = boxApiKeyFromBody(raw);
  const useByok = Boolean(byokBoxApiKey || Object.keys(byokProviderEnv).length);
  if (useByok) {
    return {
      boxApiKey: byokBoxApiKey ?? serverBoxApiKey,
      providerEnv: { ...serverProviderEnv, ...byokProviderEnv },
      source: "byok",
    };
  }
  return { boxApiKey: serverBoxApiKey, providerEnv: serverProviderEnv, source: "server" };
}

function envForProvider(provider: string): string {
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  return "OPENAI_API_KEY";
}

function keyAvailable(provider: string, providerEnv = serverProviderEnv): boolean {
  return Boolean(providerEnv[envForProvider(provider)]);
}

function credentialError(selection: { harness: string; provider: string; model: string }, credentials: DemoCredentials): string | undefined {
  if (!credentials.boxApiKey) {
    return allowServerKeys
      ? "BOX_API_KEY is not configured on the private preview and no BYOK Box key was provided."
      : "This public/dev preview requires your own Box API key. Open Settings (gear) and paste BOX_API_KEY.";
  }
  const required = envForProvider(selection.provider);
  if (!credentials.providerEnv[required]) {
    return allowServerKeys
      ? `${required} is not configured on the private preview and no BYOK provider key was provided.`
      : `This public/dev preview requires your own ${required}. Open Settings (gear), paste the key, and retry.`;
  }
  return undefined;
}

function orchestratorFor(credentials: DemoCredentials): ConsumerBoxAgentOrchestrator {
  if (!credentials.boxApiKey) throw new Error("BOX_API_KEY is required");
  const cacheKey = createHash("sha256")
    .update(JSON.stringify({ box: credentials.boxApiKey, providerEnv: credentials.providerEnv }))
    .digest("hex");
  const cached = orchestrators.get(cacheKey);
  if (cached) return cached;
  const providerEnv = credentials.providerEnv;
  const harnesses = allSpecs.map((spec) =>
    realCliHarness(spec, {
      createSharedRuntime: () => createSharedInfraCapabilities({ providerEnv }),
    }),
  );
  const orchestrator = new ConsumerBoxAgentOrchestrator({
    box: assertNoBoxAgent(new BoxHttpClient({ apiKey: credentials.boxApiKey })),
    harnesses,
    sessions: new InMemorySessionStore(),
    providerEnv,
    userBoxName: (userId) => `consumer-agent-user-${userId}-${cacheKey.slice(0, 8)}`,
    userBoxTtlSeconds: 900,
    // Readiness is now a live command probe (boxes execute commands seconds
    // before their state field reports ready), so poll fast to actually collect
    // that win instead of sleeping through it.
    readinessPollMs: 750,
    handoffTimeoutMs: 120_000,
    resumeTimeoutMs: 60_000,
    // Product decision: stop fast (~15s) once the assistant is idle — billing
    // theater beats warm-box latency here. A follow-up after the stop pays the
    // resume + disk-restore + serve-reboot (~12s measured); messages within the
    // window stay on the warm box (~7s answers).
    autoStopIdleMs: 15_000,
    // Safety net: force-stop idle boxes on a timer even if a request stream was
    // abandoned or a turn hung, so a VM can never be left running for hours/days.
    idleReaperIntervalMs: 15_000,
    // Orphan sweep: after a server restart the in-memory billing map is empty, so
    // running consumer-agent boxes from the previous process would bill until TTL.
    // The reaper stops any running box with our naming that this process isn't
    // billing (after a grace window). Assumes one server process per Box account.
    orphanBoxName: (name) => name.startsWith("consumer-agent-"),
    // Fresh user boxes fork this pre-installed snapshot (~16s restore) instead of
    // creating an empty box and npm-installing opencode inside it (~15-40s).
    userBoxTemplate: {
      name: "consumer-agent-template",
      installCmd: "npm i -g opencode-ai@latest >/tmp/opencode-install.log 2>&1",
    },
  });
  orchestrators.set(cacheKey, orchestrator);
  return orchestrator;
}

function harnessInfo(providerEnv = serverProviderEnv) {
  return allSpecs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    models: spec.models.map((m) => ({
      ...m,
      keyAvailable: keyAvailable(m.provider, providerEnv),
      requiredEnv: envForProvider(m.provider),
    })),
  }));
}

function sse(res: http.ServerResponse) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  return (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function redactAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactAuditValue);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (/hidden|recap|apiKey|token|secret|authorization/i.test(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = redactAuditValue(raw);
      }
    }
    return out;
  }
  if (typeof value === "string" && value.length > 500) return value.slice(0, 500) + "…";
  return value;
}

function auditEvent(event: ConsumerTurnEvent, input: { userId: string; conversationId: string; message: string }, requestId: string) {
  const redacted: any = redactAuditValue(event);
  if (Array.isArray(redacted.argv)) redacted.argv = redacted.argv.map((v: unknown) => {
    const text = String(v);
    return /<consumer-agent-system-instructions>|<consumer-context>|<latest-user-request>/.test(text) || text.length > 300
      ? "[redacted harness prompt]"
      : text.slice(0, 120);
  });
  if (typeof redacted.command === "string" && redacted.command.includes("base64 -d")) redacted.command = "[redacted instruction-file write]";
  if (redacted.text && String(redacted.text).length > 160) redacted.text = String(redacted.text).slice(0, 160) + "…";
  const entry = {
    ts: new Date().toISOString(),
    runId: serverRunId,
    requestId,
    audit: "turn-event",
    userId: input.userId,
    conversationId: input.conversationId,
    messageHash: createHash("sha256").update(input.message).digest("hex").slice(0, 16),
    messagePreview: input.message.slice(0, 160),
    event: redacted,
  };
  rememberAudit(entry);
  console.log(JSON.stringify(entry));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(html());
    }

    if (req.method === "GET" && url.pathname === "/api/harnesses") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(
        JSON.stringify({
          harnesses: harnessInfo(),
          env: {
            BOX_API_KEY: Boolean(serverBoxApiKey),
            ANTHROPIC_API_KEY: keyAvailable("anthropic"),
            OPENAI_API_KEY: keyAvailable("openai"),
            OPENROUTER_API_KEY: keyAvailable("openrouter"),
          },
          serverKeysAllowed: allowServerKeys,
          credentialMode: allowServerKeys ? "server-or-byok" : "byok-required",
          runtimeFeasibility: RUNTIME_FEASIBILITY,
          boxAgent: "disabled (assertNoBoxAgent guard)",
          pricing: BOX_PRICING,
        }),
      );
    }

    if (req.method === "GET" && url.pathname === "/api/diagnostics") {
      const format = url.searchParams.get("format") ?? "json";
      const payload = {
        runId: serverRunId,
        generatedAt: new Date().toISOString(),
        eventCount: auditRing.length,
        audit: auditRing,
      };
      if (format === "jsonl") {
        res.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "content-disposition": `attachment; filename="optibox-diagnostics-${serverRunId}.jsonl"`,
        });
        return void res.end(auditRing.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      }
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="optibox-diagnostics-${serverRunId}.json"`,
      });
      return void res.end(JSON.stringify(payload, null, 2));
    }

    // Live restricted-mode proof: exercise the shared capabilities and show denials.
    if (req.method === "POST" && url.pathname === "/api/restricted-proof") {
      const caps = createRestrictedSharedCapabilities();
      const results: { action: string; denied: boolean; message: string }[] =
        [];
      for (const [action, call] of [
        ["readFile(/etc/passwd)", () => caps.readFile("/etc/passwd")],
        ["bash(id)", () => caps.bash("id")],
        ["writeFile(proof.txt)", () => caps.writeFile("proof.txt", "x")],
        ["controlComputer(click)", () => caps.controlComputer("click 0 0")],
      ] as const) {
        try {
          await call();
          results.push({
            action,
            denied: false,
            message: "UNEXPECTEDLY ALLOWED",
          });
        } catch (e) {
          results.push({
            action,
            denied: true,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ results }));
    }

    if (req.method === "POST" && url.pathname === "/api/send") {
      const body = await readBody(req);
      const send = sse(res);
      const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const selection = {
        harness: String(body.harness),
        provider: String(body.provider),
        model: String(body.model),
      };
      const credentials = credentialsFromBody(body);
      try {
        const configError = credentialError(selection, credentials);
        if (configError) {
          send({ type: "error", message: configError });
          send({ type: "stream.end" });
          return void res.end();
        }
        const orchestrator = orchestratorFor(credentials);
        const turnInput = {
          userId: String(body.userId ?? "user-a"),
          conversationId: String(body.conversationId ?? "conv-1"),
          message: String(body.message ?? ""),
          selection,
        };
        const receivedEvent: ConsumerTurnEvent = {
          type: "trace",
          stage: "backend.request.received",
          message: "POST /api/send reached backend; SSE stream opened",
          harness: selection.harness,
          model: selection.model,
          data: {
            runId: serverRunId,
            requestId,
            credentialSource: credentials.source,
          },
        };
        auditEvent(receivedEvent, turnInput, requestId);
        send(receivedEvent);
        for await (const event of orchestrator.runTurn(turnInput)) {
          auditEvent(event as ConsumerTurnEvent, turnInput, requestId);
          send(event as ConsumerTurnEvent);
        }
        send({ type: "stream.end" });
      } catch (e) {
        send({
          type: "error",
          message: e instanceof Error ? (e.stack ?? e.message) : String(e),
        });
      }
      return void res.end();
    }

    // Stop streams the full lifecycle (stopping -> archiving -> archived) and the
    // exact moment billing pauses.
    if (req.method === "POST" && url.pathname === "/api/stop") {
      const body = await readBody(req);
      const send = sse(res);
      try {
        const credentials = credentialsFromBody(body);
        if (!credentials.boxApiKey) {
          send({ type: "error", message: allowServerKeys ? "BOX_API_KEY is not configured." : "Open Settings (gear) and paste BOX_API_KEY before pausing a BYOK Box." });
          send({ type: "stream.end" });
          return void res.end();
        }
        const orchestrator = orchestratorFor(credentials);
        for await (const event of orchestrator.stopUserBox(
          String(body.userId ?? "user-a"),
          String(body.conversationId ?? "conv-1"),
        )) {
          send(event as ConsumerTurnEvent);
        }
        send({ type: "stream.end" });
      } catch (e) {
        send({
          type: "error",
          message: e instanceof Error ? (e.stack ?? e.message) : String(e),
        });
      }
      return void res.end();
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: e instanceof Error ? (e.stack ?? e.message) : String(e),
      }),
    );
  }
});

server.listen(port, "0.0.0.0", () =>
  console.log(`interactive proof server on 0.0.0.0:${port}`),
);

function html() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>Box chat demo</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fff;color:#111;line-height:1.4;font-weight:400}
*{box-sizing:border-box}html,body{height:100%;margin:0}
/* Uniform scale-up: zoom enlarges text and elements together, preserving every
   aspect ratio (supported in Chrome/Edge/Safari and Firefox 126+). Viewport
   units are scaled by zoom too, so every dvh sizing divides by --z or the page
   would overflow the real viewport by 15%. */
html{zoom:1.15;--z:1.15}body{min-height:calc(100dvh/var(--z));background:#fff}body.hide-traces .msg.trace{display:none}
.shell{height:calc(100dvh/var(--z));max-width:1180px;margin:0 auto;display:grid;grid-template-columns:minmax(380px,560px) 330px;gap:24px;align-items:stretch;padding:0 24px}.app{height:calc(100dvh/var(--z));min-width:0;display:flex;flex-direction:column;background:#fff;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0}
.top{position:sticky;top:0;z-index:2;background:rgba(255,255,255,.96);backdrop-filter:blur(12px);border-bottom:1px solid #e0e0e0;padding:calc(14px + env(safe-area-inset-top)) 16px 14px;display:grid;gap:12px}
.counters{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}.counter{border:0;background:#f6f6f6;padding:11px 12px;min-width:0;border-radius:10px}.label{display:block;color:#555;letter-spacing:.01em;font-size:12px;font-weight:400}.value{display:block;margin-top:3px;font:400 21px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.state{border:0;background:transparent;color:#9a9a9a;padding:1px 2px;font-size:11px;font-weight:400;text-align:center;letter-spacing:.02em;display:flex;align-items:center;justify-content:center;gap:7px}.state:before{content:"";width:6px;height:6px;border-radius:50%;background:#cdcdcd;flex:0 0 auto;transition:background .3s ease}body[data-busy="1"] .state:before{background:#f4b93e}body[data-billing="1"] .state:before{background:#fc4b55;box-shadow:0 0 0 3px rgba(252,75,85,.16)}
.composerBar{display:none;gap:8px;align-items:center;flex-wrap:wrap;padding:9px 16px calc(11px + env(safe-area-inset-bottom));background:#fff;border-top:1px solid #f0f0f0}.composerBar button,.composerBar .traceToggle{min-height:32px;background:#fff;color:#6a6a6a;border:1px solid #e6e6e6;padding:0 11px;font-weight:400;font-size:11px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;border-radius:8px;transition:border-color .15s ease,color .15s ease}.composerBar button:hover,.composerBar .traceToggle:hover{border-color:#c9c9c9;color:#111}.traceToggle{cursor:pointer}.traceToggle input{accent-color:#111}.iconButton{width:36px;justify-content:center;padding:0!important;font-size:16px}.iconButton svg{width:16px;height:16px;display:block}.composerBar .iconButton{width:32px;font-size:14px;margin-left:auto}.settingsBackdrop{position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.36);display:none;align-items:center;justify-content:center;padding:18px}.settingsBackdrop.open{display:flex}.settingsDialog{width:min(560px,100%);max-height:calc(92dvh/var(--z));overflow:auto;background:#fff;border:1px solid #111;padding:18px;color:#111;border-radius:16px}.settingsHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}.settingsHead h2{margin:0;font-size:20px;font-weight:400;letter-spacing:-.02em}.settingsHead p{margin:4px 0 0;color:#555;font-size:12px}.settingsDialog label{display:grid;gap:5px;margin-top:10px;font-size:12px;color:#555}.settingsDialog input,.settingsDialog select{width:100%;border:1px solid #d9d9d9;background:#fff;color:#111;min-height:38px;padding:8px 10px;font:inherit;font-size:13px;border-radius:9px}.settingsDialog input:focus,.settingsDialog select:focus{outline:none;border-color:#111}.settingsGrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.settingsNote{margin-top:12px;border:1px solid #e0e0e0;background:#f6f6f6;padding:10px 12px;font-size:12px;color:#333;border-radius:8px}.settingsActions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}.settingsActions button.secondary{background:#fff;color:#111;border:1px solid #d9d9d9}.settingsStatus{font-size:12px;color:#555;margin-top:8px}.dangerText{color:#9f1239}.okText{color:#166534}
.chat{flex:1;overflow:auto;padding:18px 16px 20px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}.empty{margin:auto;color:#555;text-align:center;font-size:14px;max-width:280px}.msg{max-width:86%;padding:11px 13px;font-size:15px;white-space:pre-wrap;overflow-wrap:anywhere;font-weight:400;border:1px solid transparent;border-radius:14px}.msg.user{align-self:flex-end;background:#111;color:#fff;border-bottom-right-radius:5px}.msg.assistant{align-self:flex-start;background:#f6f6f6;color:#111;border-color:#e0e0e0;border-bottom-left-radius:5px}.msg.trace{align-self:flex-start;background:#fff;border:1px dashed #d9d9d9;color:#555;font-size:12px;max-width:92%;padding:8px 10px;border-radius:10px}.msg .body code{background:rgba(0,0,0,.08);padding:1px 5px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}.msg.user .body code{background:rgba(255,255,255,.18)}.msg .body pre{background:#101418;color:#e6edf3;padding:10px 12px;border-radius:5px;overflow-x:auto;margin:6px 0;white-space:pre}.msg .body pre code{background:none;padding:0;color:inherit}.msg .body .mdh{display:inline-block;font-size:1.05em}.msg .body .mdli{display:inline-block;padding-left:16px;position:relative}.msg .body .mdli:before{content:'•';position:absolute;left:4px;color:#999}.msg .body a{color:inherit;text-decoration:underline}.tag{display:block;margin-bottom:4px;color:#555;letter-spacing:.01em;font-size:10px;font-weight:400}.msg.user .tag{color:#d9d9d9}.msg.trace .tag{color:#777}
.toolChain{align-self:flex-start;max-width:92%;width:100%;font-size:13px;color:#555}.toolChainSummary{position:relative;min-height:24px;display:flex;align-items:center;gap:6px;padding:0;cursor:pointer;user-select:none;outline:none}.toolChainSummary:focus-visible{text-decoration:underline}.toolChainLabel{display:inline-block;transition:transform .16s ease}.toolChainLabel.bump{transform:translateY(-2px)}.toolChainEllipsis{display:inline-block;min-width:18px}.toolChain.running .toolChainEllipsis::after{content:'…';animation:toolEllipsis 1.1s steps(4,end) infinite}.toolChainChevron{margin-left:auto;opacity:0;transition:opacity .12s ease,transform .12s ease}.toolChain:hover .toolChainChevron,.toolChain.open .toolChainChevron,.toolChainSummary:focus-visible .toolChainChevron{opacity:1}.toolChain.open .toolChainChevron{transform:rotate(90deg)}.working{align-self:flex-start;color:#777;font-size:13px;padding:6px 2px;display:flex;align-items:center;gap:6px}.working::after{content:'…';display:inline-block;min-width:16px;animation:toolEllipsis 1.1s steps(4,end) infinite}
.toolChainDetails{display:none;margin:6px 0 2px 14px;color:#333}.toolChain.open .toolChainDetails{display:grid;gap:6px}.toolCallDetail{font-size:12px;line-height:1.35}.toolCallHead{color:#111}.toolCallMeta{color:#555;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:2px}.toolCallOutput{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#444;max-height:180px;overflow:auto}@keyframes toolEllipsis{0%{content:''}25%{content:'.'}50%{content:'..'}75%,100%{content:'...'}}
.composer{position:relative;display:block;padding:16px;border-top:1px solid #e0e0e0;background:rgba(255,255,255,.97);backdrop-filter:blur(12px)}textarea{width:100%;min-height:58px;max-height:140px;resize:none;border:0;background:#f6f6f6;color:#111;padding:13px 42px 13px 15px;font:inherit;font-weight:400;outline:none;display:block;border-radius:16px}textarea:focus{background:#f0f0f0}button{min-height:42px;border:0;background:#111;color:#fff;padding:0 16px;font:inherit;font-weight:400;cursor:pointer;border-radius:9px}button:disabled{opacity:.5;cursor:not-allowed}/* Concentric with the textarea's 16px corner: the corner arc's center sits 16px
   in from the right/bottom edges, so a circle centered there with r=13 keeps a
   uniform 3px gap to both straight edges AND the arc. Offsets = composer pad 16
   + corner R 16 - button r 13 = 19px. */
#send{position:absolute;right:19px;bottom:19px;width:26px;height:26px;min-height:26px;padding:0;background:transparent;color:#8a8a8a;border:0;border-radius:50%;display:flex;align-items:center;justify-content:center;transition:background .15s ease,color .15s ease}#send:hover,#send:focus-visible{background:#fc4b55;color:#fff}#send svg{width:14px;height:14px;display:block}
.schematic{align-self:center;border:1px solid #e0e0e0;background:#fff;padding:20px;color:#111;border-radius:16px}.schematic h2{font-family:"Funnel Display",Inter,ui-sans-serif,system-ui,sans-serif;font-size:20px;line-height:1.15;letter-spacing:-.02em;margin:0 0 18px;color:#111;font-weight:400}
.route{position:relative;display:grid;gap:0}
.node{position:relative;z-index:1;border:0;background:#f6f6f6;padding:12px 13px;border-radius:9px;transition:background .25s ease,color .25s ease}.node .nodeTitle{display:block;font-size:14px;font-weight:400;color:inherit}.node .nodeSub{display:block;margin-top:3px;color:#666;font-size:11.5px;font-weight:400}
.node[data-active="1"]{background:#111;color:#fff}.node[data-active="1"] .nodeSub{color:#e4e4e4}
.node[data-proc="1"]{animation:nodePulse 1.5s ease-out infinite}@keyframes nodePulse{0%{box-shadow:0 0 0 0 rgba(252,75,85,.5)}100%{box-shadow:0 0 0 11px rgba(252,75,85,0)}}
.node.user-node[data-deliver="1"]{border-color:#16a34a;background:#16a34a;color:#fff}.node.user-node[data-deliver="1"] .nodeSub{color:#e4ffe9}
.toolsLine{display:none;margin-top:8px;font-size:11px;color:#ffd7da;align-items:center;gap:5px}.toolsLine:before{content:"";width:5px;height:5px;border-radius:50%;background:#fc4b55;box-shadow:0 0 0 3px rgba(252,75,85,.3)}.toolsLine:after{content:'…';min-width:12px;animation:toolEllipsis 1.1s steps(4,end) infinite}.node[data-tools="1"] .toolsLine{display:flex}
.path{position:relative;height:30px;display:flex;align-items:center;justify-content:center}.path .arrow{position:absolute;top:-1px;bottom:-1px;left:50%;width:2px;background:#e0e0e0;transform:translateX(-50%)}.path .arrow:after{content:"";position:absolute;left:50%;bottom:3px;width:6px;height:6px;border-right:2px solid #e0e0e0;border-bottom:2px solid #e0e0e0;transform:translateX(-50%) rotate(45deg)}.path .pathLabel{position:relative;z-index:1;background:#fff;padding:0 8px;color:#a6a6a6;font-size:10.5px;letter-spacing:.02em}
.packet{position:absolute;left:0;top:0;z-index:3;line-height:1;transform:translate(-50%,-50%);opacity:0;transition:top .45s cubic-bezier(.5,0,.2,1),left .45s cubic-bezier(.5,0,.2,1),opacity .25s ease;pointer-events:none;color:#111;background:#fff;border:1px solid #e0e0e0;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center}.packet svg{width:14px;height:14px;display:block}.packet[data-kind="ok"]{color:#1a7f37;border-color:#1a7f37}.packet[data-kind="warn"]{color:#b54708;border-color:#b54708}
.routeCaption{margin-top:14px;min-height:15px;font-size:11px;font-weight:400;color:#a0a0a0;line-height:1.4}.schematic[data-route="error"] .routeCaption{color:#9f1239}
@media(max-width:900px){.shell{display:block;height:calc(100dvh/var(--z));padding:0}.schematic{display:none}.app{max-width:720px;margin:0 auto}}
@media(max-width:520px){.app{max-width:none;border:0}.top{padding-left:10px;padding-right:10px}.chat{padding-left:10px;padding-right:10px}.composer{padding-left:10px;padding-right:10px}.counter{padding:10px}.value{font-size:18px}.state{font-size:12px;line-height:1.25}.msg{max-width:90%;font-size:14px}.label{font-size:11px}button{padding:0 14px}#send{right:13px}}
</style></head><body class="hide-traces"><div class="shell">
<main class="app">
  <header class="top" aria-label="machine summary">
    <section class="counters" aria-label="totals">
      <div class="counter"><span class="label">total spent</span><span class="value" id="totalCost">$0.000000</span></div>
      <div class="counter"><span class="label">machine time</span><span class="value" id="totalSeconds">0.0s</span></div>
      <div class="counter"><span class="label">auto-stop</span><span class="value" id="autoStopTimer">idle</span></div>
    </section>
    <div class="state" id="machineState">shared bridge ready · private machine stopped</div>
  </header>
  <section class="chat" id="chat" aria-live="polite"><div class="empty" id="empty">Send a message to start the demo.</div></section>
  <form class="composer" id="composer">
    <textarea id="msg" placeholder="Message…" aria-label="Message"></textarea>
    <button id="send" type="submit" aria-label="Send" title="Send"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M227.32,28.68a16,16,0,0,0-15.66-4.08l-.15,0L19.57,82.84a16,16,0,0,0-2.49,29.8L102,154l41.3,84.87A15.86,15.86,0,0,0,157.74,248q.69,0,1.38-.06a15.88,15.88,0,0,0,14-11.51l58.2-191.94c0-.05,0-.1,0-.15A16,16,0,0,0,227.32,28.68ZM157.83,231.85l-.05.14,0-.07-40.06-82.3,48-48a8,8,0,0,0-11.31-11.31l-48,48L24.08,98.25l-.07,0,.14,0L216,40Z"/></svg></button>
  </form>
  <footer class="composerBar" aria-label="controls">
    <button id="stopBox" type="button">Pause Box now</button>
    <button id="downloadDiagnostics" type="button">Download diagnostics</button>
    <label class="traceToggle"><input id="showTraces" type="checkbox"/> Show traces</label>
    <button id="settingsOpen" class="iconButton" type="button" aria-label="Settings" title="Settings"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M237.94,107.21a8,8,0,0,0-3.89-5.4l-29.83-17-.12-33.62a8,8,0,0,0-2.83-6.08,111.91,111.91,0,0,0-36.72-20.67,8,8,0,0,0-6.46.59L128,41.85,97.88,25a8,8,0,0,0-6.47-.6A111.92,111.92,0,0,0,54.73,45.15a8,8,0,0,0-2.83,6.07l-.15,33.65-29.83,17a8,8,0,0,0-3.89,5.4,106.47,106.47,0,0,0,0,41.56,8,8,0,0,0,3.89,5.4l29.83,17,.12,33.63a8,8,0,0,0,2.83,6.08,111.91,111.91,0,0,0,36.72,20.67,8,8,0,0,0,6.46-.59L128,214.15,158.12,231a7.91,7.91,0,0,0,3.9,1,8.09,8.09,0,0,0,2.57-.42,112.1,112.1,0,0,0,36.68-20.73,8,8,0,0,0,2.83-6.07l.15-33.65,29.83-17a8,8,0,0,0,3.89-5.4A106.47,106.47,0,0,0,237.94,107.21ZM128,168a40,40,0,1,1,40-40A40,40,0,0,1,128,168Z"/></svg></button>
  </footer>
</main>
<aside class="schematic" id="schematic" data-route="idle" aria-label="backend flow diagram">
  <h2>Backend</h2>
  <div class="route" id="routeFlow">
    <div class="packet" id="packet" data-kind="mail" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M224,48H32a8,8,0,0,0-8,8V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48ZM203.43,64,128,133.15,52.57,64ZM216,192H40V74.19l82.59,75.71a8,8,0,0,0,10.82,0L216,74.19V192Z"/></svg></div>
    <div class="node user-node" data-node="you"><span class="nodeTitle">You</span><span class="nodeSub">the message, and the answer that comes back</span></div>
    <div class="path to-shared"><span class="arrow"></span><span class="pathLabel">fast path</span></div>
    <div class="node shared-node" data-node="shared"><span class="nodeTitle">Shared infra</span><span class="nodeSub">instant answer, or a holding line while tools warm up</span></div>
    <div class="path to-private"><span class="arrow"></span><span class="pathLabel">handoff</span></div>
    <div class="node private-node" data-node="private"><span class="nodeTitle">User machine</span><span class="nodeSub">private Box · tools + billing</span><span class="toolsLine">using tools</span></div>
  </div>
  <div class="routeCaption" id="routeStatus" aria-live="polite"></div>
</aside>
</div>
<div class="settingsBackdrop" id="settingsBackdrop" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
  <section class="settingsDialog">
    <div class="settingsHead">
      <div><h2 id="settingsTitle">Demo settings</h2><p>Choose harness/model and bring your own keys for public/dev previews.</p></div>
      <button id="settingsClose" class="iconButton" type="button" aria-label="Close settings">×</button>
    </div>
    <div class="settingsGrid">
      <label>Harness<select id="settingsHarness"></select></label>
      <label>Model<select id="settingsModel"></select></label>
    </div>
    <label>BOX_API_KEY<input id="settingsBoxKey" type="password" autocomplete="off" placeholder="bx_…"/></label>
    <label>ANTHROPIC_API_KEY<input id="settingsAnthropicKey" type="password" autocomplete="off" placeholder="sk-ant-…"/></label>
    <label>OPENAI_API_KEY<input id="settingsOpenaiKey" type="password" autocomplete="off" placeholder="sk-…"/></label>
    <label>OPENROUTER_API_KEY<input id="settingsOpenrouterKey" type="password" autocomplete="off" placeholder="sk-or-…"/></label>
    <div class="settingsNote" id="settingsNote">Loading credential mode…</div>
    <div class="settingsStatus" id="settingsStatus"></div>
    <div class="settingsActions"><button id="settingsClear" class="secondary" type="button">Clear BYOK</button><button id="settingsSave" type="button">Save</button></div>
  </section>
</div>
<script>
let H=[]; let PRICING=null; let HARNESS_META={serverKeysAllowed:false,credentialMode:'byok-required',env:{}}; let selectedHarness='', selectedProvider='', selectedModel='', selectedUser=(new URLSearchParams(location.search).get('userId')||'user-a'), selectedConversation=(new URLSearchParams(location.search).get('conversationId')||('conv-'+Math.random().toString(36).slice(2,10)));
let timer=null, billSince=0, billRate=0, billing=false, totalSeconds=0;
let autoStopInterval=null, autoStopDeadline=0, autoStopBoxId=null;
const $=id=>document.getElementById(id);
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
const SETTINGS_KEY='optibox.demo.settings.v1';
function readSettings(){try{return JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}')||{};}catch{return {};}}
function writeSettings(next){localStorage.setItem(SETTINGS_KEY,JSON.stringify(next));}
function has(v){return typeof v==='string'&&v.trim().length>0;}
function clientProviderKeyAvailable(provider){const s=readSettings();if(provider==='anthropic')return has(s.anthropicApiKey)||Boolean(HARNESS_META.env&&HARNESS_META.env.ANTHROPIC_API_KEY);if(provider==='openrouter')return has(s.openrouterApiKey)||Boolean(HARNESS_META.env&&HARNESS_META.env.OPENROUTER_API_KEY);return has(s.openaiApiKey)||Boolean(HARNESS_META.env&&HARNESS_META.env.OPENAI_API_KEY);}
function clientBoxKeyAvailable(){const s=readSettings();return has(s.boxApiKey)||Boolean(HARNESS_META.env&&HARNESS_META.env.BOX_API_KEY);}
function currentApiKeys(){const s=readSettings();return {boxApiKey:s.boxApiKey||'',anthropicApiKey:s.anthropicApiKey||'',openaiApiKey:s.openaiApiKey||'',openrouterApiKey:s.openrouterApiKey||''};}
function selectedModelOption(){const h=H.find(x=>x.name===selectedHarness);return h&&h.models.find(m=>m.provider===selectedProvider&&m.model===selectedModel);}
function currentSettingsStatus(){const model=selectedModelOption();if(!clientBoxKeyAvailable())return {ok:false,msg:'BOX_API_KEY required for this preview.'};if(model&&!clientProviderKeyAvailable(model.provider))return {ok:false,msg:(model.requiredEnv||'Provider key')+' required for '+(model.label||model.model)+'.'};return {ok:true,msg:HARNESS_META.serverKeysAllowed&&!Object.values(currentApiKeys()).some(Boolean)?'Using private server keys for this preview.':'BYOK credentials ready.'};}
function updateSettingsStatus(){const st=currentSettingsStatus();const el=$('settingsStatus');if(el){el.className='settingsStatus '+(st.ok?'okText':'dangerText');el.textContent=st.msg;}if(!st.ok)setState('Settings required · '+st.msg);}
function renderSettingsControls(){const hs=$('settingsHarness'), ms=$('settingsModel');if(!hs||!ms)return;hs.innerHTML=H.map(h=>'<option value="'+esc(h.name)+'">'+esc(h.name)+'</option>').join('');hs.value=selectedHarness;const h=H.find(x=>x.name===selectedHarness);ms.innerHTML=(h?h.models:[]).map(m=>'<option value="'+esc(m.provider+'|'+m.model)+'">'+esc((m.label||m.model)+' · '+m.requiredEnv+(clientProviderKeyAvailable(m.provider)?' ✓':''))+'</option>').join('');ms.value=selectedProvider+'|'+selectedModel;updateSettingsStatus();}
function openSettings(){const s=readSettings();if(!$('settingsBackdrop')||!$('settingsBoxKey'))return;$('settingsBoxKey').value=s.boxApiKey||'';$('settingsAnthropicKey').value=s.anthropicApiKey||'';$('settingsOpenaiKey').value=s.openaiApiKey||'';$('settingsOpenrouterKey').value=s.openrouterApiKey||'';renderSettingsControls();$('settingsBackdrop').classList.add('open');$('settingsHarness').focus();}
function closeSettings(){if($('settingsBackdrop'))$('settingsBackdrop').classList.remove('open');}
function saveSettings(){writeSettings({boxApiKey:$('settingsBoxKey').value.trim(),anthropicApiKey:$('settingsAnthropicKey').value.trim(),openaiApiKey:$('settingsOpenaiKey').value.trim(),openrouterApiKey:$('settingsOpenrouterKey').value.trim(),harness:selectedHarness,provider:selectedProvider,model:selectedModel});renderSettingsControls();updateSettingsStatus();closeSettings();}
function clearSettings(){writeSettings({harness:selectedHarness,provider:selectedProvider,model:selectedModel});$('settingsBoxKey').value='';$('settingsAnthropicKey').value='';$('settingsOpenaiKey').value='';$('settingsOpenrouterKey').value='';renderSettingsControls();}
const hiddenContextPattern=new RegExp('<consumer-context>[\\s\\S]*?</consumer-context>','g');
function stripHidden(s){return String(s).replace(hiddenContextPattern,'').trim();}
function fmtUsd(n){return '$'+n.toFixed(6);}
const routeState={phase:'idle',boxId:null,billing:false,finalRoute:null,done:false};
function setRoute(route,text){const r=$('routeStatus');if(r)r.textContent=text||'';}
// The Backend diagram is painted from routeState alone: one function decides which
// node is lit, whether it is "processing", where the packet sits, and when the
// answer is delivered back to You. A single message emoji travels the arrows.
function diagramStage(){const p=routeState.phase,box=routeState.boxId;
  if(routeState.done)return {owner:box?'private':'shared',packet:'you',deliver:true};
  if(p==='error')return {owner:'private',packet:'private',error:true};
  if(!p||(p==='idle'&&!box))return {owner:null,packet:'you',hidden:true};
  if(p==='accepted')return {owner:'shared',packet:'shared',proc:true,traveling:true};
  if(p==='shared-bridge'||p==='shared')return {owner:'shared',packet:'shared',proc:true};
  if(p==='shared-delta')return {owner:'shared',packet:'you',deliver:true};
  if(p==='handoff')return {owner:'private',packet:'private',traveling:true};
  if(['starting','provisioning','provisioned','cloning','resuming','resume-timeout'].includes(p))return {owner:'private',packet:'private',proc:true};
  if(p==='tools')return {owner:'private',packet:'private',proc:true,tools:true};
  if(p==='user-box')return {owner:'private',packet:'you',deliver:true};
  if(['ready','running','billing','runtime-proof'].includes(p)||(p==='idle'&&box))return {owner:'private',packet:'private',proc:true};
  return {owner:'shared',packet:'shared',proc:true};}
function paintDiagram(){const s=$('schematic'),packet=$('packet');if(!s||!packet||!packet.style)return;const d=diagramStage();
  const nodes={you:s.querySelector('.user-node'),shared:s.querySelector('.shared-node'),private:s.querySelector('.private-node')};
  for(const k in nodes){const n=nodes[k];if(!n)continue;n.dataset.active=(d.owner===k)?'1':'0';n.dataset.proc=(d.proc&&d.owner===k)?'1':'0';n.dataset.tools=(d.tools&&k==='private')?'1':'0';n.dataset.deliver=(d.deliver&&k==='you')?'1':'0';}
  s.dataset.route=d.error?'error':(d.owner==='private'?'private':d.owner==='shared'?'shared':'idle');
  const target=nodes[d.packet||'you'];if(target){packet.style.left=(target.offsetLeft+target.offsetWidth)+'px';packet.style.top=target.offsetTop+'px';}
  packet.style.opacity=d.hidden?'0':'1';
  var kind=d.deliver?'ok':d.error?'warn':'mail';
  if(packet.dataset.kind!==kind){packet.dataset.kind=kind;packet.innerHTML=PACKET_ICONS[kind];}}
var PACKET_ICONS={
mail:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M224,48H32a8,8,0,0,0-8,8V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48ZM203.43,64,128,133.15,52.57,64ZM216,192H40V74.19l82.59,75.71a8,8,0,0,0,10.82,0L216,74.19V192Z"/></svg>',
ok:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z"/></svg>',
warn:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM222.93,203.8a8.5,8.5,0,0,1-7.48,4.2H40.55a8.5,8.5,0,0,1-7.48-4.2,7.59,7.59,0,0,1,0-7.72L120.52,44.21a8.75,8.75,0,0,1,15,0l87.45,151.87A7.59,7.59,0,0,1,222.93,203.8ZM120,144V104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,180Z"/></svg>'};
function setState(text){$('machineState').textContent=text;}
function fmtAutoStopRemaining(ms){return Math.max(0,Math.ceil(ms/1000))+'s';}
function clearAutoStopTimer(label){autoStopDeadline=0;autoStopBoxId=null;if(autoStopInterval){clearInterval(autoStopInterval);autoStopInterval=null;}$('autoStopTimer').textContent=label||'idle';}
function renderAutoStopTimer(){if(!autoStopDeadline){$('autoStopTimer').textContent='idle';return;}const remaining=Math.max(0,autoStopDeadline-Date.now());$('autoStopTimer').textContent=fmtAutoStopRemaining(remaining);if(remaining<=0&&autoStopInterval){clearInterval(autoStopInterval);autoStopInterval=null;}}
function startAutoStopTimer(ev){autoStopDeadline=ev.deadlineEpochMs||(Date.now()+Math.max(0,ev.remainingMs||0));autoStopBoxId=ev.boxId||autoStopBoxId;renderAutoStopTimer();if(autoStopInterval)clearInterval(autoStopInterval);autoStopInterval=setInterval(renderAutoStopTimer,200);}
function describeAutoStop(ev){const remaining=fmtAutoStopRemaining(ev.remainingMs||0);if(ev.phase==='started'||ev.phase==='tick')return 'Assistant done · user idle · Box auto-stops in '+remaining;if(ev.phase==='stopping')return 'Auto-stop countdown reached 0s · stopping Box now';if(ev.phase==='canceled')return 'Auto-stop timer reset · new message is using the Box';return ev.note||'Auto-stop timer updated';}
function boxLabel(id){return id&&id!=='pending'?' · '+id:'';}
function resetRouteForTurn(){clearAutoStopTimer('paused');routeState.phase='accepted';routeState.boxId=null;routeState.billing=false;routeState.finalRoute=null;routeState.done=false;setRoute('shared','message accepted · checking Box state, opening the shared bridge');paintDiagram();}
function routeIsPrivate(){return Boolean(routeState.boxId)||['billing','starting','provisioning','provisioned','cloning','resuming','ready','idle','running','handoff','runtime-proof','tools','user-box'].includes(routeState.phase);}
function routeEvent(ev){_routeEvent(ev);if(ev.type==='turn.done')routeState.done=true;paintDiagram();}
function _routeEvent(ev){
  if(ev.type==='stream.end')return;
  if(ev.type==='error'||ev.type==='turn.blocked'){routeState.phase='error';setRoute('error','Route error: private runtime did not complete; see trace for the real event.');return;}
  if(ev.type==='trace'&&/backend|submit/.test(ev.stage||'')){routeState.phase='accepted';setRoute('shared','Route: backend accepted the message; shared bridge is live while Box status resolves.');return;}
  if(ev.type==='trace'&&ev.stage==='route.direct'){routeState.phase='user-box';setRoute('private','Route: private Box is warm; message routed directly to it (no shared bridge).');return;}
  if(ev.type==='trace'&&ev.stage==='shared.bridge.start'){if(routeIsPrivate()){setRoute('private','Route: shared agent is answering first while private Box status continues'+boxLabel(routeState.boxId)+'.');return;}routeState.phase='shared-bridge';setRoute('shared','Route: shared agent answers first while the private Box starts/resumes.');return;}
  if(ev.type==='context.injected'&&ev.scope==='shared'){if(routeIsPrivate()){setRoute('private','Route: private Box is active'+boxLabel(routeState.boxId)+'; shared bridge is only covering latency.');return;}routeState.phase='shared';setRoute('shared','Route: shared infra is answering while the private Box boots in parallel.');return;}
  if(ev.type==='shared.delta'&&routeState.phase!=='handoff'&&routeState.phase!=='user-box'){if(routeIsPrivate()){setRoute('private','Route: private Box path is active'+boxLabel(routeState.boxId)+'; shared text is just the bridge response.');return;}routeState.phase='shared-delta';setRoute('shared','Route: shared infra is streaming the bridge response; private Box events will take over when ready.');return;}
  if(ev.type==='billing.start'){routeState.boxId=ev.boxId||routeState.boxId;routeState.billing=true;routeState.phase='billing';setRoute('private','Route: private Box billing is live'+boxLabel(routeState.boxId)+'; handoff/runtime events are active.');return;}
  if(ev.type==='lifecycle'){routeState.boxId=ev.boxId||routeState.boxId;const state=String(ev.state||'');
    if(['starting','provisioning','provisioned','cloning','resuming'].includes(state)){routeState.phase=state;setRoute('private','Route: private Box is '+state+boxLabel(routeState.boxId)+'; waiting for ready/handoff events.');return;}
    if(['ready','idle','running'].includes(state)){routeState.phase=state;setRoute('private','Route: private Box is '+state+boxLabel(routeState.boxId)+'; user-machine runtime is taking this turn.');return;}
    if(state==='resume-timeout'){routeState.phase=state;setRoute('private','Route: previous Box resume timed out; starting a fresh private Box.');return;}
    if(['stopping','archiving','archived','none'].includes(state)){routeState.phase=state;setRoute('private','Route: private Box is '+state+boxLabel(routeState.boxId)+'; billing state is being reconciled.');return;}
  }
  if(ev.type==='handoff.started'){routeState.boxId=ev.boxId||routeState.boxId;routeState.phase='handoff';setRoute('private','Route: handoff started on the user machine'+boxLabel(routeState.boxId)+'; tools are available.');return;}
  if(ev.type==='runtime.proof'){routeState.boxId=ev.boxId||routeState.boxId;routeState.phase='runtime-proof';setRoute('private','Route: confirmed in-Box '+ev.harness+' runtime'+boxLabel(routeState.boxId)+'; streaming='+String(ev.streaming||'unknown')+'.');return;}
  if(ev.type==='exec'||ev.type==='harness.tool'){routeState.boxId=ev.boxId||routeState.boxId;routeState.phase='tools';setRoute('private','Route: private Box runtime is using tools'+boxLabel(routeState.boxId)+'.');return;}
  if(ev.type==='user-box.delta'){routeState.boxId=ev.boxId||routeState.boxId;routeState.phase='user-box';setRoute('private','Route: user-machine answer is streaming'+boxLabel(routeState.boxId)+'.');return;}
  if(ev.type==='billing.stop'){routeState.boxId=ev.boxId||routeState.boxId;routeState.billing=false;setRoute('private','Route: billing paused for private Box'+boxLabel(routeState.boxId)+'.');return;}
  if(ev.type==='autostop.timer'){routeState.boxId=ev.boxId||routeState.boxId;if(ev.phase==='canceled'){setRoute('private','Route: auto-stop reset because a newer message arrived; countdown restarts after the active answer.');}else if(ev.phase==='stopping'){setRoute('private','Route: visible auto-stop countdown reached zero; stopping private Box'+boxLabel(routeState.boxId)+'.');}else{setRoute('private','Route: assistant finished and user is idle; auto-stop in '+fmtAutoStopRemaining(ev.remainingMs||0)+boxLabel(routeState.boxId)+'.');}return;}
  if(ev.type==='turn.done'){routeState.boxId=ev.boxId||routeState.boxId;routeState.finalRoute=ev.route||null;const route=ev.route||((ev.boxId||routeState.phase==='user-box'||routeState.phase==='handoff')?'user-box':'shared');const routeLabel=route==='bridge'?'private Box bridge':route==='direct'?'warm private Box':route==='user-box'?'user-machine':route;setRoute(route==='shared'?'shared':'private',route==='shared'?'Route: turn completed on shared infra; no stale private waiting state.':'Route: turn completed via '+routeLabel+' runtime'+boxLabel(routeState.boxId)+'.');return;}
}
function activeSeconds(){return totalSeconds+(billing?(Date.now()-billSince)/1000:0);}
function renderTotals(){const seconds=activeSeconds();$('totalSeconds').textContent=seconds.toFixed(1)+'s';$('totalCost').textContent=fmtUsd(seconds*billRate);}
async function load(){const r=await fetch('/api/harnesses');const j=await r.json();H=j.harnesses;PRICING=j.pricing;HARNESS_META={serverKeysAllowed:j.serverKeysAllowed===undefined?true:Boolean(j.serverKeysAllowed),credentialMode:j.credentialMode||(j.serverKeysAllowed===false?'byok-required':'server-or-byok'),env:j.env||{BOX_API_KEY:true,ANTHROPIC_API_KEY:H.some(h=>h.models.some(m=>m.provider==='anthropic'&&m.keyAvailable)),OPENAI_API_KEY:H.some(h=>h.models.some(m=>m.provider==='openai'&&m.keyAvailable)),OPENROUTER_API_KEY:H.some(h=>h.models.some(m=>m.provider==='openrouter'&&m.keyAvailable))}};billRate=PRICING.ratePerSecond;chooseDefaultModel();renderSettingsControls();const note=$('settingsNote');if(note)note.textContent=HARNESS_META.serverKeysAllowed?'Private preview: configured server keys are available; BYOK overrides them.':'Public/dev preview: server keys are disabled. Add your own Box and model provider keys.';renderTotals();paintDiagram();if(!currentSettingsStatus().ok)openSettings();}
function chooseDefaultModel(){const saved=readSettings();const savedHarness=H.find(h=>h.name===saved.harness);const savedModel=savedHarness&&savedHarness.models.find(m=>m.provider===saved.provider&&m.model===saved.model);if(savedHarness&&savedModel&&clientProviderKeyAvailable(savedModel.provider)){selectedHarness=savedHarness.name;selectedProvider=savedModel.provider;selectedModel=savedModel.model;return;}const preferred=H.find(h=>h.models.some(m=>clientProviderKeyAvailable(m.provider)))||H[0];if(!preferred){setState('No harnesses available');return;}const model=preferred.models.find(m=>clientProviderKeyAvailable(m.provider))||preferred.models[0];selectedHarness=preferred.name;selectedProvider=model.provider;selectedModel=model.model;if(!clientProviderKeyAvailable(model.provider)||!clientBoxKeyAvailable())setState('Waiting for BYOK settings · private machine stopped');}
const bubbles=new Map();
// ONE working indicator, owned by the latest turn. Concurrent/superseded turns
// never create a second one (fixes the double "working…"). It is shown while the
// latest turn is unanswered and removed the moment that turn reaches a terminal
// event — never by an older, still-draining turn.
let workingEl=null;
function showWorking(){const c=$('chat');$('empty')?.remove();if(!workingEl){workingEl=document.createElement('div');workingEl.className='working';workingEl.textContent='working';}c.appendChild(workingEl);c.scrollTop=c.scrollHeight;}
function moveWorkingToBottom(){if(workingEl)$('chat').appendChild(workingEl);}
function clearWorking(){if(workingEl){workingEl.remove();workingEl=null;}}
let showTraces=false;
function syncTraceVisibility(){document.body.classList.toggle('hide-traces',!showTraces);}
// Markdown-lite. RegExp-from-string only: this script text must parse BOTH as
// the served page and inside the source-level regression harness, and regex
// literals with backslashes cannot be valid at both escape levels.
function md(t){let s=esc(t);
s=s.replace(new RegExp('\`\`\`[A-Za-z]*\\\\n?([\\\\s\\\\S]*?)\`\`\`','g'),function(_,c){return '<pre><code>'+c.replace(new RegExp('\\\\n$'),'')+'</code></pre>';});
s=s.replace(new RegExp('\`([^\`\\\\n]+)\`','g'),'<code>$1</code>');
s=s.replace(new RegExp('\\\\*\\\\*([^*]+)\\\\*\\\\*','g'),'<strong>$1</strong>');
s=s.replace(new RegExp('(^|[\\\\s(])\\\\*([^*\\\\n]+)\\\\*(?=[\\\\s).,!?:;]|$)','g'),'$1<em>$2</em>');
s=s.replace(new RegExp('\\\\[([^\\\\]]+)\\\\]\\\\((https?:[^)\\\\s]+)\\\\)','g'),'<a href="$2" target="_blank" rel="noopener">$1</a>');
s=s.replace(new RegExp('^#{1,6}\\\\s+(.+)$','gm'),'<strong class="mdh">$1</strong>');
s=s.replace(new RegExp('^[ ]*(?:[-*]|[0-9]+[.])[ ]+(.+)$','gm'),'<span class="mdli">$1</span>');
s=s.replace(new RegExp('\\\\n?(<pre>)','g'),'$1').replace(new RegExp('(</pre>)\\\\n?','g'),'$1');
return s;}
function addMsg(cls,tag,text,key){if(cls!=='trace')currentToolChain=null;const c=$('chat');$('empty')?.remove();key=key||('seq:'+Date.now()+Math.random()+':'+cls);let el=bubbles.get(key);if(!el){el=document.createElement('div');el.className='msg '+cls;el.innerHTML=(tag?'<div class="tag">'+esc(tag)+'</div>':'')+'<div class="body"></div>';c.appendChild(el);bubbles.set(key,el);}const body=el.querySelector('.body');const raw=stripHidden((body.dataset.raw||'')+text);body.dataset.raw=raw;body.textContent=raw;if(cls==='assistant'||cls==='user')body.innerHTML=md(raw);moveWorkingToBottom();c.scrollTop=c.scrollHeight;return el;}
const toolChains=[];
let currentToolChain=null;
let toolSeq=0;
function toolLabel(count){return count+' tool call'+(count===1?'':'s');}
function isToolFinished(call){return call.state==='finished'||call.state==='error';}
function compactToolText(value,limit){const text=String(value||'').trim();if(!text)return '';return text.length>limit?text.slice(0,limit)+'…':text;}
function toolTitle(call){return call.toolName||'tool';}
function toolStateFromEvent(ev){if(ev.isError)return 'error';if(ev.phase==='tool_result')return ev.isError?'error':'finished';if(ev.stdout||ev.stderr)return ev.isError?'error':'finished';return 'running';}
function findRunningTool(){for(let i=toolChains.length-1;i>=0;i--){const chain=toolChains[i];for(let j=chain.calls.length-1;j>=0;j--){if(!isToolFinished(chain.calls[j]))return chain.calls[j];}}return null;}
function ensureToolChain(localId){const c=$('chat');$('empty')?.remove();if(currentToolChain)return currentToolChain;const id='tool-chain:'+(localId||'turn')+':'+toolChains.length+':'+Date.now();const el=document.createElement('div');el.className='toolChain';el.setAttribute('data-tool-chain-id',id);el.innerHTML='<div class="toolChainSummary" role="button" tabindex="0" aria-expanded="false"><span class="toolChainLabel">0 tool calls</span><span class="toolChainEllipsis" aria-hidden="true"></span><span class="toolChainChevron" aria-hidden="true">›</span></div><div class="toolChainDetails"></div>';const summary=el.querySelector('.toolChainSummary');summary.addEventListener('click',()=>toggleToolChain(chain));summary.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggleToolChain(chain);}});c.appendChild(el);const chain={id,el,summary,label:el.querySelector('.toolChainLabel'),details:el.querySelector('.toolChainDetails'),calls:[],open:false,lastCount:0};toolChains.push(chain);currentToolChain=chain;moveWorkingToBottom();c.scrollTop=c.scrollHeight;return chain;}
function toggleToolChain(chain){chain.open=!chain.open;chain.el.classList.toggle('open',chain.open);chain.summary.setAttribute('aria-expanded',String(chain.open));}
function renderToolChain(chain){const count=chain.calls.length;chain.label.textContent=toolLabel(count);if(count!==chain.lastCount){chain.label.classList.remove('bump');void chain.label.offsetWidth;chain.label.classList.add('bump');setTimeout(()=>chain.label.classList.remove('bump'),180);chain.lastCount=count;}const running=chain.calls.some(c=>!isToolFinished(c));chain.el.classList.toggle('running',running);chain.details.innerHTML=chain.calls.map((call,idx)=>{const status=call.state==='error'?'error':(isToolFinished(call)?'finished':'running');const bits=[];if(call.command)bits.push('command: '+compactToolText(call.command,300));if(call.description)bits.push('description: '+compactToolText(call.description,300));if(call.stderr)bits.push('stderr: '+compactToolText(call.stderr,800));const out=call.stdout?'<pre class="toolCallOutput">'+esc(compactToolText(call.stdout,2000))+'</pre>':'';return '<div class="toolCallDetail"><div class="toolCallHead">'+(idx+1)+'. '+esc(toolTitle(call))+' · '+esc(status)+'</div>'+(bits.length?'<div class="toolCallMeta">'+esc(bits.join('\\n'))+'</div>':'')+out+'</div>';}).join('');$('chat').scrollTop=$('chat').scrollHeight;}
function addToolEvent(ev,localId){let chain=currentToolChain;if(ev.phase==='tool_result'){const running=findRunningTool();if(running){Object.assign(running,{state:toolStateFromEvent(ev),stdout:ev.stdout||running.stdout||'',stderr:ev.stderr||running.stderr||'',isError:Boolean(ev.isError),resultSeen:true});const owner=toolChains.find(ch=>ch.calls.includes(running));if(owner)renderToolChain(owner);return owner&&owner.el;}}
chain=ensureToolChain(localId);const call={id:'tool-'+(++toolSeq),toolName:ev.toolName||'tool',command:ev.command||'',description:ev.description||'',stdout:ev.stdout||'',stderr:ev.stderr||'',isError:Boolean(ev.isError),state:toolStateFromEvent(ev),resultSeen:ev.phase==='tool_result'};chain.calls.push(call);renderToolChain(chain);return chain.el;}
function startBilling(sinceMs){if(!billing){billing=true;billSince=sinceMs||Date.now();if(!timer)timer=setInterval(renderTotals,100);}document.body.dataset.billing='1';setState('private machine running · tools active · billing live');renderTotals();}
function stopBilling(elapsed){if(billing){totalSeconds+=(elapsed!=null&&elapsed>0)?elapsed:(Date.now()-billSince)/1000;billing=false;}if(timer){clearInterval(timer);timer=null;}delete document.body.dataset.billing;clearAutoStopTimer('stopped');setState('private machine stopped · billing paused');renderTotals();}
const activeTurns=new Map();
// The most recently sent turn. Only its events drive the side diagram and the
// working indicator, so overlapping turns (rapid <30s sends, interrupt semantics)
// can't desync the graph or leave a stale indicator.
let latestLocalId=null;
function abortInterruptibleSharedTurns(){for(const [id,t] of activeTurns){if(t.interruptible&&!t.boxStarted)t.controller.abort();}}
function newTurnId(){try{return (globalThis.crypto&&globalThis.crypto.randomUUID)?globalThis.crypto.randomUUID():String(Date.now()+Math.random());}catch{return String(Date.now()+Math.random());}}
async function runTurn(msg){clearAutoStopTimer('paused');abortInterruptibleSharedTurns();const localId=newTurnId();latestLocalId=localId;const controller=new AbortController();activeTurns.set(localId,{controller,interruptible:false,boxStarted:false});document.body.dataset.busy='1';addMsg('user','',msg,'user:'+localId);showWorking();setState('shared bridge starting · private Box boot requested');resetRouteForTurn();try{const res=await fetch('/api/send',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({userId:selectedUser,conversationId:selectedConversation,message:msg,harness:selectedHarness,provider:selectedProvider,model:selectedModel,apiKeys:currentApiKeys()})});await drain(res,localId);}catch(e){if(e.name!=='AbortError'){addMsg('assistant','error','Something went wrong: '+String(e&&e.message||e));setState('Error · private machine state unchanged');}}finally{if(localId===latestLocalId)clearWorking();activeTurns.delete(localId);if(activeTurns.size===0)delete document.body.dataset.busy;}}
const composer=$('composer'), msgEl=$('msg'), sendBtn=$('send');
const stopBtn=$('stopBox');
const diagnosticsBtn=$('downloadDiagnostics');
const showTracesEl=$('showTraces');
if(showTracesEl){showTracesEl.checked=false;showTracesEl.addEventListener('change',()=>{showTraces=Boolean(showTracesEl.checked);syncTraceVisibility();});}
$('settingsOpen')?.addEventListener('click',openSettings);$('settingsClose')?.addEventListener('click',closeSettings);$('settingsSave')?.addEventListener('click',saveSettings);$('settingsClear')?.addEventListener('click',clearSettings);$('settingsBackdrop')?.addEventListener('click',e=>{if(e.target===$('settingsBackdrop'))closeSettings();});$('settingsHarness')?.addEventListener('change',e=>{selectedHarness=e.target.value;const h=H.find(x=>x.name===selectedHarness);const m=h&&h.models[0];if(m){selectedProvider=m.provider;selectedModel=m.model;}renderSettingsControls();});$('settingsModel')?.addEventListener('change',e=>{const [provider,model]=String(e.target.value).split('|');selectedProvider=provider;selectedModel=model;renderSettingsControls();});
syncTraceVisibility();
let lastSubmitAt=0;
function submitComposer(source){
  const text=msgEl.value.trim();
  console.debug('[trace] submit event fired', {source, hasText:Boolean(text), harness:selectedHarness, model:selectedModel});
  if(!text){console.debug('[trace] empty submit ignored', {source});return false;}
  const st=currentSettingsStatus();
  if(!st.ok){addMsg('trace','settings required',st.msg+'\\n');openSettings();return false;}
  const now=Date.now();
  if(now-lastSubmitAt<150){console.debug('[trace] duplicate submit suppressed', {source});return false;}
  lastSubmitAt=now;
  addMsg('trace','submit trace','submit event fired from '+source+' · request starting\\n');
  msgEl.value='';
  msgEl.focus();
  runTurn(text);
  return true;
}
composer.addEventListener('submit',e=>{e.preventDefault();submitComposer('form.submit');});
sendBtn.addEventListener('click',e=>{e.preventDefault();submitComposer('button.click');});
stopBtn.addEventListener('click',async e=>{e.preventDefault();stopBtn.disabled=true;addMsg('trace','manual stop','pause request sent for this conversation\\n');setState('Private machine stopping · manual pause requested');try{const res=await fetch('/api/stop',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:selectedUser,conversationId:selectedConversation,apiKeys:currentApiKeys()})});await drain(res,newTurnId());}catch(err){addMsg('assistant','error','Stop failed: '+String(err&&err.message||err));}finally{stopBtn.disabled=false;}});
diagnosticsBtn?.addEventListener('click',e=>{e.preventDefault();const a=document.createElement('a');a.href='/api/diagnostics?format=json';a.download='optibox-diagnostics.json';document.body.appendChild(a);a.click();a.remove();addMsg('trace','diagnostics','downloaded redacted JSON event log from /api/diagnostics\\n');});
msgEl.addEventListener('keydown',e=>{if((e.key==='Enter'||e.code==='Enter'||e.keyCode===13||e.which===13)&&!e.shiftKey){e.preventDefault();submitComposer('textarea.enter');}});
msgEl.addEventListener('beforeinput',e=>{if((e.inputType==='insertLineBreak'||e.inputType==='insertParagraph')&&!e.shiftKey){e.preventDefault();submitComposer('textarea.beforeinput');}});
async function drain(res,localId){if(!res){throw new Error('No response object from /api/send');}if(!res.ok){const body=await res.text().catch(()=>'');throw new Error('/api/send failed with HTTP '+res.status+' '+body);}if(!res.body){throw new Error('/api/send did not return a readable SSE body');}const reader=res.body.getReader();const dec=new TextDecoder();const sep=String.fromCharCode(10,10);const nl=String.fromCharCode(10);let buf='';while(true){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const parts=buf.split(sep);buf=parts.pop()||'';for(const p of parts){const line=p.split(nl).find(l=>l.startsWith('data:'));if(!line)continue;handle(JSON.parse(line.slice(5)),localId);}}}
function keyFor(ev,localId,cls){return (ev.turnId||localId)+':'+cls+(ev.messageId?':msg:'+ev.messageId:(ev.messageIndex!=null?':msg:'+ev.messageIndex:''));}
function handle(ev,localId){console.debug('[trace] stream event', ev);const isLatest=(localId===latestLocalId);
  // Only the latest turn's events drive the side diagram — otherwise a still-draining
  // older turn's box/billing events fight the newest turn's route and the graph desyncs.
  if(isLatest)routeEvent(ev);
  const t=activeTurns.get(localId);if(t&&['handoff.started','billing.start','user-box.delta','exec'].includes(ev.type)){t.boxStarted=true;t.interruptible=false;}
  // "working…" stays until the LATEST turn is fully finished: both surfaces answered
  // (or the box chose <end>) and the stream reached its terminal event. An older
  // turn reaching a terminal event must NOT clear the newest turn's indicator.
  if(isLatest&&(ev.type==='turn.done'||ev.type==='turn.blocked'||ev.type==='error'||ev.type==='stream.end'))clearWorking();
  if(ev.type==='trace'){addMsg('trace','trace · '+(ev.stage||'event'),(ev.message||JSON.stringify(ev))+'\\n',keyFor(ev,localId,'trace')+':'+(ev.stage||Math.random()));if(/bridge/.test(ev.stage||''))setState('Shared bridge active · private Box booting');else if(/backend|submit/.test(ev.stage||''))setState('Request received · shared bridge starting');}
  else if(ev.type==='turn.blocked'){addMsg('assistant','error',(ev.stage?'['+ev.stage+'] ':'')+(ev.message||'private runtime failed'),keyFor(ev,localId,'blocked')+':'+(ev.stage||Math.random()));setState('Private runtime error · see message');}
  else if(ev.type==='shared.delta'){addMsg('assistant','shared infra · no tools',ev.text,keyFor(ev,localId,'shared'));}
  else if(ev.type==='context.injected'){if(ev.scope==='shared')setState('Shared bridge ready · private Box booting in parallel');}
  else if(ev.type==='billing.start'){startBilling(ev.sinceEpochMs);}
  else if(ev.type==='lifecycle'){if(ev.state==='resume-timeout')setState('Resume timed out · starting a fresh machine');else if(ev.state==='stopping')setState('Private machine stopping · wrapping up');else if(ev.state==='archiving')setState('Private machine archiving · billing about to pause');else if(ev.state==='archived')setState('Private machine archived · billing paused');else setState('Private machine '+String(ev.state).replace(/-/g,' '));}
  else if(ev.type==='handoff.started'){setState('Private machine running · assistant has tools');}
  else if(ev.type==='runtime.proof'){addMsg('trace','proof · no Box prompt/API','boxPromptApiUsed='+ev.boxPromptApiUsed+' · boxBuiltInAgentUsed='+ev.boxBuiltInAgentUsed+' · hostAsciiAgentUsed='+ev.hostAsciiAgentUsed+' · continuation='+ev.continuation+' · streaming='+(ev.streaming||'unknown')+(ev.blocker?' · limitation: '+ev.blocker:'' )+'\\n',keyFor(ev,localId,'proof'));}
  else if(ev.type==='exec'){setState('Private machine running · using tools');if(ev.kind==='harness')addMsg('trace','source path','Started real '+((ev.argv&&ev.argv[0])||'agent')+' harness inside the user machine; stdout/SSE relays native chunks as emitted.',keyFor(ev,localId,'exec'));}
  else if(ev.type==='harness.tool'){setState('Private machine running · using tools');addToolEvent(ev,localId);}
  else if(ev.type==='user-box.delta'){addMsg('assistant','user machine · tools active',ev.text,keyFor(ev,localId,'box'));}
  else if(ev.type==='billing.stop'){stopBilling(ev.elapsedSeconds);}
  else if(ev.type==='autostop.timer'){if(ev.phase==='started'||ev.phase==='tick'){startAutoStopTimer(ev);}else if(ev.phase==='stopping'){clearAutoStopTimer('0s');}else if(ev.phase==='canceled'){clearAutoStopTimer('reset');}addMsg('trace','auto-stop',describeAutoStop(ev)+' · '+(ev.note||'')+'\\n',keyFor(ev,localId,'autostop')+':'+ev.phase+':'+Math.ceil((ev.remainingMs||0)/1000));setState(describeAutoStop(ev));}
  else if(ev.type==='turn.done'){setState('Turn complete · waiting for visible auto-stop countdown');}
  else if(ev.type==='error'){addMsg('assistant','error','Error: '+ev.message);setState('Error · check model credentials or machine state');}}
if(typeof window!=='undefined')window.addEventListener('resize',paintDiagram);
load();
</script></body></html>`;
}
