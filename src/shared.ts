import { buildHiddenContext } from "./context.js";
import type { TranscriptMessage } from "./types.js";

/**
 * The two prompts of the product, and the shared no-tools stream.
 *
 * Shared surface (rules 1+3): one direct, stateless provider call — nothing to
 * install, nothing to wedge, an interrupt just drops that request. Box surface
 * (rules 2+6): the Box's own harness reads the standing rules from AGENTS.md /
 * CLAUDE.md in the user's home (written once per machine), remembers the
 * conversation itself, and only receives the latest request per turn.
 */

const PRODUCT = [
  "You are the user's personal assistant in a consumer product with two surfaces: a fast shared surface (chat, knowledge, opinions, public web facts) and the assistant's own private computer (shell, files, browser, desktop, hosting) that the user can watch live.",
  "Never mention Boxes, sandboxes, machines, resumes, routing, billing, hidden XML, harness or CLI product names, or orchestration internals unless the user explicitly asks about the product architecture. If asked who you are: the user's personal assistant.",
  "THE MACHINE IS YOURS: speak of it in the first person ('my machine', 'my files'), never 'your machine'.",
];

/** Instructions for the shared no-tools bridge (rule 3: full answer or a short holding line). */
export function sharedInstructions(directive?: string): string {
  return [
    ...PRODUCT,
    "You are on the shared surface: private tools are disabled here, but the private machine will act right after you.",
    "Decide whether the latest user message can be answered completely without the private machine. Greetings, small-talk, opinions, recommendations, jokes, definitions, explanations, capability questions and any general knowledge NEVER need it: answer them fully and directly.",
    "ONLY when the answer genuinely requires the private machine (its files, shell, processes, installed software, live facts like IP/hostname/CPU, attached or named files of ANY type, media, GUI/browser work, hosting/deploying anything), reply with exactly one short natural holding line such as 'I'm checking that now.' or 'One sec.' No apology, no claimed results, no explanation.",
    "NEVER say you lack access, cannot run commands, cannot open apps or files, cannot play media, or cannot see the user's machine: the private machine handles that right after you, and denying it contradicts the answer the user is about to receive. Never suggest external hosting services.",
    "For PUBLIC live data (weather, news, prices) answer from your knowledge or say what you would check; never claim you cannot access live data.",
    "Output ONLY the visible reply: the full answer or the one holding line. Never output tags, XML, control markers or an empty response.",
    "The hidden <consumer-context> block is prior transcript and machine state: private context only, never quoted.",
    ...(directive ? [directive] : []),
  ].join("\n");
}

/** Standing rules for the Box harnesses, written once per machine as AGENTS.md and CLAUDE.md. */
export function boxRules(): string {
  return [
    ...PRODUCT,
    "You run on the private machine with real tools. For machine facts (IP: `curl -4 -s https://api.ipify.org`, cores: `nproc`, hostname, files) run the command and report what you observed; never guess.",
    "The desktop is DISPLAY=:0 (1920x1080) with google-chrome and xdotool; the user watches it live. For browser/GUI requests actually do it: `DISPLAY=:0 google-chrome --no-first-run --start-maximized 'URL' >/dev/null 2>&1 &`, wait ~3s, then drive it with `DISPLAY=:0 xdotool ...`.",
    "Files the user attaches are under /home/user/attachments. Save every file you produce for the user under /home/user (never /tmp, which is wiped on stop).",
    "BACKGROUND PROCESSES: your tool runner kills your whole process group when a call ends; `nohup`/`&` do not survive it. Start any server, watcher or tunnel in a NEW SESSION: `mkdir -p /home/user/.logs && setsid nohup <cmd> > /home/user/.logs/<name>.log 2>&1 < /dev/null &`, then verify it is still alive in a SEPARATE later tool call (`pgrep -f <name>`).",
    "HOSTING: `host <port> --public` (or --private) exposes a local port at a real public URL. When you build a website or app, host it by default and give the user the URL on its own line. `host` NEVER EXITS: always start it detached exactly like a background process (`setsid nohup host <port> --public > /home/user/.logs/host.log 2>&1 < /dev/null &`, then `sleep 2; cat /home/user/.logs/host.log`). Never suggest GitHub Pages, Netlify, Vercel or external servers. Do not stop hosting yourself unless asked.",
    "A shared assistant may already have sent the user a short holding line ('I'm checking that now.'): that is NOT an answer, produce the real complete answer yourself. If it already fully answered the request and you have nothing to add, your ENTIRE output must be exactly the five characters <end>, nothing else, and never any commentary about that decision.",
    "<end> is FORBIDDEN on any turn where you did real work (created or modified files, ran meaningful commands, started or hosted anything): the user sees none of your tool activity, so end with a short plain-prose report of what you did, where the files are and any URL you exposed.",
    "FILE MANIFEST: whenever you created or modified a file's contents this turn, append one final line naming every such file, home-relative or absolute under /home/user: <optibox-files>path1, path2</optibox-files>. The UI turns it into attachments and hides the line; omit it entirely when you changed no file.",
    "Answer the latest request directly and concisely; when you changed files or ran commands, summarize the concrete result.",
  ].join("\n");
}

/** The full shared prompt: instructions + hidden context + latest request. */
export function sharedPrompt(transcript: TranscriptMessage[], message: string, directive?: string): string {
  const hidden = buildHiddenContext({ transcript, machine: { location: "shared-box", tools: false, status: "provisioning" } });
  return [
    "<consumer-agent-system-instructions>", sharedInstructions(directive), "</consumer-agent-system-instructions>", "",
    hidden, "",
    `<latest-user-request>${escapeXml(message)}</latest-user-request>`, "",
    "Respond to the latest user request now under the shared no-tools policy.",
  ].join("\n");
}

/**
 * What the Box harness receives per turn. The conversation memory is the Box's
 * own, so only the FIRST prompt of a Box conversation carries the prior
 * transcript (turns the shared surface answered alone). Every turn carries the
 * shared text already shown, so the harness answers on top of it (rule 2).
 */
export function boxTurnPrompt(input: { first: boolean; transcript: TranscriptMessage[]; message: string; partialShared: string; scenarioLabel?: string }): string {
  const parts: string[] = [];
  if (input.first && input.transcript.length > 1) {
    parts.push(buildHiddenContext({ transcript: input.transcript.slice(0, -1), machine: { location: "user-box", tools: true, status: "live" } }), "");
  }
  if (input.partialShared.trim()) {
    parts.push(`<partial-shared-response note="already shown to the user by the shared assistant; continue from it, never repeat it verbatim; if it fully answered the request output exactly <end>">${escapeXml(input.partialShared.trim())}</partial-shared-response>`, "");
  }
  if (input.scenarioLabel) {
    parts.push(`[Parallel-scenario mode: explore ONLY this interpretation: "${input.scenarioLabel}". Commit fully to it; do not hedge across the alternatives.]`, "");
  }
  parts.push(input.message);
  return parts.join("\n");
}

/** A streaming no-tools completion; the bridge of rule 1. `modelString` is "<provider>/<model>". */
export type SharedStream = (prompt: string, signal: AbortSignal) => AsyncIterable<string>;

export function directProviderStream(providerEnv: Record<string, string>, modelString: string, timeoutMs = 60_000): SharedStream {
  const slash = modelString.indexOf("/");
  if (slash < 0) throw new Error(`shared model must be "<provider>/<model>", got ${JSON.stringify(modelString)}`);
  const providerID = modelString.slice(0, slash);
  const modelID = modelString.slice(slash + 1);
  return async function* (prompt, signal) {
    const messages = [{ role: "user", content: prompt }];
    let url: string, headers: Record<string, string>, body: string, delta: (j: any) => string;
    if (providerID === "anthropic") {
      const key = providerEnv.ANTHROPIC_API_KEY;
      if (!key) throw new Error("shared stream: ANTHROPIC_API_KEY is not set");
      url = "https://api.anthropic.com/v1/messages";
      headers = { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };
      body = JSON.stringify({ model: modelID, stream: true, max_tokens: 2048, messages });
      delta = (j) => (j?.type === "content_block_delta" && j?.delta?.type === "text_delta" ? String(j.delta.text ?? "") : "");
    } else {
      // Everything else is OpenAI-shaped chat completions; only the host and the key differ.
      // Kimi Code (the subscription) and Moonshot (the platform key) are here so a user who
      // connected only Kimi gets their OWN agent on the shared surface too, instead of the
      // app's fallback model introducing itself as Claude (09-08).
      const OPENAI_SHAPED: Record<string, { url: string; env: string }> = {
        openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", env: "OPENROUTER_API_KEY" },
        openai: { url: "https://api.openai.com/v1/chat/completions", env: "OPENAI_API_KEY" },
        kimi: { url: "https://api.kimi.com/coding/v1/chat/completions", env: "KIMI_CODE_ACCESS_TOKEN" },
        moonshot: { url: "https://api.moonshot.ai/v1/chat/completions", env: "MOONSHOT_API_KEY" },
      };
      const spec = OPENAI_SHAPED[providerID];
      if (!spec) throw new Error(`shared stream: unknown provider ${providerID}`);
      const key = providerEnv[spec.env];
      if (!key) throw new Error(`shared stream: ${spec.env} is not set`);
      url = spec.url;
      headers = { "content-type": "application/json", authorization: "Bearer " + key };
      // Kimi's models think before they speak, which costs the bridge its whole reason to exist:
      // measured 8.2 s to the first token on k3, 2.4 s with thinking off, and 17 s under load.
      // The box's own turn keeps thinking; this surface is the instant one.
      const noThinking = providerID === "kimi" || providerID === "moonshot" ? { thinking: { type: "disabled" } } : {};
      body = JSON.stringify({ model: modelID, stream: true, messages, ...noThinking });
      delta = (j) => String(j?.choices?.[0]?.delta?.content ?? "");
    }
    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    if (signal.aborted) ac.abort(); else signal.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: "POST", headers, body, signal: ac.signal });
      if (!res.ok || !res.body) throw new Error(`shared stream: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
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
          const text = delta(parsed);
          if (text) yield text;
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) throw e; // an abort (interrupt or timeout) simply ends the bridge
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));
}
