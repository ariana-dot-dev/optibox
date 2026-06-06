# Codebase daemon adapter

This adapter is for a product-owned runtime checked out in the user Box. If the
repo contains `./bin/agent-daemon` or an `npm run agent:daemon` script, the
adapter starts it with `--stream --provider ... --model ...` and pipes the turn
prompt on stdin. stdout is relayed chunk-by-chunk. The included Node fallback is
only a development proof that the continuation path is an in-Box process, not a
Box prompt or the host Ascii agent.
