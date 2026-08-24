"""Python-side tests for the direct-CLI backend (`cli:` agents).

Covers what the launcher owns: scoping `--allow-run` to the binaries a run will
actually spawn, and keeping the CLI backend free of the ACP opt-in gate. The
output-parsing contract lives in tests/cli_agent_test.ts.
"""

import pytest

from fast_rlm._runner import _CLI_PRESET_BINARIES, _cli_binaries


def test_preset_agents_map_to_their_binaries():
    assert _cli_binaries(["cli:claude-code"], None) == {"claude"}
    assert _cli_binaries(["cli:codex", "cli:opencode"], None) == {"codex", "opencode"}


def test_model_override_does_not_affect_the_binary():
    assert _cli_binaries(["cli:codex?model=gpt-5.5-codex"], None) == {"codex"}


def test_registered_agent_uses_its_own_command():
    registry = {"mycli": {"command": "mycli", "args": ["--json"]}}
    assert _cli_binaries(["cli:mycli"], registry) == {"mycli"}


def test_registered_agent_overrides_a_preset():
    """Re-declaring a preset name is how a user repairs it locally."""
    registry = {"codex": {"command": "/opt/custom/codex"}}
    assert _cli_binaries(["cli:codex"], registry) == {"/opt/custom/codex"}


def test_unknown_agent_falls_back_to_a_broad_grant():
    """An unresolvable name must not silently produce an empty allow-list.

    An empty set would render as `--allow-run=` and deny everything; the engine
    should be the thing that raises the descriptive "Unknown CLI agent" error.
    """
    assert _cli_binaries(["cli:nope"], None) == set()


def test_duplicate_agents_collapse():
    assert _cli_binaries(["cli:codex", "cli:codex"], None) == {"codex"}


def test_preset_binary_table_matches_the_engine():
    """This table mirrors PRESETS in src/cli_agent.ts — keep them in step."""
    import re
    from pathlib import Path

    source = Path(__file__).resolve().parent.parent / "src" / "cli_agent.ts"
    ts = source.read_text()
    # Preset keys as declared in the PRESETS object literal.
    block = ts.split("const PRESETS", 1)[1].split("\nexport function", 1)[0]
    names = set(re.findall(r'^    "([a-z-]+)": \{', block, re.M))
    assert names == set(_CLI_PRESET_BINARIES)


@pytest.mark.parametrize(
    "config,expected",
    [
        ({"primary_agent": "cli:claude-code?model=sonnet"}, {"claude"}),
        ({"primary_agent": "cli:claude-code?model=sonnet", "sub_agent": "cli:codex?model=gpt-5.5-codex"}, {"claude", "codex"}),
        # A cli: sub-agent under an API primary still needs the grant.
        ({"primary_agent": "z-ai/glm-5", "sub_agent": "cli:opencode?model=anthropic/claude-sonnet-5"}, {"opencode"}),
    ],
)
def test_cli_agents_do_not_trigger_the_acp_install_gate(monkeypatch, tmp_path, config, expected):
    """A `cli:` run must work with ACP uninstalled — that is the whole point."""
    monkeypatch.setenv("FAST_RLM_HOME", str(tmp_path))  # no ACP marker here

    import fast_rlm
    from fast_rlm import _acp_install

    assert _acp_install.is_installed() is False

    captured = {}

    def fake_popen(cmd, *a, **kw):
        captured["cmd"] = cmd
        raise RuntimeError("stop-before-launch")

    monkeypatch.setattr("subprocess.Popen", fake_popen)
    with pytest.raises(RuntimeError, match="stop-before-launch"):
        fast_rlm.run("hi", config=dict(config), log_dir=str(tmp_path))

    allow_run = [a for a in captured["cmd"] if a.startswith("--allow-run")]
    assert allow_run, "cli: agents need subprocess permission"
    # Scoped to exactly the binaries this run can spawn, never a blanket grant.
    assert allow_run[0] != "--allow-run"
    assert set(allow_run[0].removeprefix("--allow-run=").split(",")) == expected


# ---- Regressions from code review -------------------------------------------


def _cmd_for(monkeypatch, tmp_path, **run_kwargs):
    """Capture the Deno argv `run()` would launch."""
    import fast_rlm

    captured = {}

    def fake_popen(cmd, *a, **kw):
        captured["cmd"] = cmd
        raise RuntimeError("stop-before-launch")

    monkeypatch.setattr("subprocess.Popen", fake_popen)
    with pytest.raises(RuntimeError, match="stop-before-launch"):
        fast_rlm.run("hi", log_dir=str(tmp_path), **run_kwargs)
    return captured["cmd"]


def _allow_run(cmd):
    return [a for a in cmd if a.startswith("--allow-run")]


def test_only_one_allow_run_flag_is_ever_emitted(monkeypatch, tmp_path):
    """Deno unions repeated --allow-run flags, so a blanket one beside a scoped
    one silently widens it back to allow-all. Exactly one flag must be emitted."""
    cmd = _cmd_for(
        monkeypatch, tmp_path,
        config={"primary_agent": "cli:claude-code?model=sonnet"},
        mcp_servers={"fs": {"command": "npx", "args": ["-y", "@mcp/fs"]}},
    )
    flags = _allow_run(cmd)
    assert len(flags) == 1, flags


def test_stdio_mcp_grant_is_scoped_alongside_a_cli_agent(monkeypatch, tmp_path):
    cmd = _cmd_for(
        monkeypatch, tmp_path,
        config={"primary_agent": "cli:claude-code?model=sonnet"},
        mcp_servers={"fs": {"command": "npx", "args": ["-y", "@mcp/fs"]}},
    )
    (flag,) = _allow_run(cmd)
    assert set(flag.removeprefix("--allow-run=").split(",")) == {"claude", "npx"}


def test_http_only_mcp_needs_no_subprocess_grant(monkeypatch, tmp_path):
    cmd = _cmd_for(
        monkeypatch, tmp_path,
        config={"primary_agent": "z-ai/glm-5"},
        mcp_servers={"web": {"url": "http://localhost:3333/mcp"}},
    )
    assert _allow_run(cmd) == []


def test_vertex_and_cli_grants_merge(monkeypatch, tmp_path):
    cmd = _cmd_for(
        monkeypatch, tmp_path,
        config={"primary_agent": "cli:codex?model=gpt-5.5-codex"}, vertex=True,
    )
    (flag,) = _allow_run(cmd)
    assert set(flag.removeprefix("--allow-run=").split(",")) == {"codex", "gcloud"}


def test_allow_run_precedes_the_script_path(monkeypatch, tmp_path):
    """Deno permission flags are only honoured before the script argument."""
    cmd = _cmd_for(monkeypatch, tmp_path, config={"primary_agent": "cli:codex?model=gpt-5.5-codex"})
    (flag,) = _allow_run(cmd)
    assert cmd.index(flag) < cmd.index("src/subagents.ts")


def test_log_stats_survives_a_null_cost(tmp_path, capsys):
    """Backends that report no cost write an explicit null, which a dict default
    never catches — `--stats` used to crash with a TypeError on those logs."""
    import json

    from fast_rlm._cli import _print_stats

    log = tmp_path / "run.jsonl"
    log.write_text("\n".join(json.dumps(e) for e in [
        {"event_type": "code_generated", "run_id": "r1", "depth": 0,
         "usage": {"total_tokens": 10, "cost": None}},
        {"event_type": "execution_result", "run_id": "r1", "depth": 0,
         "usage": {"total_tokens": None, "cost": 0.5}},
    ]))
    _print_stats(str(log))
    out = capsys.readouterr().out
    assert "Total cost:   $0.500000" in out
    assert "Total tokens: 10" in out


# ---- API-key auth guard ------------------------------------------------------
#
# `claude` silently prefers ANTHROPIC_API_KEY over an interactive subscription
# login. A run that looks like it is using your plan is metered instead, with no
# warning fast-rlm can see — so it is refused outright.


def test_claude_cli_refuses_to_run_with_an_api_key_set(monkeypatch, tmp_path):
    import fast_rlm

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-fake")
    with pytest.raises(RuntimeError) as e:
        fast_rlm.run("hi", config={"primary_agent": "cli:claude-code?model=sonnet"}, log_dir=str(tmp_path))
    msg = str(e.value)
    assert "ANTHROPIC_API_KEY" in msg
    assert "unset ANTHROPIC_API_KEY" in msg      # the fix
    assert "cli_allow_api_key" in msg            # the escape hatch


def test_the_guard_fires_before_anything_is_spawned(monkeypatch, tmp_path):
    """It must cost nothing — no subprocess, no tokens."""
    import fast_rlm

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-fake")
    monkeypatch.setattr("subprocess.Popen", lambda *a, **k: pytest.fail("spawned a process"))
    with pytest.raises(RuntimeError, match="refuses to run"):
        fast_rlm.run("hi", config={"primary_agent": "cli:claude-code?model=sonnet"}, log_dir=str(tmp_path))


def test_guard_applies_to_a_sub_agent_too(monkeypatch, tmp_path):
    import fast_rlm

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-fake")
    with pytest.raises(RuntimeError, match="refuses to run"):
        fast_rlm.run(
            "hi",
            config={"primary_agent": "z-ai/glm-5", "sub_agent": "cli:claude-code?model=sonnet"},
            log_dir=str(tmp_path),
        )


def test_model_override_does_not_evade_the_guard(monkeypatch, tmp_path):
    import fast_rlm

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-fake")
    with pytest.raises(RuntimeError, match="refuses to run"):
        fast_rlm.run(
            "hi",
            config={"primary_agent": "cli:claude-code?model=opus"},
            log_dir=str(tmp_path),
        )


@pytest.mark.parametrize("override", ["cli_allow_api_key", "cli_minimal"])
def test_explicit_opt_in_permits_api_billing(monkeypatch, tmp_path, override):
    """`cli_minimal` implies it: --bare cannot read a subscription login at all."""
    import fast_rlm

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-fake")
    monkeypatch.setattr(
        "subprocess.Popen",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("reached-spawn")),
    )
    with pytest.raises(RuntimeError, match="reached-spawn"):
        fast_rlm.run(
            "hi",
            config={"primary_agent": "cli:claude-code?model=sonnet", override: True},
            log_dir=str(tmp_path),
        )


def test_other_presets_are_unaffected(monkeypatch, tmp_path):
    """Only agents that declare forbid_env are guarded."""
    import fast_rlm

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-fake")
    monkeypatch.setattr(
        "subprocess.Popen",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("reached-spawn")),
    )
    for agent in ("cli:codex?model=gpt-5.5-codex", "cli:opencode?model=x/y"):
        with pytest.raises(RuntimeError, match="reached-spawn"):
            fast_rlm.run("hi", config={"primary_agent": agent}, log_dir=str(tmp_path))


def test_registered_agent_can_declare_its_own_forbidden_env(monkeypatch, tmp_path):
    import fast_rlm

    monkeypatch.setenv("SOME_VENDOR_KEY", "x")
    with pytest.raises(RuntimeError, match="SOME_VENDOR_KEY"):
        fast_rlm.run(
            "hi",
            config={
                "primary_agent": "cli:mine",
                "cli_agents": {"mine": {"command": "mine", "forbid_env": ["SOME_VENDOR_KEY"]}},
            },
            log_dir=str(tmp_path),
        )


def test_forbidden_env_table_matches_the_engine():
    """This table mirrors `forbid_env` in src/cli_agent.ts — keep them in step."""
    from pathlib import Path

    from fast_rlm._runner import _CLI_PRESET_FORBIDDEN_ENV

    ts = (Path(__file__).resolve().parent.parent / "src" / "cli_agent.ts").read_text()
    block = ts.split("const PRESETS", 1)[1].split("\nexport function", 1)[0]
    for name, keys in _CLI_PRESET_FORBIDDEN_ENV.items():
        for key in keys:
            assert f'forbid_env: ["{key}"]' in block, f"{name}: {key} missing from the preset"


# ---- explicit model requirement ----------------------------------------------
#
# Left unset, the model is whatever the vendor's CLI defaults to: it drifts
# between releases, it is invisible in the run config, and for Claude Code it is
# Opus, the most expensive option. fast-rlm refuses to guess.


@pytest.mark.parametrize("agent", ["cli:claude-code", "cli:codex", "cli:opencode"])
def test_every_preset_requires_an_explicit_model(monkeypatch, tmp_path, agent):
    import fast_rlm

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr("subprocess.Popen", lambda *a, **k: pytest.fail("spawned a process"))
    with pytest.raises(RuntimeError) as e:
        fast_rlm.run("hi", config={"primary_agent": agent}, log_dir=str(tmp_path))
    msg = str(e.value)
    assert "does not specify a model" in msg
    assert "?model=" in msg  # tells you how to fix it


def test_a_cli_sub_agent_needs_a_model_too(monkeypatch, tmp_path):
    import fast_rlm

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="does not specify a model"):
        fast_rlm.run(
            "hi",
            config={"primary_agent": "cli:codex?model=gpt-5.5-codex", "sub_agent": "cli:opencode"},
            log_dir=str(tmp_path),
        )


@pytest.mark.parametrize("model", ["sonnet", "claude-sonnet-5"])
def test_alias_and_exact_id_both_satisfy_the_requirement(monkeypatch, tmp_path, model):
    import fast_rlm

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(
        "subprocess.Popen",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("reached-spawn")),
    )
    with pytest.raises(RuntimeError, match="reached-spawn"):
        fast_rlm.run(
            "hi",
            config={"primary_agent": f"cli:claude-code?model={model}"},
            log_dir=str(tmp_path),
        )


def test_a_registered_agents_own_model_satisfies_it(monkeypatch, tmp_path):
    """`model` on the cli_agents entry is the per-project way to set it."""
    import fast_rlm

    monkeypatch.setattr(
        "subprocess.Popen",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("reached-spawn")),
    )
    with pytest.raises(RuntimeError, match="reached-spawn"):
        fast_rlm.run(
            "hi",
            config={
                "primary_agent": "cli:mine",
                "cli_agents": {
                    "mine": {"command": "mine", "model_flag": "-m", "model": "some-model"}
                },
            },
            log_dir=str(tmp_path),
        )


def test_an_agent_with_no_model_flag_needs_no_model(monkeypatch, tmp_path):
    """Nothing to pass it to — requiring one would be nonsense."""
    import fast_rlm

    monkeypatch.setattr(
        "subprocess.Popen",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("reached-spawn")),
    )
    with pytest.raises(RuntimeError, match="reached-spawn"):
        fast_rlm.run(
            "hi",
            config={
                "primary_agent": "cli:fixed",
                "cli_agents": {"mine": {}, "fixed": {"command": "fixed"}},
            },
            log_dir=str(tmp_path),
        )


def test_no_preset_ships_a_default_model():
    """A preset picking a model is exactly what this requirement rules out."""
    from pathlib import Path

    ts = (Path(__file__).resolve().parent.parent / "src" / "cli_agent.ts").read_text()
    block = ts.split("const PRESETS", 1)[1].split("\nexport function", 1)[0]
    assert "\n        model:" not in block, "a preset sets a default model"
