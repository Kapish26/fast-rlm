"""Tests for the log_dir parameter (feature P5, Python side).

Asserts run(log_dir=...) is wired to the engine's --log-dir flag (mocked engine,
no API), and that omitting it defaults to <cwd>/logs.

Run with:  uv run pytest
"""
import json
import os
import types

import fast_rlm._runner as _runner
from fast_rlm._runner import run


def _install_fake_engine(monkeypatch, recorder):
    monkeypatch.setattr(_runner, "_check_deno", lambda: None)

    def fake_run(cmd, input=None, **kwargs):
        recorder["cmd"] = list(cmd)
        op = cmd[cmd.index("--output") + 1]
        with open(op, "w") as f:
            json.dump({"results": None, "usage": {}, "log_file": None}, f)
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(_runner.subprocess, "run", fake_run)


def _log_dir_arg(cmd):
    return cmd[cmd.index("--log-dir") + 1]


def test_log_dir_passed_through(monkeypatch, tmp_path):
    rec = {}
    _install_fake_engine(monkeypatch, rec)
    custom = str(tmp_path / "my_logs")
    run("hi", config={"primary_agent": "x"}, log_dir=custom)
    assert _log_dir_arg(rec["cmd"]) == custom


def test_log_dir_defaults_to_cwd_logs(monkeypatch):
    rec = {}
    _install_fake_engine(monkeypatch, rec)
    run("hi", config={"primary_agent": "x"})
    assert _log_dir_arg(rec["cmd"]) == os.path.join(os.getcwd(), "logs")
