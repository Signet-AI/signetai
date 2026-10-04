import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { preflightWorkspace, resolveDefaultBasePath, resolveWorkspaceLayout } from "@signet/core";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from "./single-instance-lock";
import {
	type WorkspaceLayoutUpgradeResult,
	readWorkspaceLayoutUpgradeRecord,
	upgradeWorkspaceLayout,
} from "./workspace-layout-upgrade";

export type WorkspaceLayoutStartup =
	| WorkspaceLayoutUpgradeResult
	| { readonly status: "failed"; readonly reason: string }
	| { readonly status: "not-daemon" };

function isDaemonProcess(env: NodeJS.ProcessEnv, argv: readonly string[]): boolean {
	if (env.SIGNET_DAEMON_ENTRYPOINT === "1") return true;
	const script = argv[1];
	if (!script) return false;
	try {
		return /^daemon\.[cm]?[jt]s$/.test(basename(realpathSync(script)));
	} catch {
		return false;
	}
}

function lockDirectory(root: string): string {
	const runtime = resolveWorkspaceLayout(root).runtime;
	const record = readWorkspaceLayoutUpgradeRecord(root);
	if (record?.state !== "in-progress" || existsSync(runtime)) return runtime;
	const moved = record.moves.find((move) => resolve(root, move.from) === runtime);
	return moved ? join(root, moved.to) : runtime;
}

export function runWorkspaceLayoutStartup(
	env: NodeJS.ProcessEnv = process.env,
	argv: readonly string[] = process.argv,
): WorkspaceLayoutStartup {
	if (!isDaemonProcess(env, argv)) return { status: "not-daemon" };
	try {
		const workspace = preflightWorkspace({ env });
		const root = resolve(resolveDefaultBasePath());
		if (resolve(workspace.path) !== root)
			return { status: "skipped", reason: "workspace selection is ambiguous at startup" };
		if (workspace.status === "missing" || workspace.status === "incomplete")
			return { status: "skipped", reason: `workspace is ${workspace.status}` };
		mkdirSync(root, { recursive: true });
		const lock = acquireSingleInstanceLock(join(lockDirectory(root), "daemon.lock"));
		if (lock === null) return { status: "skipped", reason: "another daemon holds the workspace lock" };
		try {
			return upgradeWorkspaceLayout(root);
		} finally {
			releaseSingleInstanceLock(lock);
		}
	} catch (error) {
		return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
	}
}

// Evaluated as the first import of daemon.ts: every later module binds workspace
// paths at load time, so the layout must be final before any of them load.
export const workspaceLayoutStartup = runWorkspaceLayoutStartup();
