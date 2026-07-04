"""Persistent, resumable sessions.

A Session lets follow-up queries reuse the work of earlier ones: the root
agent's picklable REPL variables (plus REPL-defined functions as source, and
comments describing them) are swept to disk after every step, and the next
query restores them and shows the agent the prior queries + code so it
continues where it left off.

Where state lives is decided by two optional arguments:

- ``Session()`` — no id, no dir — an **ephemeral** session. State is kept for
  the lifetime of this object in a private temp directory that is deleted when
  the object is garbage-collected / ``close()``d / the process exits. Queries in
  the same object still see each other's variables, but nothing persists to a
  location you (or a later run) could accidentally resume. This is the safe
  default for experiments — every ``Session()`` starts from a clean slate.
- ``Session(session_dir="runs/podcasts")`` — **persistent**, state at
  ``runs/podcasts/state.json``. Re-open the same dir to resume.
- ``Session(session_dir="runs", session_id="podcasts")`` — persistent, state at
  ``runs/podcasts/state.json``. Use ``session_id`` to namespace several sessions
  under one ``session_dir``. Passing ``session_id`` without ``session_dir``
  raises ``ValueError``.

Persistent sessions are crash-safe by construction: state is written per step,
so a killed process resumes from its last completed step.

This is intentionally NOT a 1:1 process clone — open handles, generators, and
JS proxies are dropped (and reported to the agent on resume).

Example:
    import fast_rlm

    session = fast_rlm.Session(session_dir="runs", session_id="podcasts",
                               config={"primary_agent": "..."})
    r1 = session.query("Here are the transcripts... Build an index and "
                       "summarize what the ML guests said about AGI.\\n" + transcripts)
    r2 = session.query("Using what you already built: which guests changed "
                       "their mind about AGI timelines?")
"""
import json
import os
import shutil
import tempfile
import weakref
from typing import Any, Optional

from fast_rlm._runner import RLMConfig, resolve_session_dir, run


class Session:
    """A resumable fast-rlm session.

    Args:
        session_id: Optional name for the session. Requires ``session_dir``;
            state lives in ``<session_dir>/<session_id>``.
        session_dir: Optional directory for the session state (created if
            missing). Omit both ``session_id`` and ``session_dir`` for an
            ephemeral in-memory session (temp dir, auto-deleted).
        config: RLMConfig or dict, passed to every ``query()`` (a per-query
            ``config=`` overrides it).
        add_session_code_to_context: Include earlier queries' code in the resume
            preamble (default ``True``); speeds up follow-ups by letting the
            agent reuse how it built things. Set ``False`` to omit it and keep
            the resume prompt smaller. A per-query kwarg overrides it.
        **run_defaults: Default kwargs applied to every ``query()`` call
            (e.g. ``tools=[...]``, ``verbosity="summary"``); per-query kwargs
            override them.
    """

    def __init__(
        self,
        session_id: Optional[str] = None,
        session_dir: Optional[str] = None,
        config: Optional["RLMConfig | dict"] = None,
        add_session_code_to_context: bool = True,
        **run_defaults: Any,
    ):
        # Validate the (id, dir) combination up front (id without dir -> error).
        self._persistent_dir = resolve_session_dir(session_id, session_dir)
        self.session_id = session_id
        self.session_dir = session_dir
        self._config = config
        self._run_defaults = run_defaults
        self._run_defaults.setdefault(
            "add_session_code_to_context", add_session_code_to_context
        )

        # Ephemeral (neither given): state lives in a temp dir created lazily on
        # the first query and removed when this object is collected / closed.
        self._ephemeral = self._persistent_dir is None
        self._temp_dir: Optional[str] = None
        self._finalizer: Optional[weakref.finalize] = None

    @property
    def _dir(self) -> str:
        """The directory holding ``state.json`` for this run (creates the temp
        dir on first use for ephemeral sessions)."""
        if not self._ephemeral:
            return self._persistent_dir
        if self._temp_dir is None:
            self._temp_dir = tempfile.mkdtemp(prefix="fastrlm-session-")
            # Delete the temp dir when the Session is GC'd or the process exits.
            self._finalizer = weakref.finalize(
                self, shutil.rmtree, self._temp_dir, ignore_errors=True
            )
        return self._temp_dir

    @property
    def state_file(self) -> Optional[str]:
        """Path to this session's ``state.json`` (``None`` for an ephemeral
        session that has not run a query yet)."""
        d = self._temp_dir if self._ephemeral else self._persistent_dir
        return os.path.join(d, "state.json") if d else None

    def query(self, query: "str | dict | list | None" = None, **kwargs: Any) -> dict:
        """Run one query in this session (same signature/result as fast_rlm.run)."""
        merged = {**self._run_defaults, **kwargs}
        merged.setdefault("config", self._config)
        # self._dir is already the fully resolved directory; pass it as
        # session_dir (no session_id) so run() writes straight into it.
        return run(query, session_dir=self._dir, **merged)

    def close(self) -> None:
        """Delete the temp dir of an ephemeral session (no-op when persistent).

        Called automatically on garbage collection and process exit; call it
        explicitly to free the state early or use the object as a context
        manager (``with fast_rlm.Session() as s: ...``).
        """
        if self._finalizer is not None:
            self._finalizer()  # runs shutil.rmtree once; further calls are no-ops
            self._temp_dir = None

    def __enter__(self) -> "Session":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ---- inspection (host-side; never unpickles the stored values) ----------

    def _state(self) -> dict:
        sf = self.state_file
        if not sf or not os.path.exists(sf):
            return {}
        with open(sf, encoding="utf-8") as f:
            return json.load(f)

    def queries(self) -> list[dict]:
        """Ledger of completed queries: [{"query": ..., "final": ...}, ...]."""
        return self._state().get("queries", [])

    def variables(self) -> dict[str, dict]:
        """Saved variables' metadata: {name: {type, preview, comment, note, committed}}.

        Values stay pickled on disk (they are unpickled only inside the REPL on
        resume); this returns the human-readable metadata.
        """
        out = {}
        for name, meta in self._state().get("variables", {}).items():
            out[name] = {k: v for k, v in meta.items() if k != "pickle_b64"}
        return out

    def functions(self) -> dict[str, str]:
        """Saved REPL-defined functions/classes: {name: source}."""
        return self._state().get("functions", {})

    def dropped(self) -> dict[str, str]:
        """Variables that could not be saved: {name: reason}."""
        return self._state().get("dropped", {})

    def clear(self) -> None:
        """Delete the session state (the next query starts fresh)."""
        sf = self.state_file
        if sf and os.path.exists(sf):
            os.unlink(sf)
