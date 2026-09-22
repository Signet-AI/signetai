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
