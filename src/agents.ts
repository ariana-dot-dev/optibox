import { codexAuthJson, type OAuthProvider, type OAuthTokens } from "./oauth.js";

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
 *   env  - API keys and the Claude subscription token (Claude Code reads it
 *          ONLY from CLAUDE_CODE_OAUTH_TOKEN).
 *   file - a Codex ChatGPT subscription, which is the contents of
 *          ~/.codex/auth.json; codex resolves that path itself, nothing else.
 *
 * A credential is either signed in to (`oauth`) or typed in (an API key). The
 * panel groups them that way: subscriptions first, keys behind a fold.
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
  /** Set when the credential is obtained by signing in, not by typing a key. */
  oauth?: OAuthProvider;
  /** Which section of the panel the credential belongs to. */
  group: "subscription" | "key";
}

export const AGENT_CREDENTIALS: AgentCredentialSpec[] = [
  { id: "claudeSubscription", label: "Claude Pro/Max", hint: "", env: "CLAUDE_CODE_OAUTH_TOKEN", oauth: "claude", group: "subscription" },
  { id: "codexSubscription", label: "ChatGPT", hint: "", file: ".codex/auth.json", oauth: "codex", group: "subscription" },
  { id: "anthropicApiKey", label: "Anthropic", hint: "sk-ant-…", env: "ANTHROPIC_API_KEY", group: "key" },
  { id: "openaiApiKey", label: "OpenAI", hint: "sk-…", env: "OPENAI_API_KEY", group: "key" },
  { id: "openrouterApiKey", label: "OpenRouter", hint: "sk-or-…", env: "OPENROUTER_API_KEY", group: "key" },
  { id: "llmgatewayApiKey", label: "llmgateway", hint: "llmgtwy_…", env: "LLMGATEWAY_API_KEY", group: "key" },
];

export const agentCredentialById = (id: string): AgentCredentialSpec | undefined =>
  AGENT_CREDENTIALS.find((c) => c.id === id);

export const subscriptionSpec = (provider: OAuthProvider): AgentCredentialSpec =>
  AGENT_CREDENTIALS.find((c) => c.oauth === provider) as AgentCredentialSpec;

/** The user's default harness/model, overridable per message by the composer. */
export interface UserAgentSelection {
  harness?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}

/**
 * What we keep server-side for one connected subscription. The access token
 * itself lives with the other credentials (it is what the box runs on); this is
 * the part the box never sees.
 */
export interface AgentOAuthRecord {
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  /** ChatGPT only. */
  accountId?: string;
  connectedAt?: number;
}
export type AgentOAuthState = Partial<Record<OAuthProvider, AgentOAuthRecord>>;

/** One credential as the UI sees it: connected or not, never the secret. */
export interface AgentCredentialState {
  id: string;
  label: string;
  hint: string;
  kind: "env" | "file";
  /** Env var name or home-relative file path this credential lands as. */
  target: string;
  group: "subscription" | "key";
  /** "claude" / "codex" for the sign-in credentials, "" for typed keys. */
  oauth: string;
  connected: boolean;
  /** Last 4 characters of the stored value; "" when not connected. */
  last4: string;
  /** One short human fact about a connected subscription, or "". */
  detail: string;
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
    const value = raw.trim();
    if (spec.env) providerEnv[spec.env] = value;
    else if (spec.file) agentFiles[spec.file] = value;
  }
  return { providerEnv, agentFiles };
}

/**
 * What a freshly signed-in subscription becomes on the box.
 *
 * Claude Code authenticates from CLAUDE_CODE_OAUTH_TOKEN. Codex authenticates
 * from ~/.codex/auth.json and nothing else, so the token is written as that
 * file; CHATGPT_ACCOUNT_ID rides along because the box's own bring-up helper
 * reads it when it rewrites the file.
 */
export function subscriptionCredentials(provider: OAuthProvider, tokens: OAuthTokens): {
  providerEnv: Record<string, string>;
  agentFiles: Record<string, string>;
} {
  if (provider === "claude") {
    return { providerEnv: { CLAUDE_CODE_OAUTH_TOKEN: tokens.accessToken }, agentFiles: {} };
  }
  const accountId = tokens.accountId ?? "";
  return {
    providerEnv: { CHATGPT_ACCOUNT_ID: accountId },
    agentFiles: { ".codex/auth.json": codexAuthJson(tokens.accessToken, accountId) },
  };
}

/** Clearing a subscription clears everything it put on the box. */
export function subscriptionClear(provider: OAuthProvider): {
  providerEnv: Record<string, string>;
  agentFiles: Record<string, string>;
} {
  return provider === "claude"
    ? { providerEnv: { CLAUDE_CODE_OAUTH_TOKEN: "" }, agentFiles: {} }
    : { providerEnv: { CHATGPT_ACCOUNT_ID: "" }, agentFiles: { ".codex/auth.json": "" } };
}

/** The read-only view of what a user has connected. Secrets never leave here. */
export function agentCredentialStates(
  providerEnv: Record<string, string>,
  agentFiles: Record<string, string>,
  oauth: AgentOAuthState = {},
): AgentCredentialState[] {
  return AGENT_CREDENTIALS.map((spec) => {
    const value = spec.env ? providerEnv[spec.env] : spec.file ? agentFiles[spec.file] : undefined;
    const connected = typeof value === "string" && value.length > 0;
    const record = spec.oauth ? oauth[spec.oauth] : undefined;
    const account = record?.accountId;
    return {
      id: spec.id,
      label: spec.label,
      hint: spec.hint,
      kind: spec.env ? "env" : "file",
      target: spec.env ?? spec.file ?? "",
      group: spec.group,
      oauth: spec.oauth ?? "",
      connected,
      last4: connected ? (value as string).slice(-4) : "",
      detail: connected && account ? `account ····${account.slice(-4)}` : "",
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
