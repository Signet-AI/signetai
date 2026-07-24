import { homedir } from "node:os";
import { type WorkspaceResolution, type WorkspaceSource, resolveWorkspacePath } from "@signet/core";

// Canonical Signet workspace resolution lives in @signet/core (issue #956).
// The desktop shell delegates to the single shared implementation so env-var
// precedence (SIGNET_PATH then SIGNET_WORKSPACE) and the workspace.json schema
// can no longer drift from the CLI and connectors.

export type DesktopWorkspaceSource = WorkspaceSource;
export type DesktopWorkspaceResolution = WorkspaceResolution;

export function resolveDesktopWorkspace(
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
): DesktopWorkspaceResolution {
	return resolveWorkspacePath({ env, home });
}

export function applyDesktopWorkspaceEnv(
	resolution: DesktopWorkspaceResolution,
	env: NodeJS.ProcessEnv = process.env,
): DesktopWorkspaceResolution {
	env.SIGNET_PATH = resolution.path;
	env.SIGNET_WORKSPACE = resolution.path;
	return resolution;
}
