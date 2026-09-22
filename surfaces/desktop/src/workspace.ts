import { homedir } from "node:os";
import { type WorkspaceResolution, type WorkspaceSource, resolveWorkspacePath } from "@signet/core";

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
