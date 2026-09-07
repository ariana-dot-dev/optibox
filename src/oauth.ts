import { createHash, randomBytes, randomUUID } from "node:crypto";
import { arch, hostname, release, type as osType, version as osVersion } from "node:os";

/**
 * The three consumer sign-ins, ported from the Box product's own backend
 * (backend/src/services/claude-oauth.service.ts, codex-oauth.service.ts,
 * kimi-oauth.service.ts) so optibox users connect a subscription exactly the
 * way the Box dashboard does.
 *
 *   Claude Pro/Max  : PKCE. We build an authorize URL on claude.ai; the user
 *                     approves; Anthropic's callback page PRINTS a code; the
 *                     user pastes it back; we exchange it for tokens.
 *   ChatGPT (Codex) : OpenAI device auth. We ask for a short user code; the
 *                     user types it at auth.openai.com/codex/device; we poll
 *                     until OpenAI hands us an authorization code, then
 *                     exchange that for tokens.
 *   Kimi (Kimi Code): RFC 8628 device auth on auth.kimi.com, as kimi-cli 1.50
 *                     does it. The link we get already carries the user code;
 *                     we poll the token endpoint until it answers with tokens.
 *
 * All three mint an access token that expires and a refresh token. The refresh
 * token stays server-side and is spent just before the user's box comes up.
 *
 * Everything here is pure transport: no database, no box. `fetch` and the
 * endpoint table are injectable so the suite can drive every flow against a
 * fake provider.
 */

export type OAuthProvider = "claude" | "codex" | "kimi";

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** ChatGPT only: the account id codex needs beside the token. */
  accountId?: string;
  /** Kimi only: kimi-cli keeps these three in its credential file. */
  expiresIn?: number;
  scope?: string;
  tokenType?: string;
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
  kimiDeviceCode: string;
  kimiToken: string;
}

/** Public clients of the Claude Code, Codex and Kimi CLIs; not secrets. */
export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const CLAUDE_SCOPE = "org:create_api_key user:profile user:inference";
/** kimi-cli's version string: auth.kimi.com wants the device headers of a known client. */
const KIMI_CLI_VERSION = "1.50.0";

export const OAUTH_ENDPOINTS: OAuthEndpoints = {
  claudeAuthorize: "https://claude.ai/oauth/authorize",
  claudeToken: "https://console.anthropic.com/v1/oauth/token",
  claudeRedirect: "https://console.anthropic.com/oauth/code/callback",
  codexDeviceCode: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  codexDeviceToken: "https://auth.openai.com/api/accounts/deviceauth/token",
  codexVerify: "https://auth.openai.com/codex/device",
  codexToken: "https://auth.openai.com/oauth/token",
  codexRedirect: "https://auth.openai.com/deviceauth/callback",
  kimiDeviceCode: "https://auth.kimi.com/api/oauth/device_authorization",
  kimiToken: "https://auth.kimi.com/api/oauth/token",
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

/**
 * The exact JSON kimi-cli keeps in ~/.kimi/credentials/kimi-code.json (its
 * OAuthToken.to_dict). expires_at is unix seconds.
 */
export function kimiCredentialsJson(tokens: OAuthTokens): string {
  return JSON.stringify({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken ?? "",
    expires_at: Math.floor(tokens.expiresAt / 1000),
    scope: tokens.scope ?? "",
    token_type: tokens.tokenType ?? "",
    expires_in: tokens.expiresIn ?? 0,
  });
}

export class OAuthError extends Error {}

/** Header values must be ASCII (kimi-cli strips everything else). */
const asciiHeader = (value: string): string => value.replace(/[^\x20-\x7e]/g, "").trim() || "unknown";

export class OAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly urls: OAuthEndpoints;
  /** X-Msh-Device-Id: kimi-cli persists one per install; stable per optibox instance. */
  private readonly kimiDeviceId: string;

  constructor(opts: { fetch?: typeof fetch; endpoints?: Partial<OAuthEndpoints>; kimiDeviceId?: string } = {}) {
    this.fetchImpl = opts.fetch ?? ((...args) => fetch(...args));
    this.urls = { ...OAUTH_ENDPOINTS, ...(opts.endpoints ?? {}) };
    this.kimiDeviceId = opts.kimiDeviceId ?? randomUUID().replace(/-/g, "");
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

  // -------------------------------------------------------------- Kimi

  /** The device headers every auth.kimi.com call carries (kimi-cli's _common_headers). */
  kimiHeaders(): Record<string, string> {
    return {
      "X-Msh-Platform": "kimi_cli",
      "X-Msh-Version": KIMI_CLI_VERSION,
      "X-Msh-Device-Name": asciiHeader(hostname()),
      "X-Msh-Device-Model": asciiHeader(`${osType()} ${release()} ${arch()}`),
      "X-Msh-Os-Version": asciiHeader(osVersion()),
      "X-Msh-Device-Id": this.kimiDeviceId,
    };
  }

  private async kimiPost(url: string, body: Record<string, string>): Promise<{ status: number; data: Record<string, unknown> }> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { ...this.kimiHeaders(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try { const parsed = JSON.parse(text); if (parsed && typeof parsed === "object") data = parsed; } catch { /* not JSON */ }
    return { status: res.status, data };
  }

  private kimiTokens(data: Record<string, unknown>): OAuthTokens {
    const expiresIn = Number(data.expires_in) || 0;
    return {
      accessToken: String(data.access_token),
      ...(data.refresh_token ? { refreshToken: String(data.refresh_token) } : {}),
      expiresAt: Date.now() + expiresIn * 1000,
      expiresIn,
      scope: String(data.scope ?? ""),
      tokenType: String(data.token_type ?? ""),
    };
  }

  /** Step 1: ask auth.kimi.com for a user code and the link that carries it. */
  async startKimiDevice(): Promise<DeviceStart> {
    const { status, data } = await this.kimiPost(this.urls.kimiDeviceCode, { client_id: KIMI_CLIENT_ID });
    if (status !== 200 || !data.device_code || !data.user_code) throw new OAuthError(`Kimi sign-in could not start (${status}).`);
    return {
      deviceAuthId: String(data.device_code),
      userCode: String(data.user_code),
      verificationUrl: String(data.verification_uri_complete || data.verification_uri || ""),
      interval: Number(data.interval) || 5,
    };
  }

  /**
   * Step 2, called on a timer: 200 + access_token is done, `expired_token`
   * means the user must start again, anything else (authorization_pending,
   * slow_down, a network blip) is pending, exactly like kimi-cli.
   */
  async pollKimiDevice(deviceCode: string): Promise<DevicePoll> {
    let result: { status: number; data: Record<string, unknown> };
    try {
      result = await this.kimiPost(this.urls.kimiToken, {
        client_id: KIMI_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
    } catch {
      return { status: "pending" };
    }
    if (result.status === 200 && typeof result.data.access_token === "string") return { status: "complete", tokens: this.kimiTokens(result.data) };
    if (result.data.error === "expired_token") throw new OAuthError("that Kimi sign-in expired before it was approved, start it again");
    return { status: "pending" };
  }

  /** 401/403 = signed out (start again); 429/5xx are retried with backoff. */
  async refreshKimi(refreshToken: string, retryDelayMs = 1000): Promise<OAuthTokens> {
    let last = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const { status, data } = await this.kimiPost(this.urls.kimiToken, { client_id: KIMI_CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken });
      if (status === 401 || status === 403) throw new OAuthError("Kimi signed this subscription out. Connect it again.");
      if (status === 200 && typeof data.access_token === "string") {
        const next = this.kimiTokens(data);
        return { ...next, refreshToken: next.refreshToken || refreshToken };
      }
      last = String(data.error_description || `HTTP ${status}`);
      if (![429, 500, 502, 503, 504].includes(status)) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** attempt));
    }
    throw new OAuthError(`Kimi token refresh failed (${last}).`);
  }
}

/** True when a stored token is close enough to expiry to be worth refreshing. */
export const tokenIsStale = (expiresAt: number | undefined, bufferMs = OAUTH_REFRESH_BUFFER_MS): boolean =>
  typeof expiresAt === "number" && expiresAt <= Date.now() + bufferMs;
