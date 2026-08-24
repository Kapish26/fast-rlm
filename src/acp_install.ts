// Reader for the ACP install marker written by `fast-rlm acp install`.
//
// ACP is opt-in: its npm dependencies (the ACP provider and the Vercel AI SDK)
// are deliberately NOT in deno.json, so a plain run never resolves them. They
// are imported dynamically by acp.ts, using the exact specifiers recorded here.
//
// Keeping the versions in the marker rather than in the repo means a user can
// move to a newer ACP provider or bridge with `fast-rlm acp install -u`, with
// no fast-rlm release in the loop. The Python side owns writing this file — see
// fast_rlm/_acp_install.py, which defines the same shape.

export interface AcpMarker {
    marker_version: number;
    provider_version: string;
    ai_sdk_version: string;
    // Full npm: specifiers, e.g. "npm:@mcpc-tech/acp-ai-provider@0.3.6".
    provider_specifier: string;
    ai_sdk_specifier: string;
    // Preset name -> pinned bridge version, e.g. {"claude-code": "0.7.2"}.
    bridges: Record<string, string>;
    // Preset name -> bridge npm package name.
    bridge_packages: Record<string, string>;
}

const MARKER_VERSION = 1;

function homeDir(): string | null {
    return Deno.env.get("FAST_RLM_HOME")
        ?? Deno.env.get("HOME")
        ?? Deno.env.get("USERPROFILE")
        ?? null;
}

export function markerPath(): string | null {
    const home = homeDir();
    if (!home) return null;
    // FAST_RLM_HOME points at the state dir itself; HOME needs the .fast_rlm leaf.
    return Deno.env.get("FAST_RLM_HOME")
        ? `${home}/acp.json`
        : `${home}/.fast_rlm/acp.json`;
}

let cached: AcpMarker | null | undefined;

export function loadAcpMarker(): AcpMarker | null {
    if (cached !== undefined) return cached;
    cached = null;
    const path = markerPath();
    if (path) {
        try {
            const marker = JSON.parse(Deno.readTextFileSync(path)) as AcpMarker;
            if (marker && marker.marker_version === MARKER_VERSION) cached = marker;
        } catch { /* absent or unreadable -> not installed */ }
    }
    return cached;
}

export const ACP_NOT_INSTALLED =
    "ACP support is not installed.\n\n" +
    "  Install it:  fast-rlm acp install\n" +
    "  Or use the cli: backend, which needs no bridge packages and no Node:\n" +
    "               primary_agent=\"cli:claude-code\"  (or cli:codex / cli:opencode)";

// The marker, or a hard error naming the fix. Called by acp.ts before it
// resolves any npm dependency, so an uninstalled run fails with this message
// rather than a module-resolution stack trace.
export function requireAcpMarker(): AcpMarker {
    const marker = loadAcpMarker();
    if (!marker) throw new Error(ACP_NOT_INSTALLED);
    return marker;
}

// Swap a preset's bridge package for the exact `<pkg>@<version>` that
// `acp install` recorded, so npx fetches a pinned, reproducible bridge.
//
// Both halves come from the marker, which means a package RENAME is also a
// marker edit rather than a code change — upstream renames happen (see
// @zed-industries/claude-code-acp -> @agentclientprotocol/claude-agent-acp),
// and a user can follow one by editing bridge_packages in ~/.fast_rlm/acp.json
// without waiting for a fast-rlm release.
//
// `defaultPkg` is the arg to replace (the preset's own package name). Presets
// with no recorded pin are left untouched: npx resolves latest, which is the
// pre-marker behaviour.
export function pinBridgeArgs(
    presetName: string,
    args: string[],
    defaultPkg?: string,
): string[] {
    const marker = loadAcpMarker();
    const pkg = marker?.bridge_packages?.[presetName];
    const version = marker?.bridges?.[presetName];
    if (!pkg || !version) return args;
    const target = defaultPkg ?? pkg;
    return args.map((a) => (a === target || a === pkg ? `${pkg}@${version}` : a));
}
