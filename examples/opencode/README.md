# OpenCode adapter

OpenCode is an open-source coding agent for terminal/desktop/IDE. Its docs describe `build` as the full-tools primary agent and `plan`/permission-denied configs for restricted operation. The package `@opencode-ai/sdk` is available for headless control.

This prototype keeps shared mode outside OpenCode tool access entirely via `SafeSharedCapabilities`. If you also run OpenCode in the shared Box, configure permissions to deny `read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`, `external_directory`, `lsp`, and `skill`, while allowing only safe web/search behavior.
