# Eve sandbox backend for Ascii Box

Optibox exports an Eve `SandboxBackend` factory for running Eve sandboxes on Ascii Box (`box.ascii.dev` / the Box public API).

```ts title="agent/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { asciiBox } from "@ascii-prototypes/consumer-box-agents";

export default defineSandbox({
  backend: asciiBox({
    apiKey: process.env.BOX_API_KEY!,
    ttlSeconds: 3600,
  }),
});
```

Folder layout with seeded files works too:

```ts title="agent/sandbox/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { asciiBox } from "@ascii-prototypes/consumer-box-agents";

export default defineSandbox({
  backend: asciiBox({
    apiKey: process.env.BOX_API_KEY!,
    name: ({ sessionKey }) => `eve-${sessionKey}`,
  }),
  async onSession({ use }) {
    const sandbox = await use({ networkPolicy: "allow-all" });
    await sandbox.writeTextFile({ path: "SESSION.txt", content: `${sandbox.id}\n` });
  },
});
```

## Capability mapping

- `create`/resume: creates a Box through the v1 API, or reconnects to `metadata.boxId` from Eve's persisted session state.
- `run`: maps to `POST /boxes/{boxId}/commands`.
- `spawn`: starts a background shell process in the Box and exposes `stdout`, `stderr`, `wait()`, and `kill()` by polling files in `.eve-spawn/`.
- `readTextFile`/`writeTextFile`: map to Box files under `/workspace`.
- `readBinaryFile`/`writeBinaryFile`: use binary methods when the client provides them; otherwise fall back to UTF-8 through the current `BoxHttpClient`.
- `removePath`: maps to `rm` inside the Box workspace.
- `resolvePath`: anchors relative paths to `/workspace`, matching Eve's sandbox contract.

## Current gaps

Ascii Box currently does not expose Eve's firewall/credential-brokering network policy API. The adapter accepts `"allow-all"` as a no-op and throws `EveBoxUnsupportedError` for `"deny-all"`, allow-lists, subnet rules, or credential transforms so applications do not get a false sense of isolation.

Box also does not expose cloneable Eve template snapshots. `prewarm()` records seed files and bootstrap code in-process, then replays them when a new session Box is created. This supports local/dev usage, but production deployments that require build-time template materialization should avoid `bootstrap`/seed files with this backend until Box exposes snapshot cloning.
