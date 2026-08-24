"""ACP opt-in install state.

ACP support is NOT shipped with fast-rlm. It pulls two npm dependency trees
(the ACP provider and the Vercel AI SDK) plus, at run time, a per-agent bridge
package fetched through ``npx`` — so it is installed explicitly, once, by the
user:

    fast-rlm acp install        # first time
    fast-rlm acp install -u     # move to the latest versions

The resolved versions live in a marker file (``~/.fast_rlm/acp.json``) rather
than in the repo. That inverts the old arrangement, which had the provider
hard-pinned in ``deno.json`` (only a fast-rlm release could move it) while the
bridges were spawned unpinned via ``npx -y <pkg>`` (they drifted silently
between runs). Now the versions are user-owned data: runs are reproducible,
and ``-u`` is the single place they change — no fast-rlm release required to
pick up a new bridge.

Both sides read this file: the Python launcher (to gate the run and grant
``--allow-run``) and the Deno engine (to resolve the provider specifier and the
bridge versions) — see ``src/acp_install.ts``.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional

# npm packages ACP needs. Kept here, not in deno.json, so a plain (non-ACP) run
# never sees them in its module graph.
ACP_PROVIDER_PKG = "@mcpc-tech/acp-ai-provider"
AI_SDK_PKG = "ai"

# Bridge packages spawned via npx by the built-in presets in src/acp.ts. The
# preset's `args` carry the bare package name; the pinned version recorded here
# is appended at launch (`<pkg>@<version>`).
BRIDGE_PKGS = {
    "claude-code": "@zed-industries/claude-code-acp",
    "codex": "@zed-industries/codex-acp",
}

MARKER_VERSION = 1


def marker_dir() -> Path:
    """Directory holding fast-rlm's user-level state (override: FAST_RLM_HOME)."""
    env = os.environ.get("FAST_RLM_HOME")
    if env:
        return Path(env)
    return Path.home() / ".fast_rlm"


def marker_path() -> Path:
    return marker_dir() / "acp.json"


def load_marker() -> Optional[dict]:
    """The install marker, or None when ACP has not been installed."""
    try:
        with open(marker_path()) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or data.get("marker_version") != MARKER_VERSION:
        return None
    return data


def is_installed() -> bool:
    return load_marker() is not None


NOT_INSTALLED_MSG = """\
ACP support is not installed.

  {agent!r} needs the ACP bridge packages (the ACP provider + the Vercel AI SDK,
  fetched by Deno) and Node/npx to spawn the agent's bridge. These are not
  shipped with fast-rlm, so they are installed on demand:

      fast-rlm acp install

  Or skip ACP entirely: for Claude Code, Codex and opencode the cli: backend
  drives the agent's own CLI, needing no bridge packages and no Node —

      primary_agent: "cli:claude-code"   (or cli:codex / cli:opencode)
"""


def require_installed(agent: str) -> dict:
    """Return the marker, or raise the actionable not-installed error."""
    marker = load_marker()
    if marker is None:
        raise RuntimeError(NOT_INSTALLED_MSG.format(agent=agent))
    return marker


def _npm_latest(pkg: str) -> Optional[str]:
    """Latest published version of `pkg`, or None if npm can't be reached."""
    npm = shutil.which("npm")
    if npm is None:
        return None
    try:
        out = subprocess.run(
            [npm, "view", pkg, "version"],
            capture_output=True, text=True, timeout=60, check=True,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    version = out.stdout.strip()
    return version or None


def _npm_field(pkg_spec: str, field: str) -> Optional[str]:
    """`npm view <pkg_spec> <field>` as a stripped string, or None."""
    npm = shutil.which("npm")
    if npm is None:
        return None
    try:
        out = subprocess.run(
            [npm, "view", pkg_spec, field],
            capture_output=True, text=True, timeout=60, check=True,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    return out.stdout.strip() or None


def _resolve_ai_sdk(provider_version: str) -> Optional[str]:
    """Highest `ai` release satisfying what this provider version declares.

    The AI SDK is NOT resolved to latest independently: the ACP provider pins a
    major (e.g. `ai: ^6.0.0` while 7.x is current), so taking latest for both
    would install an incompatible pair. Ask the provider what it wants, then
    take the newest release inside that range.
    """
    spec = f"{ACP_PROVIDER_PKG}@{provider_version}"
    rng = _npm_field(spec, "dependencies.ai") or _npm_field(spec, "peerDependencies.ai")
    if not rng:
        return None
    # `npm view ai@<range> version` lists every match, oldest first, as either
    # bare versions (single match) or "ai@x.y.z 'x.y.z'" lines (multiple).
    listing = _npm_field(f"{AI_SDK_PKG}@{rng}", "version")
    if not listing:
        return None
    last = listing.splitlines()[-1].strip()
    if " " in last:  # "ai@6.0.264 '6.0.264'"
        last = last.split(" ", 1)[0].split("@")[-1]
    return last.strip("\"'") or None


def _cache_specifiers(specs: list[str]) -> None:
    """Pre-download npm specifiers into Deno's cache.

    ``deno cache`` only walks *static* imports, and acp.ts imports the provider
    and the AI SDK dynamically (that is the whole point — a non-ACP run must not
    resolve them). So generate a throwaway module that imports them statically
    and cache that instead.
    """
    from fast_rlm._runner import _deno_prefix_cmd  # local: keeps CLI --help cheap

    import tempfile

    src = "".join(f'import "{s}";\n' for s in specs)
    with tempfile.NamedTemporaryFile("w", suffix=".prewarm.ts", delete=False) as f:
        f.write(src)
        path = f.name
    try:
        subprocess.run(
            _deno_prefix_cmd() + ["cache", "--reload", path],
            check=True, timeout=600,
        )
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def install(update: bool = False) -> dict:
    """Install (or with `update`, upgrade) ACP support; returns the new marker.

    Without `update` an existing install is left on its recorded versions and
    only re-cached, so a repeat `install` is a repair, not a silent upgrade.
    """
    from fast_rlm._runner import _check_deno

    _check_deno()
    existing = load_marker() or {}
    old_provider = existing.get("provider_version")
    old_ai = existing.get("ai_sdk_version")
    old_bridges = existing.get("bridges", {})
    # Bridge package NAMES are user-editable: following an upstream rename is a
    # marker edit (see src/acp_install.ts), so an existing marker's names win
    # over the built-in defaults and versions are resolved against them. New
    # presets added by a fast-rlm upgrade are filled in from BRIDGE_PKGS.
    bridge_pkgs = {**BRIDGE_PKGS, **(existing.get("bridge_packages") or {})}

    def pick(current: Optional[str], pkg: str, required: bool = True) -> Optional[str]:
        if current and not update:
            return current
        latest = _npm_latest(pkg)
        if latest:
            return latest
        if current:
            print(f"  ! could not reach npm for {pkg}; keeping {current}")
            return current
        if not required:
            # Bridges are optional to pin: pinBridgeArgs falls back to unpinned
            # npx, so a lookup failure must not abort the whole install.
            print(f"  ! could not reach npm for {pkg}; it will resolve to latest at launch")
            return None
        raise RuntimeError(
            f"Could not resolve a version for {pkg}. npm must be on PATH and "
            f"reachable to install ACP support (`npm view {pkg} version`)."
        )

    print("Resolving ACP package versions...")
    provider_version = pick(old_provider, ACP_PROVIDER_PKG)
    # Derived from the provider, never resolved independently — see _resolve_ai_sdk.
    if old_ai and not update:
        ai_version = old_ai
    else:
        ai_version = _resolve_ai_sdk(provider_version) or old_ai
        if ai_version is None:
            raise RuntimeError(
                f"Could not determine which '{AI_SDK_PKG}' version "
                f"{ACP_PROVIDER_PKG}@{provider_version} requires. npm must be on "
                f"PATH and reachable to install ACP support."
            )
    bridges = {}
    for name, pkg in bridge_pkgs.items():
        version = pick(old_bridges.get(name), pkg, required=False)
        if version is not None:
            bridges[name] = version

    provider_spec = f"npm:{ACP_PROVIDER_PKG}@{provider_version}"
    ai_spec = f"npm:{AI_SDK_PKG}@{ai_version}"

    print(f"  {ACP_PROVIDER_PKG}@{provider_version}")
    print(f"  {AI_SDK_PKG}@{ai_version}")
    for name, version in bridges.items():
        print(f"  {bridge_pkgs[name]}@{version}  (bridge: acp:{name})")

    print("Downloading into Deno's cache...")
    _cache_specifiers([provider_spec, ai_spec])

    marker = {
        "marker_version": MARKER_VERSION,
        "provider_version": provider_version,
        "ai_sdk_version": ai_version,
        "provider_specifier": provider_spec,
        "ai_sdk_specifier": ai_spec,
        "bridges": bridges,
        "bridge_packages": bridge_pkgs,
    }
    marker_dir().mkdir(parents=True, exist_ok=True)
    with open(marker_path(), "w") as f:
        json.dump(marker, f, indent=2)
    print(f"\nACP support installed. Marker: {marker_path()}")
    if shutil.which("npx") is None:
        print("  ! npx is not on PATH — the claude-code and codex bridges need it.")
    return marker


def status() -> int:
    """Print install state and available upgrades. Returns a shell exit code."""
    marker = load_marker()
    if marker is None:
        print("ACP support: not installed")
        print(f"  marker: {marker_path()} (absent)")
        print("  install with: fast-rlm acp install")
        return 1

    print("ACP support: installed")
    print(f"  marker: {marker_path()}")
    provider_version = marker.get("provider_version")
    rows = [
        (ACP_PROVIDER_PKG, provider_version, None),
        # Bounded by the provider's declared range, so "latest" is the newest
        # compatible release rather than the newest release overall. A marker
        # missing provider_version (hand-edited) simply skips the range lookup.
        (
            AI_SDK_PKG,
            marker.get("ai_sdk_version"),
            _resolve_ai_sdk(provider_version) if provider_version else None,
        ),
    ]
    # Package names come from the marker so a rename shows the renamed package.
    marker_pkgs = {**BRIDGE_PKGS, **(marker.get("bridge_packages") or {})}
    rows += [
        (marker_pkgs.get(name, name), version, None)
        for name, version in (marker.get("bridges") or {}).items()
    ]
    stale = False
    for pkg, version, pinned_latest in rows:
        if not version:
            # Hand-edited or partially-written marker: report the gap rather
            # than rendering "<pkg>@None" and comparing it against npm.
            print(f"  {pkg}: version not recorded — repair with: fast-rlm acp install")
            stale = True
            continue
        latest = pinned_latest if pinned_latest is not None else _npm_latest(pkg)
        if latest is None:
            note = "  (npm unreachable)"
        elif latest != version:
            note = f"  -> {latest} available"
            stale = True
        else:
            note = "  (latest)"
        print(f"  {pkg}@{version}{note}")
    if stale:
        print("\n  upgrade with: fast-rlm acp install -u")
    print(f"\n  npx on PATH: {'yes' if shutil.which('npx') else 'NO — bridges need it'}")
    return 0
