import type { Command } from "commander";
import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { persistWorkspaceLayout, resolveWorkspaceLayout } from "@signet/core";
import { MigrationEngine, type MigrationDeps, type Layout } from "../lib/migration-engine.js";
import { createDatabase } from "../sqlite.js";
import { resolveAgentsDir, writeConfiguredWorkspacePath } from "../lib/workspace.js";
import { stopDaemon } from "../lib/runtime.js";

export type MigrationCommandDeps = {
	createEngine?: (options: { source?: string; destination?: string }) => MigrationEngine;
	stdout?: Pick<Console, "log" | "error">;
};

function defaultEngine(options: { source?: string; destination?: string }): MigrationEngine {
	const source = resolve(options.source ?? resolveAgentsDir().path);
	const destination = resolve(
		options.destination ?? join(dirname(source), `${source.split("/").pop() ?? "workspace"}-v2`),
	);
	const sourceLayout = resolveWorkspaceLayout(source);
	if (sourceLayout.version !== 1) throw new Error("workspace is not a v1 layout");
	const state = process.env.XDG_STATE_HOME
		? join(process.env.XDG_STATE_HOME, "signet", "migrations")
		: join(homedir(), ".local", "state", "signet", "migrations");
	const resolver = {
		resolve: (): Layout => ({ version: 1, root: source, destination }),
		cutover: async () => {
			// Persist the canonical layout first; the pointer is published last.
			const legacyDefaults = {
				database: join(source, "memory", "memories.db"),
				transcripts: join(source, "memory"),
				runtime: join(source, ".daemon"),
				cache: join(source, "memory", "cache"),
				files: join(source, "files"),
				imports: join(source, "memory", "imports"),
				secrets: join(source, ".secrets"),
				skills: join(source, "skills"),
				data: join(source, "memory"),
			} as const;
			const overrides = Object.fromEntries(
				Object.entries(legacyDefaults)
					.filter(([key, value]) => sourceLayout[key as keyof typeof legacyDefaults] !== value)
					.map(([key]) => [
						key,
						sourceLayout[key as keyof typeof legacyDefaults].startsWith(source)
							? sourceLayout[key as keyof typeof legacyDefaults].slice(source.length + 1)
							: sourceLayout[key as keyof typeof legacyDefaults],
					]),
			);
			persistWorkspaceLayout(destination, { version: 2, overrides });
			writeConfiguredWorkspacePath(destination);
		},
	};
	const leasePath = join(state, `${source.replaceAll("/", "_")}.lease`);
	const acquireLease = async () => {
		mkdirSync(state, { recursive: true, mode: 0o700 });
		let fd: number;
		try {
			fd = openSync(leasePath, "wx", 0o600);
		} catch {
			throw new Error("another migration is already running");
		}
		return {
			release: async () => {
				closeSync(fd);
				unlinkSync(leasePath);
			},
		};
	};
	const deps: MigrationDeps = {
		resolver,
		lease: { acquire: acquireLease },
		writers: { drain: async () => ((await stopDaemon(source)) ? { owners: [] } : { owners: ["daemon"] }) },
		database: {
			snapshot: async (path) => {
				const target = join(path, "data", "signet.db");
				mkdirSync(dirname(target), { recursive: true });
				if (existsSync(sourceLayout.database)) {
					const db = createDatabase(sourceLayout.database) as unknown as {
						backup?: (path: string) => void;
						close(): void;
					};
					if (typeof db.backup === "function") db.backup(target);
					else throw new Error("SQLite backup API unavailable");
					if (typeof db.close === "function") db.close();
				}
				return { path: target, bytes: statTree(target) };
			},
			verify: async (path) => {
				const db = createDatabase(path);
				const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
				db.close();
				return row?.integrity_check === "ok";
			},
		},
		journalStateDir: state,
	};
	return new MigrationEngine(deps);
}

function statTree(path: string): number {
	if (!existsSync(path)) return 0;
	const stat = statSync(path);
	if (stat.isFile()) return stat.size;
	return 0;
}

export function registerMigrationCommands(program: Command, deps: MigrationCommandDeps = {}): void {
	const out = deps.stdout ?? console;
	const factory = deps.createEngine ?? defaultEngine;
	const migration = program.command("migration").description("Manage the v1 to v2 workspace migration");
	const options = (cmd: Command) =>
		cmd.option("--source <path>", "v1 workspace root").option("--destination <path>", "v2 workspace root");

	options(migration.command("preflight").description("Inspect migration without writing")).action(async (opts) => {
		const plan = await factory(opts).preflight();
		out.log(JSON.stringify(plan));
	});
	for (const name of ["run", "resume"] as const) {
		options(
			migration.command(name).description(name === "run" ? "Run the migration" : "Resume an interrupted migration"),
		).action(async (opts) => {
			const result = await factory(opts)[name]();
			out.log(JSON.stringify(result));
		});
	}
	options(migration.command("status").description("Show migration progress and blockers")).action(async (opts) => {
		out.log(JSON.stringify(await factory(opts).status()));
	});
	options(migration.command("rollback").description("Rollback before destination writes")).action(async (opts) => {
		await factory(opts).rollback();
		out.log(JSON.stringify({ status: "rolled-back" }));
	});
	options(migration.command("cleanup").description("Remove a completed migration journal after acceptance"))
		.option("--accept", "Confirm the destination has been accepted")
		.action(async (opts) => {
			await factory(opts).cleanup(opts.accept === true);
			out.log(JSON.stringify({ status: "cleaned" }));
		});
}
