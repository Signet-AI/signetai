import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { WORKSPACE_LAYOUT_V2, preflightWorkspace, resolveDefaultBasePath, resolveWorkspaceLayout } from "@signet/core";
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

function lockDirectories(root: string): string[] {
	const runtime = resolveWorkspaceLayout(root).runtime;
	const record = readWorkspaceLayoutUpgradeRecord(root);
	if (record?.state !== "in-progress") return [runtime];
	const moved = record.moves.find((move) => resolve(root, move.from) === runtime);
	const candidates = moved ? [runtime, resolve(root, moved.to)] : [runtime];
	const existing = candidates.filter((directory) => existsSync(directory));
	return (existing.length > 0 ? existing : [candidates[candidates.length - 1] ?? runtime]).sort();
}

function acquireAll(directories: readonly string[]): ReturnType<typeof acquireSingleInstanceLock>[] | null {
	const held: NonNullable<ReturnType<typeof acquireSingleInstanceLock>>[] = [];
	for (const directory of directories) {
		const lock = acquireSingleInstanceLock(join(directory, "daemon.lock"));
		if (lock === null) {
			for (const release of held) releaseSingleInstanceLock(release);
			return null;
		}
		held.push(lock);
	}
	return held;
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
		const upgradeRecord = existsSync(root) ? readWorkspaceLayoutUpgradeRecord(root) : null;
		const interrupted = upgradeRecord?.state === "in-progress";
		if (!interrupted && (workspace.status === "missing" || workspace.status === "incomplete"))
			return { status: "skipped", reason: `workspace is ${workspace.status}` };
		if (
			!interrupted &&
			upgradeRecord === null &&
			existsSync(root) &&
			resolveWorkspaceLayout(root).version === WORKSPACE_LAYOUT_V2
		)
			return { status: "current" };
		mkdirSync(root, { recursive: true });
		const deadline = Date.now() + lockWaitMs;
		for (;;) {
			const directories = lockDirectories(root);
			const locks = acquireAll(directories);
			const stable = locks !== null && lockDirectories(root).join("\0") === directories.join("\0");
			if (locks !== null && stable) {
				try {
					return upgradeWorkspaceLayout(root);
				} finally {
					for (const lock of locks) if (lock) releaseSingleInstanceLock(lock);
				}
			}
			if (locks !== null) for (const lock of locks) if (lock) releaseSingleInstanceLock(lock);
			if (Date.now() >= deadline) return { status: "skipped", reason: "another daemon holds the workspace lock" };
			Bun.sleepSync(LOCK_RETRY_MS);
		}
	} catch (error) {
		return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
	}
}
export const workspaceLayoutStartup = runWorkspaceLayoutStartup();
