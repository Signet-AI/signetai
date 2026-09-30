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

export function isDesktopWorkspacePath(
	pathValue: string,
	options: { readonly env?: NodeJS.ProcessEnv; readonly home?: string } = {},
): boolean {
	try {
		const env = options.env ?? process.env;
		const resolved =
			options.home === undefined ? resolveWorkspacePath({ env }) : resolveWorkspacePath({ env, home: options.home });
		return resolved.source !== "env" && normalizeCore(pathValue) === resolved.path;
	} catch {
		return false;
	}
}

export function writeConfiguredWorkspacePath(pathValue: string, env: NodeJS.ProcessEnv = process.env): string {
	return writeCore(pathValue, env);
}

export function clearConfiguredWorkspacePath(env: NodeJS.ProcessEnv = process.env): void {
	clearCore(env);
}
