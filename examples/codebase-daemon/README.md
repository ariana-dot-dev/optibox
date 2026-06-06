# Codebase daemon adapter

This is the self-contained custom-harness example.

In this example, **daemon** means a product-owned, non-interactive agent process that Optibox starts for each private-Box turn. It is not a server and it is not Box's built-in agent. It is just your code: read a turn prompt from stdin, use whatever model/tool loop your product owns, and stream user-visible text to stdout.

The example includes that missing daemon code in `agentDaemon.ts`. The adapter copies the compiled daemon into the user Box by default, so the example is executable without a separate product repo.

## Included daemon

`agentDaemon.ts` is intentionally small and dependency-free. It demonstrates the contract by:

- reading the full Optibox prompt from stdin
- accepting `--stream`, `--provider`, `--model`, `--cwd`, and `--system-prompt-file`
- reading host instructions from `--system-prompt-file` / `AGENTS.md`
- answering a couple of simple runtime requests, such as CPU count or current workspace
- flushing stdout in chunks

Run it locally after `npm run build`:

```bash
printf '<latest-user-request>Check my CPU count.</latest-user-request>' | \
  node dist/examples/codebase-daemon/agentDaemon.js \
    --stream \
    --provider anthropic \
    --model claude-sonnet-4-6 \
    --cwd /tmp \
    --system-prompt-file /tmp/CONSUMER_AGENT_SYSTEM.md
```

## Replacing it with your product daemon

For a real product, replace the sample daemon with your own checked-out code by setting `CODEBASE_DAEMON_DIR` in the env passed to `ConsumerBoxAgentOrchestrator.providerEnv`:

```ts
const orchestrator = new ConsumerBoxAgentOrchestrator({
  box,
  harnesses: [codebaseDaemon],
  providerEnv: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
    CODEBASE_DAEMON_DIR: "/home/user/my-product",
  },
});
```

That checkout must provide one of:

- `./bin/agent-daemon`
- `package.json` with an `agent:daemon` npm script

Optibox invokes it like this:

```bash
printf '%s' "$OPTIBOX_PROMPT" | ./bin/agent-daemon \
  --stream \
  --provider "$PROVIDER" \
  --model "$MODEL" \
  --cwd "$OPTIBOX_CWD" \
  --system-prompt-file "$OPTIBOX_CWD/CONSUMER_AGENT_SYSTEM.md"
```

Your daemon owns the real LLM loop and tool behavior. Optibox only handles shared/private routing, hidden context, Box lifecycle, env injection, and stdout streaming.
