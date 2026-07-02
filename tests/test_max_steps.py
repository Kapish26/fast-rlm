"""Tests for max_steps wiring (feature P1, Python side).

max_steps is a plain config field; the meaningful Python-side guarantee is that
it round-trips into the YAML config handed to the Deno engine (which caps the
root loop). We assert that with a mocked engine, plus the RLMConfig default.

Run with:  uv run pytest
"""
import json
import types

import yaml

import fast_rlm._runner as _runner
from fast_rlm._runner import RLMConfig, run


def test_rlmconfig_max_steps_defaults_to_none():
    assert RLMConfig(primary_agent="x").max_steps is None


def _capture_engine_config(monkeypatch, recorder):
    """Mock the engine; capture the YAML config file it is handed."""
    monkeypatch.setattr(_runner, "_check_deno", lambda: None)

    def fake_run(cmd, input=None, **kwargs):
        cfg_path = cmd[cmd.index("--config") + 1]
        with open(cfg_path) as f:
            recorder["config"] = yaml.safe_load(f)
        op = cmd[cmd.index("--output") + 1]
        with open(op, "w") as f:
            json.dump({"results": None, "usage": {}, "log_file": None}, f)
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(_runner.subprocess, "run", fake_run)


def test_max_steps_passed_to_engine_config(monkeypatch):
    rec = {}
    _capture_engine_config(monkeypatch, rec)
    run("hi", config=RLMConfig(primary_agent="x", max_steps=1))
    assert rec["config"]["max_steps"] == 1


def test_max_steps_absent_when_unset(monkeypatch):
    rec = {}
    _capture_engine_config(monkeypatch, rec)
    run("hi", config={"primary_agent": "x"})
    # Unset -> None in the config (engine treats it as "fall back to max_calls").
    assert rec["config"].get("max_steps") is None
