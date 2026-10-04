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

const LOCK_WAIT_MS = 10_000;
const LOCK_RETRY_MS = 100;

export function runWorkspaceLayoutStartup(
	env: NodeJS.ProcessEnv = process.env,
	argv: readonly string[] = process.argv,
	lockWaitMs = LOCK_WAIT_MS,
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
		const deadline = Date.now() + lockWaitMs;
		for (;;) {
			const directory = lockDirectory(root);
			const lock = acquireSingleInstanceLock(join(directory, "daemon.lock"));
			if (lock !== null && lockDirectory(root) === directory) {
				try {
					return upgradeWorkspaceLayout(root);
				} finally {
					releaseSingleInstanceLock(lock);
				}
			}
			if (lock !== null) releaseSingleInstanceLock(lock);
			if (Date.now() >= deadline) return { status: "skipped", reason: "another daemon holds the workspace lock" };
			Bun.sleepSync(LOCK_RETRY_MS);
		}
	} catch (error) {
		return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
	}
}
export const workspaceLayoutStartup = runWorkspaceLayoutStartup();
