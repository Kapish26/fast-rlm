"""Tests for the on_step log listener (feature P2, Python side).

Two layers, neither of which invokes an LLM:
  1. `_tail_events` directly — the live NDJSON tailing/drain logic.
  2. `run()` end-to-end with `subprocess.run` mocked to stand in for the Deno
     engine — asserts flag wiring (--verbosity, --events-file), stdout capture,
     and that events written by the "engine" reach the on_step callback.

Run with:  uv run pytest
"""
import json
import subprocess
import threading
import time
import types

import pytest

import fast_rlm._runner as _runner
from fast_rlm._runner import _tail_events, run


def _wait_until(pred, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.01)
    return pred()


def _append(path, text):
    with open(path, "a", encoding="utf-8") as f:
        f.write(text)


def _start_tail(path, on_step):
    stop = threading.Event()
    t = threading.Thread(target=_tail_events, args=(path, on_step, stop), daemon=True)
    t.start()
    return t, stop


class TestTailEvents:
    def test_dispatches_all_prewritten_in_order(self, tmp_path):
        path = tmp_path / "e.jsonl"
        for i in range(3):
            _append(path, json.dumps({"step": i}) + "\n")
        got = []
        t, stop = _start_tail(str(path), got.append)
        stop.set()  # stop immediately; drain guarantee must still deliver all 3
        t.join(timeout=5)
        assert not t.is_alive()
        assert [e["step"] for e in got] == [0, 1, 2]

    def test_live_incremental_dispatch(self, tmp_path):
        # File does not exist yet when the tail starts.
        path = tmp_path / "e.jsonl"
        got = []
        t, stop = _start_tail(str(path), got.append)
        try:
            _append(path, json.dumps({"step": 1}) + "\n")
            assert _wait_until(lambda: len(got) == 1), "first event not delivered"
            _append(path, json.dumps({"step": 2}) + "\n")
            assert _wait_until(lambda: len(got) == 2), "second event not delivered"
        finally:
            stop.set()
            t.join(timeout=5)
        assert [e["step"] for e in got] == [1, 2]

    def test_partial_trailing_line_is_held(self, tmp_path):
        path = tmp_path / "e.jsonl"
        got = []
        t, stop = _start_tail(str(path), got.append)
        try:
            # One complete line + one partial (no trailing newline yet).
            _append(path, json.dumps({"step": 1}) + "\n" + '{"step": 2')
            assert _wait_until(lambda: len(got) == 1)
            time.sleep(0.15)
            assert len(got) == 1, "partial line was dispatched prematurely"
            # Complete the second line — it should now flush.
            _append(path, "}\n")
            assert _wait_until(lambda: len(got) == 2)
        finally:
            stop.set()
            t.join(timeout=5)
        assert [e["step"] for e in got] == [1, 2]

    def test_blank_and_malformed_lines_skipped(self, tmp_path):
        path = tmp_path / "e.jsonl"
        _append(path, "not json\n\n" + json.dumps({"ok": 1}) + "\n")
        got = []
        t, stop = _start_tail(str(path), got.append)
        stop.set()
        t.join(timeout=5)
        assert got == [{"ok": 1}]

    def test_callback_exception_does_not_propagate(self, tmp_path):
        path = tmp_path / "e.jsonl"
        _append(path, json.dumps({"step": 1}) + "\n" + json.dumps({"step": 2}) + "\n")
        seen = []

        def cb(ev):
            seen.append(ev["step"])
            if ev["step"] == 1:
                raise RuntimeError("boom")

        t, stop = _start_tail(str(path), cb)
        stop.set()
        with pytest.warns(UserWarning, match="on_step callback raised"):
            t.join(timeout=5)
        assert not t.is_alive()
        # The raising event AND the following one were both processed.
        assert seen == [1, 2]

    def test_file_never_created_returns_on_stop(self, tmp_path):
        path = tmp_path / "never.jsonl"
        got = []
        t, stop = _start_tail(str(path), got.append)
        stop.set()
        t.join(timeout=5)
        assert not t.is_alive()
        assert got == []


def _install_fake_engine(monkeypatch, *, events=None, result=None, recorder=None):
    """Replace subprocess.run with a stand-in Deno engine that writes the
    --events-file and --output file the way the real engine does."""
    monkeypatch.setattr(_runner, "_check_deno", lambda: None)

    def fake_run(cmd, input=None, **kwargs):
        if recorder is not None:
            recorder["cmd"] = list(cmd)
            recorder["kwargs"] = kwargs
        if events is not None and "--events-file" in cmd:
            ep = cmd[cmd.index("--events-file") + 1]
            with open(ep, "w", encoding="utf-8") as f:
                for ev in events:
                    f.write(json.dumps(ev) + "\n")
        op = cmd[cmd.index("--output") + 1]
        with open(op, "w", encoding="utf-8") as f:
            json.dump(result or {"results": None, "usage": {}, "log_file": None}, f)
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(_runner.subprocess, "run", fake_run)


class TestRunIntegration:
    @pytest.mark.parametrize(
        "kwargs,expected",
        [
            ({}, "2"),                       # default -> full
            ({"verbose": False}, "0"),       # legacy flag
            ({"verbosity": "silent"}, "0"),
            ({"verbosity": "summary"}, "1"),
            ({"verbosity": 2}, "2"),
            ({"verbosity": "silent", "verbose": True}, "0"),  # verbosity wins
        ],
    )
    def test_verbosity_flag_wired(self, monkeypatch, kwargs, expected):
        rec = {}
        _install_fake_engine(monkeypatch, recorder=rec)
        run("hi", config={"primary_agent": "x"}, **kwargs)
        cmd = rec["cmd"]
        assert "--verbosity" in cmd
        assert cmd[cmd.index("--verbosity") + 1] == expected

    def test_no_events_file_without_on_step(self, monkeypatch):
        rec = {}
        _install_fake_engine(monkeypatch, recorder=rec)
        run("hi", config={"primary_agent": "x"})
        assert "--events-file" not in rec["cmd"]

    def test_on_step_receives_engine_events(self, monkeypatch):
        rec = {}
        engine_events = [
            {"event_type": "code_generated", "depth": 0, "step": 1},
            {"event_type": "execution_result", "depth": 0, "step": 1, "output": "4"},
            {"event_type": "final_result", "depth": 0, "result": 4},
        ]
        _install_fake_engine(
            monkeypatch,
            events=engine_events,
            result={"results": 4, "usage": {}, "log_file": None},
            recorder=rec,
        )
        got = []
        data = run("hi", config={"primary_agent": "x"}, on_step=got.append)

        assert "--events-file" in rec["cmd"]
        assert data["results"] == 4
        # All engine events reached the callback, in order, by the time run() returned.
        assert [e["event_type"] for e in got] == [
            "code_generated",
            "execution_result",
            "final_result",
        ]

    @pytest.mark.parametrize(
        "verbosity,should_capture",
        [("silent", True), ("summary", False), ("full", False)],
    )
    def test_stdout_captured_only_when_silent(self, monkeypatch, verbosity, should_capture):
        rec = {}
        _install_fake_engine(monkeypatch, recorder=rec)
        run("hi", config={"primary_agent": "x"}, verbosity=verbosity)
        expected = subprocess.PIPE if should_capture else None
        assert rec["kwargs"]["stdout"] == expected
        assert rec["kwargs"]["stderr"] == expected
