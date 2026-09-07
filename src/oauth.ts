import { createHash, randomBytes } from "node:crypto";

/**
 * The two consumer sign-ins, ported from the Box product's own backend
 * (backend/src/services/claude-oauth.service.ts, codex-oauth.service.ts) so
 * optibox users connect a subscription exactly the way the Box dashboard does.
 *
 *   Claude Pro/Max  : PKCE. We build an authorize URL on claude.ai; the user
 *                     approves; Anthropic's callback page PRINTS a code; the
 *                     user pastes it back; we exchange it for tokens.
 *   ChatGPT (Codex) : OpenAI device auth. We ask for a short user code; the
 *                     user types it at auth.openai.com/codex/device; we poll
 *                     until OpenAI hands us an authorization code, then
 *                     exchange that for tokens.
 *
 * Both mint an access token that expires and a refresh token. The refresh
 * token stays server-side and is spent just before the user's box comes up.
 *
 * Everything here is pure transport: no database, no box. `fetch` and the
 * endpoint table are injectable so the suite can drive both flows against a
 * fake provider.
 */

export type OAuthProvider = "claude" | "codex";

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** ChatGPT only: the account id codex needs beside the token. */
  accountId?: string;
}

export interface DeviceStart {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  /** Seconds between polls, as the provider asks. */
  interval: number;
}

export type DevicePoll = { status: "pending" } | { status: "complete"; tokens: OAuthTokens };

export interface OAuthEndpoints {
  claudeAuthorize: string;
  claudeToken: string;
  claudeRedirect: string;
  codexDeviceCode: string;
  codexDeviceToken: string;
  codexVerify: string;
  codexToken: string;
  codexRedirect: string;
}

/** Public clients of the Claude Code and Codex CLIs; not secrets. */
export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CLAUDE_SCOPE = "org:create_api_key user:profile user:inference";

export const OAUTH_ENDPOINTS: OAuthEndpoints = {
  claudeAuthorize: "https://claude.ai/oauth/authorize",
  claudeToken: "https://console.anthropic.com/v1/oauth/token",
  claudeRedirect: "https://console.anthropic.com/oauth/code/callback",
  codexDeviceCode: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  codexDeviceToken: "https://auth.openai.com/api/accounts/deviceauth/token",
  codexVerify: "https://auth.openai.com/codex/device",
  codexToken: "https://auth.openai.com/oauth/token",
  codexRedirect: "https://auth.openai.com/deviceauth/callback",
};

/** Refresh this long before a token actually expires. */
export const OAUTH_REFRESH_BUFFER_MS = 2 * 60 * 1000;

function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return undefined;
    return JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The ChatGPT account id is a claim inside the OAuth access token itself. */
export function chatGptAccountId(accessToken: string): string | undefined {
  const claim = decodeJwtPayload(accessToken)?.["https://api.openai.com/auth"];
  if (!claim || typeof claim !== "object") return undefined;
  const id = (claim as Record<string, unknown>).chatgpt_account_id;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * The exact shape `codex login` writes. The Codex CLI and app-server
 * authenticate from ~/.codex/auth.json ONLY: they never read a token from the
 * environment, so this file IS the ChatGPT subscription on the box.
 */
export function codexAuthJson(accessToken: string, accountId: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: accessToken, access_token: accessToken, refresh_token: "", account_id: accountId },
    last_refresh: new Date().toISOString(),
  });
}

export class OAuthError extends Error {}

export class OAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly urls: OAuthEndpoints;

  constructor(opts: { fetch?: typeof fetch; endpoints?: Partial<OAuthEndpoints> } = {}) {
    this.fetchImpl = opts.fetch ?? ((...args) => fetch(...args));
    this.urls = { ...OAUTH_ENDPOINTS, ...(opts.endpoints ?? {}) };
  }

  // -------------------------------------------------------------- Claude

  /** Step 1: the URL the user approves, plus the PKCE verifier we keep. */
  startClaude(): { url: string; verifier: string } {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({
      code: "true",
      client_id: CLAUDE_CLIENT_ID,
      response_type: "code",
      redirect_uri: this.urls.claudeRedirect,
      scope: CLAUDE_SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      // Claude Code's own reference flow reuses the verifier as state.
      state: verifier,
    });
    return { url: `${this.urls.claudeAuthorize}?${params.toString()}`, verifier };
  }

  /** Step 2: the code Anthropic printed, pasted back. May arrive as "code#state". */
  async exchangeClaude(code: string, verifier: string): Promise<OAuthTokens> {
    const [actualCode, state] = code.includes("#") ? code.split("#") : [code, verifier];
    return this.claudeToken({
      code: actualCode ?? code,
      state: state || verifier,
      grant_type: "authorization_code",
      client_id: CLAUDE_CLIENT_ID,
      redirect_uri: this.urls.claudeRedirect,
      code_verifier: verifier,
    });
  }

  async refreshClaude(refreshToken: string): Promise<OAuthTokens> {
    const next = await this.claudeToken({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_CLIENT_ID });
    return { ...next, refreshToken: next.refreshToken || refreshToken };
  }

  private async claudeToken(body: Record<string, string>): Promise<OAuthTokens> {
    const res = await this.fetchImpl(this.urls.claudeToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new OAuthError(`Claude rejected the code (${res.status}). Start again and paste the newest code.`);
    const data = JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in?: number };
    if (!data.access_token) throw new OAuthError("Claude returned no access token.");
    return {
      accessToken: data.access_token,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
  }

  // -------------------------------------------------------------- ChatGPT

  /** Step 1: ask OpenAI for the short code the user types in their browser. */
  async startCodexDevice(): Promise<DeviceStart> {
    const res = await this.fetchImpl(this.urls.codexDeviceCode, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    });
    const text = await res.text();
    if (!res.ok) throw new OAuthError(`ChatGPT sign-in could not start (${res.status}).`);
    const data = JSON.parse(text) as { device_auth_id: string; user_code: string; interval?: string };
    return {
      deviceAuthId: data.device_auth_id,
      userCode: data.user_code,
      verificationUrl: this.urls.codexVerify,
      interval: Number.parseInt(String(data.interval ?? ""), 10) || 5,
    };
  }

  /**
   * Step 2, called on a timer: still pending until OpenAI hands back an
   * authorization code, which we immediately trade for tokens. Anything that
   * is not a usable answer counts as pending, exactly like the Box backend.
   */
  async pollCodexDevice(deviceAuthId: string, userCode: string): Promise<DevicePoll> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.urls.codexDeviceToken, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: CODEX_CLIENT_ID, device_auth_id: deviceAuthId, user_code: userCode }),
      });
    } catch {
      return { status: "pending" };
    }
    const text = await res.text();
    if (!res.ok) return { status: "pending" };
    let data: Record<string, unknown>;
    try { data = JSON.parse(text); } catch { return { status: "pending" }; }
    if (typeof data.authorization_code !== "string" || typeof data.code_verifier !== "string") return { status: "pending" };
    const tokens = await this.codexToken({
      grant_type: "authorization_code",
      client_id: CODEX_CLIENT_ID,
      code_verifier: data.code_verifier,
      code: data.authorization_code,
      redirect_uri: this.urls.codexRedirect,
    });
    return { status: "complete", tokens };
  }

  async refreshCodex(refreshToken: string): Promise<OAuthTokens> {
    const next = await this.codexToken({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CODEX_CLIENT_ID });
    return { ...next, refreshToken: next.refreshToken || refreshToken };
  }

  private async codexToken(body: Record<string, string>): Promise<OAuthTokens> {
    const res = await this.fetchImpl(this.urls.codexToken, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new OAuthError(`ChatGPT rejected the sign-in (${res.status}).`);
    const data = JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in?: number };
    if (!data.access_token) throw new OAuthError("ChatGPT returned no access token.");
    const accountId = chatGptAccountId(data.access_token);
    return {
      accessToken: data.access_token,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      ...(accountId ? { accountId } : {}),
    };
  }
}

/** True when a stored token is close enough to expiry to be worth refreshing. */
export const tokenIsStale = (expiresAt: number | undefined, bufferMs = OAUTH_REFRESH_BUFFER_MS): boolean =>
  typeof expiresAt === "number" && expiresAt <= Date.now() + bufferMs;
