/**
 * The Agents setup a USER owns on their own machine: which harness/model runs
 * their private turns, and the credentials those harnesses authenticate with.
 *
 * ONE list describes every credential: its id (the wire name), where it lands on
 * the box (an env var, or a home-relative file), and how the UI labels it. The
 * engine, the HTTP routes and the browser panel all read this list, so adding a
 * provider is a one-line change here.
 *
 * Two shapes exist because the harnesses take two shapes of secret:
 *   env  — API keys and the Claude subscription token (`claude setup-token`
 *          prints it; Claude Code reads it ONLY from CLAUDE_CODE_OAUTH_TOKEN).
 *   file — a Codex ChatGPT subscription, which is the contents of
 *          ~/.codex/auth.json; codex resolves that path itself, nothing else.
 */

export interface AgentCredentialSpec {
  /** Wire name, used by the routes and the UI. */
  id: string;
  label: string;
  hint: string;
  /** Env var this credential becomes inside the box. */
  env?: string;
  /** Home-relative file this credential becomes inside the box. */
  file?: string;
  /** Render as a textarea (file contents) instead of a password input. */
  multiline?: boolean;
}

export const AGENT_CREDENTIALS: AgentCredentialSpec[] = [
  { id: "anthropicApiKey", label: "Anthropic API key", hint: "sk-ant-…", env: "ANTHROPIC_API_KEY" },
  { id: "openaiApiKey", label: "OpenAI API key", hint: "sk-…", env: "OPENAI_API_KEY" },
  { id: "openrouterApiKey", label: "OpenRouter API key", hint: "sk-or-…", env: "OPENROUTER_API_KEY" },
  { id: "llmgatewayApiKey", label: "llmgateway key", hint: "llmgtwy_…", env: "LLMGATEWAY_API_KEY" },
  { id: "claudeSubscription", label: "Claude Pro/Max subscription", hint: "run `claude setup-token`, paste the sk-ant-oat01-… it prints", env: "CLAUDE_CODE_OAUTH_TOKEN" },
  { id: "codexSubscription", label: "Codex ChatGPT subscription", hint: "contents of ~/.codex/auth.json from a machine where you ran `codex login`", file: ".codex/auth.json", multiline: true },
];

export const agentCredentialById = (id: string): AgentCredentialSpec | undefined =>
  AGENT_CREDENTIALS.find((c) => c.id === id);

/** The user's default harness/model, overridable per message by the composer. */
export interface UserAgentSelection {
  harness?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}

/** One credential as the UI sees it: connected or not, never the secret. */
export interface AgentCredentialState {
  id: string;
  label: string;
  hint: string;
  kind: "env" | "file";
  /** Env var name or home-relative file path this credential lands as. */
  target: string;
  multiline: boolean;
  connected: boolean;
  /** Last 4 characters of the stored value; "" when not connected. */
  last4: string;
}

export interface UserAgentsView {
  selection: UserAgentSelection;
  credentials: AgentCredentialState[];
  /** true when the user has at least one credential of their own. */
  usingOwnKeys: boolean;
  /** true when new keys are stored but the (parked) box has not picked them up yet. */
  envPending: boolean;
}

/** A patch of secret values: "" clears a field, an absent field is unchanged. */
export type AgentCredentialPatch = Record<string, string>;

/** Split a credential patch into the box's env vars and its home-relative files. */
export function splitCredentialPatch(patch: AgentCredentialPatch): {
  providerEnv: Record<string, string>;
  agentFiles: Record<string, string>;
} {
  const providerEnv: Record<string, string> = {};
  const agentFiles: Record<string, string> = {};
  for (const [id, raw] of Object.entries(patch)) {
    const spec = agentCredentialById(id);
    if (!spec || typeof raw !== "string") continue;
    const value = spec.multiline ? raw.trim() : raw.trim();
    if (spec.env) providerEnv[spec.env] = value;
    else if (spec.file) agentFiles[spec.file] = value;
  }
  return { providerEnv, agentFiles };
}

/** The read-only view of what a user has connected — secrets never leave here. */
export function agentCredentialStates(providerEnv: Record<string, string>, agentFiles: Record<string, string>): AgentCredentialState[] {
  return AGENT_CREDENTIALS.map((spec) => {
    const value = spec.env ? providerEnv[spec.env] : spec.file ? agentFiles[spec.file] : undefined;
    const connected = typeof value === "string" && value.length > 0;
    return {
      id: spec.id,
      label: spec.label,
      hint: spec.hint,
      kind: spec.env ? "env" : "file",
      target: spec.env ?? spec.file ?? "",
      multiline: Boolean(spec.multiline),
      connected,
      last4: connected ? (value as string).slice(-4) : "",
    };
  });
}

/** Apply a patch to a stored map: "" deletes, absent leaves alone. */
export function applyPatch(stored: Record<string, string>, patch?: Record<string, string>): Record<string, string> {
  const next = { ...stored };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (typeof v !== "string") continue;
    if (v) next[k] = v; else delete next[k];
  }
  return next;
}

export const sameMap = (a: Record<string, string>, b: Record<string, string>): boolean =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
