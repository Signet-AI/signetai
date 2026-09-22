import type { Command } from "commander";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MigrationEngine, type MigrationDeps, type Layout } from "../lib/migration-engine.js";
import { resolveAgentsDir } from "../lib/workspace.js";

export type MigrationCommandDeps = {
	createEngine?: (options: { source?: string; destination?: string }) => MigrationEngine;
	stdout?: Pick<Console, "log" | "error">;
};

function defaultEngine(options: { source?: string; destination?: string }): MigrationEngine {
	const source = resolve(options.source ?? resolveAgentsDir().path);
	const destination = resolve(
		options.destination ?? join(dirname(source), `${source.split("/").pop() ?? "workspace"}-v2`),
	);
	const state = process.env.XDG_STATE_HOME
		? join(process.env.XDG_STATE_HOME, "signet", "migrations")
		: join(homedir(), ".local", "state", "signet", "migrations");
	const resolver = {
		resolve: (): Layout => ({ version: 1, root: source, destination }),
		cutover: async (layout: Layout) => {
			mkdirSync(destination, { recursive: true });
			writeFileSync(join(destination, ".signet-layout.json"), `${JSON.stringify({ version: 2, root: destination })}\n`);
			// The configured workspace is the only pointer consumed by CLI startup.
			writeFileSync(join(destination, ".migration-source"), `${layout.root}\n`);
		},
	};
	const deps: MigrationDeps = {
		resolver,
		writers: { drain: async () => ({ owners: [] }) },
		database: {
			snapshot: async (path) => ({ path, bytes: statTree(path) }),
			verify: async (path) => existsSync(path),
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
