import { expect, test } from "bun:test";
import {
	WorkspaceMigrationService,
	type WorkspaceMigrationDependencies,
	isTrustedMigrationDashboardUrl,
} from "./workspace-migration.js";

const source = "/home/example/.agents";
const destination = "/home/example/.agents-v2";

function makeService(overrides: Partial<WorkspaceMigrationDependencies> = {}) {
	const calls: Array<{ action: string; source: string }> = [];
	const restarts: string[] = [];
	const dependencies: WorkspaceMigrationDependencies = {
		workspace: { path: source, source: "config" },
		appVersion: "1.2.3",
		layoutVersion: () => 1,
		daemonStatus: async () => ({ running: true, owned: true, workspacePath: source }),
		ensureDaemon: async () => ({ running: true, workspacePath: source }),
		runWorker: async (action: "status" | "run" | "rollback", workspacePath: string) => {
			calls.push({ action, source: workspacePath });
			return action === "status"
				? { phase: "not-started", copied: 0, blocked: [] }
				: action === "rollback"
					? { status: "rolled-back" }
					: { status: "completed", destination };
		},
		configuredWorkspacePath: () => destination,
		relaunch: (path: string) => restarts.push(path),
		...overrides,
	};
	return { service: new WorkspaceMigrationService(dependencies), calls, restarts };
}

test("offers migration only for a v1 workspace with a matching daemon", async () => {
	const { service, calls } = makeService();
	const status = await service.status();
	expect(status).toMatchObject({ state: "available", available: true, phase: "not-started", appVersion: "1.2.3" });
	expect(calls).toEqual([{ action: "status", source }]);
});

test("offers rollback for an interrupted migration only when its destination is safely owned", async () => {
	const { service } = makeService({
		runWorker: async () => ({
			phase: "copying",
			rollbackEligible: true,
			destinationWrites: true,
			copied: 1,
			blocked: [],
		}),
	});
	expect(await service.status()).toMatchObject({ state: "interrupted", rollbackAvailable: true });
});

test("does not offer rollback before the migration created a destination", async () => {
	const { service } = makeService({
		runWorker: async () => ({
			phase: "drained",
			rollbackEligible: true,
			destinationWrites: false,
			copied: 0,
			blocked: [],
		}),
	});
	expect(await service.status()).toMatchObject({ state: "interrupted", rollbackAvailable: false });
});

test("does not offer migration when the matching daemon is attached rather than desktop-owned", async () => {
	const { service, calls } = makeService({
		daemonStatus: async () => ({ running: true, owned: false, workspacePath: source }),
	});
	expect(await service.status()).toMatchObject({
		state: "blocked",
		available: false,
		reason: "external-daemon",
	});
	expect(calls).toEqual([]);
});

test("does not offer migration for environment-selected or v2 workspaces", async () => {
	const environment = makeService({ workspace: { path: source, source: "env" } });
	expect(await environment.service.status()).toMatchObject({
		state: "blocked",
		available: false,
		reason: "environment-workspace",
	});
	expect(environment.calls).toEqual([]);

	const v2 = makeService({ layoutVersion: () => 2 });
	expect(await v2.service.status()).toMatchObject({ state: "completed", available: false });
	expect(v2.calls).toEqual([]);
});

test("one click runs the canonical migration for the resolved workspace and relaunches at its configured destination", async () => {
	const { service, calls, restarts } = makeService();
	const result = await service.run();
	expect(result).toEqual({ state: "completed" });
	expect(calls).toEqual([
		{ action: "status", source },
		{ action: "run", source },
	]);
	expect(restarts).toEqual([destination]);
});

test("rolls back an eligible interrupted copy without changing the configured workspace", async () => {
	const { service, calls, restarts } = makeService({
		runWorker: async (action, workspacePath) => {
			calls.push({ action, source: workspacePath });
			return action === "status"
				? { phase: "copying", rollbackEligible: true, destinationWrites: true, copied: 1, blocked: [] }
				: { status: "rolled-back" };
		},
		configuredWorkspacePath: () => source,
	});
	expect(await service.rollback()).toEqual({ state: "rolled-back" });
	expect(calls).toEqual([
		{ action: "status", source },
		{ action: "rollback", source },
	]);
	expect(restarts).toEqual([]);
});

test("fails closed if the daemon serves a different workspace", async () => {
	const { service, calls } = makeService({
		daemonStatus: async () => ({ running: true, owned: true, workspacePath: "/home/example/other" }),
	});
	expect(await service.status()).toMatchObject({ state: "blocked", available: false, reason: "daemon-unavailable" });
	expect(calls).toEqual([]);
});

test("accepts only the desktop dashboard origin for migration IPC", () => {
	expect(isTrustedMigrationDashboardUrl("app://signet/")).toBe(true);
	expect(isTrustedMigrationDashboardUrl("app://signet/settings/workspace")).toBe(true);
	expect(isTrustedMigrationDashboardUrl("app://signet.evil/")).toBe(false);
	expect(isTrustedMigrationDashboardUrl("https://signet/")).toBe(false);
	expect(isTrustedMigrationDashboardUrl(undefined)).toBe(false);
});
