import type { TranscriptMessage } from "./types.js";

/**
 * Box pricing (verified from box.ascii.dev landing page):
 *   "$20 buys 2,000,000 VM-seconds of dedicated 4 vCPU / 8 GB VM-time"
 *   billed by the second; "box stop — snapshot and pause billing".
 * => $0.00001 per VM-second. Billing pauses entirely while a box is stopped.
 */
export const BOX_SECONDS_PER_20_USD = 2_000_000;
export const BOX_PRICE_USD_PER_SECOND = 20 / BOX_SECONDS_PER_20_USD; // 0.00001
export const BOX_PRICE_LABEL = "$20 / 2,000,000 VM-sec · 4 vCPU · 8 GB";
/** Active box-seconds you can run per month and still stay under $1. */
export const SECONDS_UNDER_1_USD_PER_MONTH = Math.floor(1 / BOX_PRICE_USD_PER_SECOND); // 100,000s ≈ 27.7h

export const BOX_PRICING = {
  ratePerSecond: BOX_PRICE_USD_PER_SECOND,
  monthlyMinUsd: 20,
  secondsPer20Usd: BOX_SECONDS_PER_20_USD,
  label: BOX_PRICE_LABEL,
  secondsUnder1UsdPerMonth: SECONDS_UNDER_1_USD_PER_MONTH,
  note: "Billed per second; billing pauses on stop. The shared always-on box is platform-amortized across all users, so per-user it is effectively free and gives zero cold start. A user pays only for their private box's running seconds.",
} as const;

export interface MachineState {
  /** Which substrate the agent is currently executing on. */
  location: "shared-box" | "user-box";
  /** Whether real machine tools (bash/files) are available right now. */
  tools: boolean;
  boxId?: string;
  /**
   * Lifecycle phase relevant to routing decisions:
   *  - provisioning: private box is being created for the first time (cold)
   *  - resuming: private box exists but was archived; being woken from snapshot
   *  - live: agent is executing inside a ready private box right now
   * Used by the shared bridge agent to phrase an accurate "coming online" reply
   * and by the UI to show precise state instead of a coarse "busy".
   */
  status?: "prewarming" | "provisioning" | "resuming" | "live";
}

export const HIDDEN_CONTEXT_TAG = "consumer-context";

/**
 * Build the hidden context envelope injected into EVERY agent prompt (shared and
 * user-box). It carries the full prior transcript, the current machine/tool
 * state, and any partial shared-agent response, so context is impossible to lose
 * when we change machines or start a fresh agent session. The host UI strips
 * this block from anything shown to the user — see {@link stripHiddenContext}.
 */
export function buildHiddenContext(input: {
  transcript: TranscriptMessage[];
  machine: MachineState;
  partialShared?: string;
}): string {
  const turns = input.transcript
    .slice(-40)
    .map((m) => {
      const who = m.role.toUpperCase();
      const tag = m.mode ? ` mode="${m.mode}"` : "";
      const hm = m.harness ? ` harness="${m.harness}"` : "";
      const text = m.content.replace(/\s+/g, " ").trim();
      return `    <message role="${who}"${tag}${hm}>${escapeXml(text)}</message>`;
    })
    .join("\n");
  const partial = input.partialShared
    ? `\n  <partial-shared-response note="already shown to the user by the prewarm agent — continue from it, do not repeat verbatim">\n    ${escapeXml(input.partialShared.replace(/\s+/g, " ").trim())}\n  </partial-shared-response>`
    : "";
  return [
    `<${HIDDEN_CONTEXT_TAG}>`,
    `  <machine-state location="${input.machine.location}" tools="${input.machine.tools}"${input.machine.status ? ` status="${input.machine.status}"` : ""}${input.machine.boxId ? ` boxId="${input.machine.boxId}"` : ""}/>`,
    `  <prior-transcript count="${input.transcript.length}">`,
    turns,
    `  </prior-transcript>${partial}`,
    `</${HIDDEN_CONTEXT_TAG}>`,
  ].join("\n");
}

/** Remove the hidden context envelope from any user-visible text. */
export function stripHiddenContext(text: string): string {
  const re = new RegExp(`<${HIDDEN_CONTEXT_TAG}>[\\s\\S]*?</${HIDDEN_CONTEXT_TAG}>`, "g");
  return text.replace(re, "").trim();
}

function escapeXml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));
}

/**
 * Legacy compatibility shim. Routing deliberately no longer classifies user
 * text: every turn starts with an open shared bridge and then continues in the
 * private Box, where the real harness decides whether tools/commands are
 * needed. Keep this export truthy for older callers/tests that still ask.
 */
export function detectToolIntent(_message: string): boolean {
  return true;
}
