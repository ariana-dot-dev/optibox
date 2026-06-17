from __future__ import annotations

from pathlib import Path

import pytest

from harbor.environments.base import ExecResult
from harbor.models.task.config import EnvironmentConfig, NetworkMode, NetworkPolicy
from harbor.models.trial.paths import TrialPaths

from harbor_box import BoxEnvironment


class FakeBoxClient:
    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.commands: list[dict] = []
        self.stopped: list[str] = []
        self.box = {"id": "box_fake", "state": "ready"}

    async def create(self, *, name=None, ttl_seconds=None):
        self.create_args = {"name": name, "ttl_seconds": ttl_seconds}
        return self.box

    async def get(self, box_id):
        assert box_id == "box_fake"
        return self.box

    async def stop(self, box_id):
        self.stopped.append(box_id)
        return {"ok": True}

    async def command(self, box_id, command, *, cwd=None, env=None, timeout_seconds=None):
        self.commands.append({"box_id": box_id, "command": command, "cwd": cwd, "env": env, "timeout_seconds": timeout_seconds})
        if command.startswith("cd ") and "find . -type f" in command:
            return ExecResult(stdout="./nested/a.txt\n", stderr="", return_code=0)
        if command.startswith("test -d") or command.startswith("test -f"):
            return ExecResult(stdout="", stderr="", return_code=0)
        return ExecResult(stdout="ok", stderr="", return_code=0)

    async def write_file_binary(self, box_id, path, content):
        self.files[path] = bytes(content)

    async def read_file_binary(self, box_id, path):
        return self.files[path]


def make_env(tmp_path: Path, *, client: FakeBoxClient | None = None, task_config: EnvironmentConfig | None = None) -> BoxEnvironment:
    environment_dir = tmp_path / "environment"
    environment_dir.mkdir()
    (environment_dir / "Dockerfile").write_text("FROM ubuntu:24.04\nWORKDIR /workspace\n", encoding="utf-8")
    trial_paths = TrialPaths(tmp_path / "trial")
    trial_paths.mkdir()
    return BoxEnvironment(
        environment_dir=environment_dir,
        environment_name="unit-env",
        session_id="unit-session",
        trial_paths=trial_paths,
        task_env_config=task_config or EnvironmentConfig(env={"PERSISTENT": "yes"}),
        client=client or FakeBoxClient(),
    )


@pytest.mark.asyncio
async def test_start_exec_upload_download_and_stop(tmp_path):
    client = FakeBoxClient()
    env = make_env(tmp_path, client=client)

    await env.start(force_build=True)
    assert env.box_id == "box_fake"
    assert client.create_args["name"].startswith("harbor-unit-env-unit-session")

    result = await env.exec("printf hi", env={"LOCAL": "1"}, timeout_sec=12)
    assert result.return_code == 0
    assert client.commands[-1]["cwd"] is None
    assert client.commands[-1]["command"].startswith("cd /workspace && ")
    assert client.commands[-1]["env"] == {"PERSISTENT": "yes", "LOCAL": "1"}
    assert client.commands[-1]["timeout_seconds"] == 12

    source = tmp_path / "source.txt"
    source.write_bytes(b"hello")
    await env.upload_file(source, "/tmp/remote/source.txt")
    assert client.files["/tmp/remote/source.txt"] == b"hello"

    target = tmp_path / "downloaded.txt"
    await env.download_file("/tmp/remote/source.txt", target)
    assert target.read_bytes() == b"hello"

    await env.stop(delete=True)
    assert client.stopped == ["box_fake"]


@pytest.mark.asyncio
async def test_upload_and_download_dir(tmp_path):
    client = FakeBoxClient()
    env = make_env(tmp_path, client=client)
    await env.start()

    src = tmp_path / "dir"
    (src / "nested").mkdir(parents=True)
    (src / "nested" / "a.txt").write_text("A", encoding="utf-8")
    await env.upload_dir(src, "/remote")
    assert client.files["/remote/nested/a.txt"] == b"A"

    client.files["/remote/nested/a.txt"] = b"B"
    dst = tmp_path / "out"
    await env.download_dir("/remote", dst)
    assert (dst / "nested" / "a.txt").read_bytes() == b"B"


def test_rejects_strict_network_policy(tmp_path):
    environment_dir = tmp_path / "environment"
    environment_dir.mkdir()
    (environment_dir / "Dockerfile").write_text("FROM ubuntu:24.04\n", encoding="utf-8")
    trial_paths = TrialPaths(tmp_path / "trial")
    trial_paths.mkdir()
    with pytest.raises(ValueError, match="no-network"):
        BoxEnvironment(
            environment_dir=environment_dir,
            environment_name="unit-env",
            session_id="unit-session",
            trial_paths=trial_paths,
            task_env_config=EnvironmentConfig(),
            client=FakeBoxClient(),
            network_policy=NetworkPolicy(network_mode=NetworkMode.NO_NETWORK),
        )


def test_rejects_docker_image_until_box_supports_templates(tmp_path):
    environment_dir = tmp_path / "environment"
    environment_dir.mkdir()
    trial_paths = TrialPaths(tmp_path / "trial")
    trial_paths.mkdir()
    with pytest.raises(ValueError, match="cannot build or select Docker images"):
        BoxEnvironment(
            environment_dir=environment_dir,
            environment_name="image-env",
            session_id="image-session",
            trial_paths=trial_paths,
            task_env_config=EnvironmentConfig(docker_image="ubuntu:24.04"),
            client=FakeBoxClient(),
        )
