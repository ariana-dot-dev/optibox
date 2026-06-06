# Codebase daemon adapter

This is the minimal custom-harness example for a product-owned daemon that is already checked out inside the user's Box.

The adapter does **not** implement an agent. It only locates your daemon and starts it inside the private Box. Your daemon owns the LLM loop, tool use, and stdout streaming.

## Box layout

Set `CODEBASE_DAEMON_DIR` in the env passed to `ConsumerBoxAgentOrchestrator.providerEnv`, or put the checkout at `/home/user/codebase`:

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

The checkout must provide one of:

- `./bin/agent-daemon`
- `package.json` with an `agent:daemon` npm script

## Daemon contract

Optibox starts the daemon from a per-turn instruction workspace containing `AGENTS.md` and passes the same workspace explicitly:

```bash
printf '%s' "$OPTIBOX_PROMPT" | ./bin/agent-daemon \
  --stream \
  --provider "$PROVIDER" \
  --model "$MODEL" \
  --cwd "$OPTIBOX_CWD" \
  --system-prompt-file "$OPTIBOX_CWD/CONSUMER_AGENT_SYSTEM.md"
```

Your daemon should:

- read the full turn prompt from stdin
- read host control instructions from `--system-prompt-file` or `$OPTIBOX_CWD/AGENTS.md`
- use provider keys from the process environment
- flush user-visible assistant text to stdout as it becomes available
- write diagnostics to stderr

That is all the adapter assumes.
