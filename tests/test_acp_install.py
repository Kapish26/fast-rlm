"""Tests for the opt-in ACP install marker (fast_rlm/_acp_install.py).

Everything here is offline: no npm, no Deno, no network. The pieces that do
reach out (`_npm_latest`, `_resolve_ai_sdk`, `_cache_specifiers`) are stubbed —
what matters is the gating logic and the marker contract shared with the engine
(src/acp_install.ts), not npm's answers.
"""

import json

import pytest

from fast_rlm import _acp_install as acp


@pytest.fixture
def home(tmp_path, monkeypatch):
    """Point marker state at a scratch dir so tests never touch ~/.fast_rlm."""
    monkeypatch.setenv("FAST_RLM_HOME", str(tmp_path))
    return tmp_path


def _write_marker(home, **overrides):
    marker = {
        "marker_version": acp.MARKER_VERSION,
        "provider_version": "0.3.5",
        "ai_sdk_version": "6.0.264",
        "provider_specifier": "npm:@mcpc-tech/acp-ai-provider@0.3.5",
        "ai_sdk_specifier": "npm:ai@6.0.264",
        "bridges": {"claude-code": "0.16.2", "codex": "0.16.0"},
        "bridge_packages": dict(acp.BRIDGE_PKGS),
    }
    marker.update(overrides)
    (home / "acp.json").write_text(json.dumps(marker))
    return marker


def test_not_installed_by_default(home):
    assert acp.load_marker() is None
    assert acp.is_installed() is False


def test_require_installed_raises_actionable_error(home):
    with pytest.raises(RuntimeError) as e:
        acp.require_installed("acp:claude-code")
    msg = str(e.value)
    assert "not installed" in msg
    assert "fast-rlm acp install" in msg  # the fix must be in the message
    assert "acp:claude-code" in msg  # and which agent triggered it


def test_marker_roundtrip(home):
    written = _write_marker(home)
    loaded = acp.load_marker()
    assert loaded == written
    assert acp.is_installed() is True
    assert acp.require_installed("acp:codex") == written


def test_future_marker_version_is_ignored(home):
    """A marker from a newer fast-rlm is treated as absent, not mis-parsed."""
    _write_marker(home, marker_version=acp.MARKER_VERSION + 99)
    assert acp.load_marker() is None


def test_corrupt_marker_is_ignored(home):
    (home / "acp.json").write_text("{not json")
    assert acp.load_marker() is None


def test_install_pins_ai_sdk_to_provider_range(home, monkeypatch):
    """The AI SDK is derived from the provider, never resolved independently.

    The provider depends on `ai@^6` while `ai@7` is current, so taking "latest"
    for both would install an incompatible pair.
    """
    monkeypatch.setattr(acp, "_npm_latest", lambda pkg: {
        acp.ACP_PROVIDER_PKG: "0.3.5",
        acp.AI_SDK_PKG: "7.0.77",  # latest overall — must NOT be chosen
        "@zed-industries/claude-code-acp": "0.16.2",
        "@zed-industries/codex-acp": "0.16.0",
    }[pkg])
    monkeypatch.setattr(acp, "_resolve_ai_sdk", lambda v: "6.0.264")
    monkeypatch.setattr(acp, "_cache_specifiers", lambda specs: None)
    monkeypatch.setattr("fast_rlm._runner._check_deno", lambda: None)

    marker = acp.install()
    assert marker["ai_sdk_version"] == "6.0.264"
    assert marker["ai_sdk_specifier"] == "npm:ai@6.0.264"
    assert marker["provider_specifier"] == "npm:@mcpc-tech/acp-ai-provider@0.3.5"
    assert marker["bridges"]["claude-code"] == "0.16.2"
    assert acp.load_marker() == marker


def test_install_without_update_keeps_recorded_versions(home, monkeypatch):
    """A repeat `install` repairs the cache; it does not silently upgrade."""
    _write_marker(home)
    monkeypatch.setattr(acp, "_npm_latest", lambda pkg: "99.99.99")
    monkeypatch.setattr(acp, "_resolve_ai_sdk", lambda v: "99.99.99")
    monkeypatch.setattr(acp, "_cache_specifiers", lambda specs: None)
    monkeypatch.setattr("fast_rlm._runner._check_deno", lambda: None)

    marker = acp.install(update=False)
    assert marker["provider_version"] == "0.3.5"
    assert marker["ai_sdk_version"] == "6.0.264"
    assert marker["bridges"]["codex"] == "0.16.0"


def test_install_with_update_moves_to_latest(home, monkeypatch):
    """`-u` is the one place pinned versions move — no fast-rlm release needed."""
    _write_marker(home)
    monkeypatch.setattr(acp, "_npm_latest", lambda pkg: "1.2.3")
    monkeypatch.setattr(acp, "_resolve_ai_sdk", lambda v: "6.9.9")
    monkeypatch.setattr(acp, "_cache_specifiers", lambda specs: None)
    monkeypatch.setattr("fast_rlm._runner._check_deno", lambda: None)

    marker = acp.install(update=True)
    assert marker["provider_version"] == "1.2.3"
    assert marker["ai_sdk_version"] == "6.9.9"
    assert marker["bridges"] == {"claude-code": "1.2.3", "codex": "1.2.3"}


def test_run_gates_on_acp_without_marker(home):
    """run() must fail in Python with the actionable message, not deep in Deno."""
    import fast_rlm

    with pytest.raises(RuntimeError, match="ACP support is not installed"):
        fast_rlm.run("hi", config={"primary_agent": "acp:claude-code"})


def test_run_gates_on_acp_sub_agent(home):
    """An acp: sub_agent is gated too, not just the primary."""
    import fast_rlm

    with pytest.raises(RuntimeError, match="ACP support is not installed"):
        fast_rlm.run(
            "hi",
            config={"primary_agent": "z-ai/glm-5", "sub_agent": "acp:codex"},
        )


# ---- Regressions from code review -------------------------------------------


def test_install_preserves_renamed_bridge_package(home, monkeypatch):
    """A user-edited bridge package name survives the next install.

    Following an upstream rename is documented as a marker edit, so `install`
    must not stomp `bridge_packages` back to the built-in defaults — and must
    resolve the version against the RENAMED package, not the old one.
    """
    renamed = "@agentclientprotocol/claude-agent-acp"
    _write_marker(home, bridge_packages={**acp.BRIDGE_PKGS, "claude-code": renamed})

    asked = []

    def fake_latest(pkg):
        asked.append(pkg)
        return "5.0.0"

    monkeypatch.setattr(acp, "_npm_latest", fake_latest)
    monkeypatch.setattr(acp, "_resolve_ai_sdk", lambda v: "6.0.264")
    monkeypatch.setattr(acp, "_cache_specifiers", lambda specs: None)
    monkeypatch.setattr("fast_rlm._runner._check_deno", lambda: None)

    marker = acp.install(update=True)
    assert marker["bridge_packages"]["claude-code"] == renamed
    assert renamed in asked
    assert "@zed-industries/claude-code-acp" not in asked


def test_install_survives_unreachable_npm_for_bridges(home, monkeypatch):
    """A bridge lookup failure must not abort a first-time install.

    Bridges are optional to pin — pinBridgeArgs falls back to unpinned npx — so
    only the provider is fatal.
    """
    def fake_latest(pkg):
        return "0.3.5" if pkg == acp.ACP_PROVIDER_PKG else None

    monkeypatch.setattr(acp, "_npm_latest", fake_latest)
    monkeypatch.setattr(acp, "_resolve_ai_sdk", lambda v: "6.0.264")
    monkeypatch.setattr(acp, "_cache_specifiers", lambda specs: None)
    monkeypatch.setattr("fast_rlm._runner._check_deno", lambda: None)

    marker = acp.install()
    assert marker["provider_version"] == "0.3.5"
    assert marker["bridges"] == {}  # unpinned; npx resolves at launch
    assert acp.is_installed() is True


def test_install_still_fails_when_provider_unresolvable(home, monkeypatch):
    """The provider is not optional — without it there is nothing to import."""
    monkeypatch.setattr(acp, "_npm_latest", lambda pkg: None)
    monkeypatch.setattr(acp, "_cache_specifiers", lambda specs: None)
    monkeypatch.setattr("fast_rlm._runner._check_deno", lambda: None)

    with pytest.raises(RuntimeError, match="Could not resolve a version"):
        acp.install()


def test_status_tolerates_marker_without_provider_version(home, capsys):
    """A hand-edited marker must not produce a '...@None' npm lookup."""
    _write_marker(home)
    marker = json.loads((home / "acp.json").read_text())
    del marker["provider_version"]
    (home / "acp.json").write_text(json.dumps(marker))

    acp.status()
    assert "@None" not in capsys.readouterr().out


def test_acp_install_command_reports_subprocess_failure(home, monkeypatch, capsys):
    """A failed `deno cache` exits 1 with a message, not a traceback."""
    import subprocess

    from fast_rlm._cli import _acp_command

    monkeypatch.setattr(acp, "_npm_latest", lambda pkg: "1.0.0")
    monkeypatch.setattr(acp, "_resolve_ai_sdk", lambda v: "6.0.264")
    monkeypatch.setattr("fast_rlm._runner._check_deno", lambda: None)

    def boom(specs):
        raise subprocess.CalledProcessError(1, ["deno", "cache", "x.ts"])

    monkeypatch.setattr(acp, "_cache_specifiers", boom)
    assert _acp_command(["install"]) == 1
    assert "Error:" in capsys.readouterr().err


def test_acp_install_command_reports_timeout(home, monkeypatch, capsys):
    import subprocess

    from fast_rlm._cli import _acp_command

    monkeypatch.setattr(acp, "_npm_latest", lambda pkg: "1.0.0")
    monkeypatch.setattr(acp, "_resolve_ai_sdk", lambda v: "6.0.264")
    monkeypatch.setattr("fast_rlm._runner._check_deno", lambda: None)

    def boom(specs):
        raise subprocess.TimeoutExpired(["deno", "cache"], 600)

    monkeypatch.setattr(acp, "_cache_specifiers", boom)
    assert _acp_command(["install"]) == 1
    assert "timed out" in capsys.readouterr().err
