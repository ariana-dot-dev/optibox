import { realCliHarness, type RealCliHarnessSpec } from "../shared.js";

// Pi (@earendil-works/pi-coding-agent) driving OpenRouter models inside the user
// Box. A minimal terminal coding harness: one `pi -p --mode json` process per
// turn (no resident server), which is the point — we are testing whether pi is
// snappier and more stable than opencode's resident-serve path.
//
// OpenRouter is wired as a custom OpenAI-compatible provider in
// ~/.pi/agent/models.json (written by `prepare`); the API key is interpolated
// from $OPENROUTER_API_KEY at request time, which the Box run env already
// exports. `--model openrouter/<id>` selects it (pi splits provider on the first
// slash, so the id keeps its own `anthropic/...` slash).
const OPENROUTER_MODELS_JSON = JSON.stringify({
  providers: {
    openrouter: {
      baseUrl: "https://openrouter.ai/api/v1",
      api: "openai-completions",
      apiKey: "$OPENROUTER_API_KEY",
      models: [
        { id: "anthropic/claude-sonnet-5" },
        { id: "anthropic/claude-haiku-4.5" },
      ],
    },
  },
});

export const spec: RealCliHarnessSpec = {
  name: "pi",
  description: "Pi coding-agent via OpenRouter (default Claude Sonnet with tools), inside the user Box.",
  bin: "pi",
  // --ignore-scripts per pi's own install guide; the postinstall is optional.
  installCmd: "npm i -g --ignore-scripts @earendil-works/pi-coding-agent >/tmp/pi-install.log 2>&1",
  instructionDelivery: "prompt-xml",
  requiredEnv: ["OPENROUTER_API_KEY"],
  models: [
    // Sonnet first → the default selection. Both drive tools inside the Box.
    { provider: "openrouter", model: "anthropic/claude-sonnet-5", label: "Pi · Claude Sonnet 5 (tools)" },
    { provider: "openrouter", model: "anthropic/claude-haiku-4.5", label: "Pi · Claude Haiku 4.5 (fast)" },
  ],
  outputMode: "pi-json",
  // Pi's `--mode json` first line is the session header `{"type":"session","id":…}`;
  // the parser captures that id (extractSessionId, pi-json) and we resume the
  // SAME session with `--session <id>` on later turns.
  sessionStrategy: "capture",
  // The shared no-tools line streams straight from OpenRouter (see realCliHarness
  // .shared for outputMode pi-json) — fast Haiku, no local pi process.
  sharedModel: { provider: "openrouter", model: "anthropic/claude-haiku-4.5" },
  // Write the OpenRouter provider config once per turn (idempotent). Runs on the
  // Box runtime only (the shared surface never invokes the pi CLI).
  prepare: async (runtime) => {
    const b64 = Buffer.from(OPENROUTER_MODELS_JSON, "utf8").toString("base64");
    await runtime.command(`mkdir -p ~/.pi/agent && printf %s '${b64}' | base64 -d > ~/.pi/agent/models.json`);
  },
  buildArgv: ({ prompt, model, toolsAllowed, resumeSessionId }) => {
    const cmd = ["pi", "-p", "--mode", "json", "--model", `openrouter/${model}`];
    if (resumeSessionId) cmd.push("--session", resumeSessionId);
    // Structural no-tool mode for the shared surface (unused in practice — shared
    // streams directly — but kept correct for any local-CLI shared fallback).
    if (!toolsAllowed) cmd.push("--no-tools");
    cmd.push(prompt);
    // pi BLOCKS on an open stdin even with -p (it appends piped stdin to the
    // message), so run it with stdin closed via a tiny `sh -c 'exec "$@" </dev/null'`
    // wrapper. "$@" keeps every real flag/arg as its own token (so the pi flags
    // stay top-level argv elements — no quoting of the XML prompt into a script
    // string), and exec keeps the tree shallow so interrupt still reaches pi.
    return ["sh", "-c", 'exec "$@" </dev/null', "sh", ...cmd];
  },
};

export const harness = realCliHarness(spec);
