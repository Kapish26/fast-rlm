"""Tests for resumable sessions (Python side).

Asserts run(session_dir=..., session_id=...) / Session are wired to the
engine's --session-file flag (mocked engine, no API), that ephemeral sessions
use an auto-cleaned temp dir, and that Session's host-side inspection reads
state.json without exposing pickle blobs.

Run with:  uv run pytest
"""
import json
import os
import types

import pytest

import fast_rlm._runner as _runner
from fast_rlm import Session
from fast_rlm._runner import resolve_session_dir, run


def _install_fake_engine(monkeypatch, recorder):
    monkeypatch.setattr(_runner, "_check_deno", lambda: None)

    def fake_run(cmd, input=None, **kwargs):
        recorder["cmd"] = list(cmd)
        op = cmd[cmd.index("--output") + 1]
        with open(op, "w") as f:
            json.dump({"results": None, "usage": {}, "log_file": None}, f)
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(_runner.subprocess, "run", fake_run)


def _session_file_arg(cmd):
    return cmd[cmd.index("--session-file") + 1]


# ---- resolve_session_dir (the (id, dir) -> path rule) -----------------------

def test_resolve_session_dir_rules(tmp_path):
    assert resolve_session_dir(None, None) is None
    assert resolve_session_dir(None, "runs") == "runs"
    assert resolve_session_dir("pod", "runs") == os.path.join("runs", "pod")
    with pytest.raises(ValueError):
        resolve_session_dir("pod", None)


# ---- run() wiring -----------------------------------------------------------

def test_session_dir_passed_through(monkeypatch, tmp_path):
    rec = {}
    _install_fake_engine(monkeypatch, rec)
    sdir = tmp_path / "sess"
    run("hi", config={"primary_agent": "x"}, session_dir=str(sdir))
    assert _session_file_arg(rec["cmd"]) == str(sdir / "state.json")
    assert sdir.is_dir()  # created if missing


def test_session_id_nests_under_dir(monkeypatch, tmp_path):
    rec = {}
    _install_fake_engine(monkeypatch, rec)
    run("hi", config={"primary_agent": "x"}, session_dir=str(tmp_path), session_id="pod")
    assert _session_file_arg(rec["cmd"]) == str(tmp_path / "pod" / "state.json")
    assert (tmp_path / "pod").is_dir()


def test_session_id_without_dir_raises(monkeypatch):
    rec = {}
    _install_fake_engine(monkeypatch, rec)
    with pytest.raises(ValueError):
        run("hi", config={"primary_agent": "x"}, session_id="pod")


def test_no_session_dir_no_flag(monkeypatch):
    rec = {}
    _install_fake_engine(monkeypatch, rec)
    run("hi", config={"primary_agent": "x"})
    assert "--session-file" not in rec["cmd"]


# ---- Session ----------------------------------------------------------------

def test_session_persistent_uses_dir_and_defaults(monkeypatch, tmp_path):
    rec = {}
    _install_fake_engine(monkeypatch, rec)
    s = Session(session_dir=str(tmp_path / "sess"), config={"primary_agent": "x"}, prefix="podcasts")
    s.query("hello")
    assert _session_file_arg(rec["cmd"]) == s.state_file
    assert _session_file_arg(rec["cmd"]) == str(tmp_path / "sess" / "state.json")
    assert rec["cmd"][rec["cmd"].index("--prefix") + 1] == "podcasts"


def test_session_id_and_dir_nest(monkeypatch, tmp_path):
    rec = {}
    _install_fake_engine(monkeypatch, rec)
    s = Session(session_id="pod", session_dir=str(tmp_path), config={"primary_agent": "x"})
    s.query("hi")
    assert _session_file_arg(rec["cmd"]) == str(tmp_path / "pod" / "state.json")


def test_session_id_without_dir_raises_in_ctor():
    with pytest.raises(ValueError):
        Session(session_id="pod")


def test_ephemeral_session_uses_temp_and_cleans_up(monkeypatch):
    rec = {}
    _install_fake_engine(monkeypatch, rec)
    s = Session(config={"primary_agent": "x"})
    assert s.state_file is None  # nothing allocated until first query
    s.query("hi")
    tmp_state = _session_file_arg(rec["cmd"])
    assert tmp_state == s.state_file
    tmp_dir = os.path.dirname(tmp_state)
    assert os.path.basename(tmp_dir).startswith("fastrlm-session-")
    assert os.path.isdir(tmp_dir)
    s.close()
    assert not os.path.exists(tmp_dir)  # temp dir removed on close


def test_ephemeral_session_context_manager_cleans_up(monkeypatch):
    rec = {}
    _install_fake_engine(monkeypatch, rec)
    with Session(config={"primary_agent": "x"}) as s:
        s.query("hi")
        tmp_dir = os.path.dirname(s.state_file)
        assert os.path.isdir(tmp_dir)
    assert not os.path.exists(tmp_dir)


def test_session_inspection_strips_pickles(tmp_path):
    sdir = tmp_path / "sess"
    sdir.mkdir()
    state = {
        "version": 1,
        "queries": [{"query": "q1", "final": "a1"}],
        "pending_query": None,
        "code_log": [],
        "variables": {
            "idx": {
                "pickle_b64": "SECRETBLOB",
                "type": "dict",
                "preview": "{'a': 1}",
                "comment": "the index",
                "note": None,
                "committed": False,
            }
        },
        "functions": {"f": "def f(): pass"},
        "dropped": {"gen": "not picklable: TypeError: ..."},
    }
    (sdir / "state.json").write_text(json.dumps(state))
    s = Session(session_dir=str(sdir))
    assert s.queries() == [{"query": "q1", "final": "a1"}]
    assert s.variables()["idx"]["comment"] == "the index"
    assert "pickle_b64" not in s.variables()["idx"]
    assert s.functions() == {"f": "def f(): pass"}
    assert "gen" in s.dropped()
    s.clear()
    assert s.queries() == []
    assert not os.path.exists(s.state_file)


def test_fresh_session_inspection_is_empty(tmp_path):
    s = Session(session_dir=str(tmp_path / "nope"))
    assert s.queries() == []
    assert s.variables() == {}
    assert s.functions() == {}
    assert s.dropped() == {}


def test_ephemeral_session_inspection_is_empty_before_query():
    s = Session()
    assert s.queries() == []
    assert s.variables() == {}
