import {
	type WorkspaceResolution,
	type WorkspaceSource,
	clearConfiguredWorkspacePath as clearCore,
	getWorkspaceConfigPath as getCore,
	normalizeWorkspacePath as normalizeCore,
	readConfiguredWorkspacePath as readCore,
	resolveWorkspacePath,
	writeConfiguredWorkspacePath as writeCore,
} from "@signet/core";

// Canonical Signet workspace resolution lives in @signet/core (issue #956).
// These thin wrappers preserve the CLI's historical default-argument shape
// (resolving against process.env at call time) while delegating to the single
// shared implementation, so the CLI, desktop shell, and connectors can no
// longer drift on env-var precedence or the workspace.json schema.

export type { WorkspaceSource, WorkspaceResolution };

export function normalizeWorkspacePath(pathValue: string): string {
	return normalizeCore(pathValue);
}

export function getWorkspaceConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return getCore(env);
}

export function readConfiguredWorkspacePath(env: NodeJS.ProcessEnv = process.env): string | null {
	return readCore(env);
}

export function resolveAgentsDir(env: NodeJS.ProcessEnv = process.env): WorkspaceResolution {
	return resolveWorkspacePath({ env });
}

export function writeConfiguredWorkspacePath(pathValue: string, env: NodeJS.ProcessEnv = process.env): string {
	return writeCore(pathValue, env);
}

export function clearConfiguredWorkspacePath(env: NodeJS.ProcessEnv = process.env): void {
	clearCore(env);
}
