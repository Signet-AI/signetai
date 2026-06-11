import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
	collectExportData,
	importEntities,
	importMemories,
	importRelations,
	loadSqliteVec,
	runMigrations,
	serializeExportData,
} from "@signet/core";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import Database from "../sqlite.js";

interface PortableDeps {
	readonly AGENTS_DIR: string;
}

export function registerPortableCommands(program: Command, deps: PortableDeps): void {
	program
		.command("export")
		.description("Export agent identity, memories, and skills to a portable bundle")
		.option("-o, --output <path>", "Output file path")
		.option("--include-embeddings", "Include embedding vectors (can be regenerated)")
		.option("--json", "Output as JSON instead of ZIP")
		.action(async (options) => {
			const agentsDir = deps.AGENTS_DIR;
			const dbPath = join(agentsDir, "memory", "memories.db");

			if (!existsSync(dbPath)) {
				console.error(chalk.red("  No memory database found. Nothing to export."));
				process.exit(1);
			}

			const spinner = ora("Collecting export data...").start();
			let db: ReturnType<typeof Database> | null = null;
			try {
				db = new Database(dbPath, { readonly: true });
				try {
					loadSqliteVec(db);
				} catch {
					// Non-fatal
				}

				const data = collectExportData(agentsDir, db, {
					includeEmbeddings: options.includeEmbeddings,
					includeSkills: true,
				});

				const fileMap = serializeExportData(data);
				const today = new Date().toISOString().slice(0, 10);
				const defaultName = `signet-export-${today}`;

				if (options.json) {
					const outPath = options.output || `${defaultName}.json`;
					writeFileSync(outPath, JSON.stringify(Object.fromEntries(fileMap), null, 2));
					spinner.succeed(`Exported to ${chalk.cyan(outPath)}`);
				} else {
					const outDir = options.output || defaultName;
					mkdirSync(outDir, { recursive: true });
					for (const [path, content] of fileMap) {
						const fullPath = join(outDir, path);
						mkdirSync(dirname(fullPath), { recursive: true });
						writeFileSync(fullPath, content);
					}
					spinner.succeed(`Exported to ${chalk.cyan(`${outDir}/`)}`);
				}

				console.log(chalk.dim(`  ${data.manifest.stats.memories} memories`));
				console.log(chalk.dim(`  ${data.manifest.stats.entities} entities`));
				console.log(chalk.dim(`  ${data.manifest.stats.relations} relations`));
				console.log(chalk.dim(`  ${data.manifest.stats.skills} skills`));
				console.log();
			} finally {
				if (db) {
					db.close();
				}
			}
		});

	program
		.command("import <path>")
		.description("Import agent data from an export bundle")
		.option("--conflict <strategy>", "Conflict resolution: skip, overwrite, merge", "skip")
		.option("--json", "Input is a JSON file instead of a directory")
		.action(async (importPath: string, options) => {
			const agentsDir = deps.AGENTS_DIR;
			const dbPath = join(agentsDir, "memory", "memories.db");

			if (!existsSync(importPath)) {
				console.error(chalk.red(`  Path not found: ${importPath}`));
				process.exit(1);
			}

			const spinner = ora("Importing agent data...").start();
			const fileMap = options.json || importPath.endsWith(".json") ? loadJsonMap(importPath) : loadDirMap(importPath);

			let identityCount = 0;
			for (const [path, content] of fileMap) {
				if (!path.startsWith("identity/")) continue;
				const name = path.replace("identity/", "");
				const destPath = resolveImportPath(agentsDir, name);
				if (!destPath) continue;
				writeFileSync(destPath, content);
				identityCount++;
			}

			const agentYaml = fileMap.get("agent.yaml");
			if (typeof agentYaml === "string") {
				writeFileSync(join(agentsDir, "agent.yaml"), agentYaml);
			}

			mkdirSync(join(agentsDir, "memory"), { recursive: true });
			let db: ReturnType<typeof Database> | null = null;
			const conflict = readConflict(options.conflict);
			let memResult = { imported: 0, skipped: 0 };
			let entityCount = 0;
			let relationCount = 0;
			try {
				db = new Database(dbPath);
				try {
					loadSqliteVec(db);
				} catch {
					// Non-fatal
				}
				runMigrations(db);

				memResult = fileMap.has("memories.jsonl")
					? importMemories(db, fileMap.get("memories.jsonl") || "", { conflictStrategy: conflict })
					: { imported: 0, skipped: 0 };
				entityCount = fileMap.has("entities.jsonl") ? importEntities(db, fileMap.get("entities.jsonl") || "") : 0;
				relationCount = fileMap.has("relations.jsonl") ? importRelations(db, fileMap.get("relations.jsonl") || "") : 0;
			} finally {
				if (db) {
					db.close();
				}
			}

			let skillCount = 0;
			for (const [path, content] of fileMap) {
				if (!path.startsWith("skills/")) continue;
				const destPath = resolveImportPath(agentsDir, path);
				if (!destPath) continue;
				mkdirSync(dirname(destPath), { recursive: true });
				writeFileSync(destPath, content);
				skillCount++;
			}

			spinner.succeed("Import complete");
			console.log(chalk.dim(`  ${memResult.imported} memories imported`));
			if (memResult.skipped > 0) {
				console.log(chalk.dim(`  ${memResult.skipped} memories skipped (conflict: ${conflict})`));
			}
			console.log(chalk.dim(`  ${entityCount} entities imported`));
			console.log(chalk.dim(`  ${relationCount} relations imported`));
			console.log(chalk.dim(`  ${identityCount} identity files written`));
			if (skillCount > 0) {
				console.log(chalk.dim(`  ${skillCount} skill files written`));
			}
			console.log();
		});
}

function loadJsonMap(path: string): Map<string, string> {
	const raw = readFileSync(path, "utf-8");
	const obj = JSON.parse(raw) as Record<string, string>;
	return new Map(Object.entries(obj));
}

function loadDirMap(dir: string): Map<string, string> {
	const out = new Map<string, string>();
	loadDirRecursive(dir, "", out);
	return out;
}

function loadDirRecursive(dir: string, prefix: string, out: Map<string, string>): void {
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			loadDirRecursive(fullPath, relPath, out);
			continue;
		}
		try {
			out.set(relPath, readFileSync(fullPath, "utf-8"));
		} catch {
			// Skip binary files
		}
	}
}

function readConflict(value: unknown): "skip" | "overwrite" | "merge" {
	if (value === "overwrite" || value === "merge") return value;
	return "skip";
}

function resolveImportPath(root: string, rel: string): string | null {
	const base = resolve(root);
	const path = resolve(root, rel);
	if (path === base || path.startsWith(`${base}${sep}`)) {
		return path;
	}
	return null;
}
