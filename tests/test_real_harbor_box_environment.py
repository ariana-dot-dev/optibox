from __future__ import annotations

import os
from pathlib import Path

import pytest

from harbor.models.task.config import EnvironmentConfig
from harbor.models.trial.paths import TrialPaths

from harbor_box import BoxEnvironment

pytestmark = pytest.mark.real_box


def _make_real_env(tmp_path: Path) -> BoxEnvironment:
    environment_dir = tmp_path / "environment"
    environment_dir.mkdir()
    (environment_dir / "Dockerfile").write_text("FROM ubuntu:24.04\nWORKDIR /workspace\n", encoding="utf-8")
    (environment_dir / "seed.txt").write_text("seed from environment dir\n", encoding="utf-8")
    trial_paths = TrialPaths(tmp_path / "trial")
    trial_paths.mkdir()
    return BoxEnvironment(
        environment_dir=environment_dir,
        environment_name="real-box-env",
        session_id=f"pytest-{os.getpid()}",
        trial_paths=trial_paths,
        task_env_config=EnvironmentConfig(workdir="/workspace", env={"HARBOR_BOX_PERSISTENT": "persisted"}),
        ttl_seconds=300,
    )


@pytest.mark.skipif(not os.environ.get("BOX_API_KEY"), reason="BOX_API_KEY is required for real Box tests")
@pytest.mark.asyncio
async def test_real_box_environment_e2e(tmp_path):
    env = _make_real_env(tmp_path)
    await env.start(force_build=False)
    try:
        result = await env.exec(
            "printf '%s:%s' \"$HARBOR_BOX_PERSISTENT\" \"$HARBOR_BOX_LOCAL\" > /tmp/harbor-box.txt && cat /tmp/harbor-box.txt",
            env={"HARBOR_BOX_LOCAL": "local"},
            timeout_sec=30,
        )
        assert result.return_code == 0, result.stderr
        assert result.stdout == "persisted:local"

        source = tmp_path / "upload.bin"
        source.write_bytes(bytes([0, 1, 2, 253, 254, 255]))
        await env.upload_file(source, "/tmp/harbor-upload.bin")
        assert await env.is_file("/tmp/harbor-upload.bin")

        downloaded = tmp_path / "download.bin"
        await env.download_file("/tmp/harbor-upload.bin", downloaded)
        assert downloaded.read_bytes() == source.read_bytes()

        src_dir = tmp_path / "srcdir"
        (src_dir / "nested").mkdir(parents=True)
        (src_dir / "nested" / "hello.txt").write_text("hello box harbor\n", encoding="utf-8")
        await env.upload_dir(src_dir, "/tmp/harbor-dir")
        out_dir = tmp_path / "outdir"
        await env.download_dir("/tmp/harbor-dir", out_dir)
        assert (out_dir / "nested" / "hello.txt").read_text(encoding="utf-8") == "hello box harbor\n"
    finally:
        await env.stop(delete=True)
