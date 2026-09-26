import { resolve } from "node:path";

export type WorkspaceMigrationUiState = "available" | "interrupted" | "completed" | "blocked" | "running" | "failed";
export interface WorkspaceMigrationUiStatus {
	readonly appVersion: string;
	readonly available: boolean;
	readonly state: WorkspaceMigrationUiState;
	readonly phase?: string;
	readonly copied?: number;
	readonly rollbackAvailable?: boolean;
	readonly blockers?: readonly string[];
	readonly reason?: string;
}

export interface WorkspaceMigrationDependencies {
	readonly workspace: { readonly path: string; readonly source: string };
	readonly appVersion: string;
	readonly layoutVersion: (workspacePath: string) => number;
	readonly daemonStatus: () => Promise<{
		readonly running: boolean;
		readonly owned: boolean;
		readonly workspacePath: string;
	}>;
	readonly ensureDaemon: () => Promise<unknown>;
	readonly runWorker: (action: "status" | "run" | "rollback", workspacePath: string) => Promise<unknown>;
	readonly configuredWorkspacePath: () => string;
	readonly relaunch: (workspacePath: string) => void;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function samePath(left: string, right: string): boolean {
	const a = resolve(left);
	const b = resolve(right);
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function isTrustedMigrationDashboardUrl(value: string | undefined): boolean {
	if (!value) return false;
	try {
		const url = new URL(value);
		return url.protocol === "app:" && url.hostname === "signet";
	} catch {
		return false;
	}
}

export class WorkspaceMigrationService {
	readonly #dependencies: WorkspaceMigrationDependencies;
	#running = false;

	constructor(dependencies: WorkspaceMigrationDependencies) {
		this.#dependencies = dependencies;
	}

	async status(): Promise<WorkspaceMigrationUiStatus> {
		const deps = this.#dependencies;
		if (this.#running) return { appVersion: deps.appVersion, available: false, state: "running" };
		if (deps.workspace.source === "env")
			return {
				appVersion: deps.appVersion,
				available: false,
				state: "blocked",
				reason: "environment-workspace",
			};

		let version: number;
		try {
			version = deps.layoutVersion(deps.workspace.path);
		} catch {
			return { appVersion: deps.appVersion, available: false, state: "blocked", reason: "invalid-layout" };
		}
		if (version === 2) return { appVersion: deps.appVersion, available: false, state: "completed" };
		if (version !== 1)
			return { appVersion: deps.appVersion, available: false, state: "blocked", reason: "unsupported-layout" };

		let daemon: {
			readonly running: boolean;
			readonly owned: boolean;
			readonly workspacePath: string;
		};
		try {
			daemon = await deps.daemonStatus();
		} catch {
			return { appVersion: deps.appVersion, available: false, state: "blocked", reason: "daemon-unavailable" };
		}
		if (!daemon.running || !samePath(daemon.workspacePath, deps.workspace.path))
			return { appVersion: deps.appVersion, available: false, state: "blocked", reason: "daemon-unavailable" };
		if (!daemon.owned)
			return { appVersion: deps.appVersion, available: false, state: "blocked", reason: "external-daemon" };

		let migration: Record<string, unknown> | null;
		try {
			migration = record(await deps.runWorker("status", deps.workspace.path));
		} catch {
			migration = null;
		}
		if (!migration || typeof migration.phase !== "string")
			return {
				appVersion: deps.appVersion,
				available: false,
				state: "blocked",
				reason: "migration-status-unavailable",
			};
		const phase = migration.phase;
		if (phase === "completed") return { appVersion: deps.appVersion, available: false, state: "completed", phase };
		const blockers = Array.isArray(migration.blocked)
			? migration.blocked.filter((blocker): blocker is string => typeof blocker === "string")
			: [];
		return {
			appVersion: deps.appVersion,
			available: true,
			state: phase === "not-started" ? "available" : "interrupted",
			phase,
			...(typeof migration.copied === "number" ? { copied: migration.copied } : {}),
			rollbackAvailable: migration.rollbackEligible === true && migration.destinationWrites === true,
			...(blockers.length > 0 ? { blockers } : {}),
		};
	}

	async rollback(): Promise<{ readonly state: "rolled-back" | "blocked" | "running" | "failed" }> {
		if (this.#running) return { state: "running" };
		const current = await this.status();
		if (!current.rollbackAvailable) return { state: current.state === "running" ? "running" : "blocked" };
		this.#running = true;
		const deps = this.#dependencies;
		try {
			const result = record(await deps.runWorker("rollback", deps.workspace.path));
			if (result?.status !== "rolled-back") throw new Error("migration runner returned an invalid rollback receipt");
			if (!samePath(deps.configuredWorkspacePath(), deps.workspace.path))
				throw new Error("workspace changed while migration rollback was running");
			return { state: "rolled-back" };
		} catch {
			try {
				const configuredPath = deps.configuredWorkspacePath();
				if (!samePath(configuredPath, deps.workspace.path)) deps.relaunch(configuredPath);
				else await deps.ensureDaemon();
			} catch {
			}
			return { state: "failed" };
		} finally {
			this.#running = false;
		}
	}

	async run(): Promise<{ readonly state: "completed" | "blocked" | "running" | "failed" }> {
		if (this.#running) return { state: "running" };
		const current = await this.status();
		if (!current.available) return { state: current.state === "running" ? "running" : "blocked" };
		this.#running = true;
		const deps = this.#dependencies;
		try {
			const result = record(await deps.runWorker("run", deps.workspace.path));
			if (result?.status !== "completed" || typeof result.destination !== "string")
				throw new Error("migration runner returned an invalid completion receipt");
			const configuredPath = deps.configuredWorkspacePath();
			if (!samePath(configuredPath, result.destination)) throw new Error("workspace cutover was not persisted");
			deps.relaunch(configuredPath);
			return { state: "completed" };
		} catch {
			try {
				const configuredPath = deps.configuredWorkspacePath();
				if (!samePath(configuredPath, deps.workspace.path)) deps.relaunch(configuredPath);
				else await deps.ensureDaemon();
			} catch {
			}
			return { state: "failed" };
		} finally {
			this.#running = false;
		}
	}
}
