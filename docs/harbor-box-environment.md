# Harbor Box Environment Adapter

`harbor_box.BoxEnvironment` is a Harbor `BaseEnvironment` implementation backed by the Ascii Box API. It follows Harbor's E2B provider shape for lifecycle, command execution, environment variables, upload/download, and directory transfer while rejecting provider features Box cannot currently enforce.

## Usage

```bash
pip install -e .
export BOX_API_KEY=...
harbor task run path/to/task.yaml --environment-import-path harbor_box:BoxEnvironment
```

Programmatic import path:

```python
from harbor_box import BoxEnvironment
```

## Supported

- `start()` creates a Box and waits for `ready`/`idle`/`running`.
- `exec()` maps Harbor commands, working directories, persistent env, per-command env, timeouts, and users onto Box commands.
- `upload_file`, `upload_dir`, `download_file`, `download_dir`, `is_file`, and `is_dir` operate through Box file/command APIs.
- `preflight()` checks `BOX_API_KEY` before trials are queued.

## Explicit gaps

The adapter refuses stricter Harbor network policies through Harbor's standard capability validation because Box's current public API does not expose no-network or allowlist enforcement. It also rejects Docker image selection/builds, Docker Compose, GPUs, TPUs, and Windows containers rather than silently pretending parity with E2B.
