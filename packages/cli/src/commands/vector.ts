import { confirm } from "@inquirer/prompts";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadSqliteVec } from "@signet/core";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import Database from "../sqlite.js";

interface Source {
	readonly type: "zvec" | "blob" | "vec_table";
	readonly path: string;
	readonly count: number;
}

interface VectorDeps {
	readonly AGENTS_DIR: string;
	readonly signetLogo: () => string;
}

export function registerVectorCommands(program: Command, deps: VectorDeps): void {
	program
		.command("migrate-vectors")
		.description("Migrate existing BLOB vectors to sqlite-vec format")
		.option("--keep-blobs", "Keep old BLOB column after migration (safer for rollback)")
		.option("--remove-zvec", "Delete vectors.zvec file after successful migration")
		.option("--dry-run", "Show what would be migrated without making changes")
		.option("--rollback", "Rollback to BLOB format (not implemented in Phase 1)")
		.action(async (opts) => {
			const root = deps.AGENTS_DIR;
			const dir = join(root, "memory");
			const dbPath = join(dir, "memories.db");

			console.log(deps.signetLogo());
			console.log(chalk.bold("  Vector Migration\n"));

			if (opts.rollback) {
				console.log(chalk.yellow("  Rollback is not implemented in Phase 1."));
				console.log(chalk.dim("  If you used --keep-blobs during migration, you can manually"));
				console.log(chalk.dim("  restore by dropping vec_embeddings table and using the BLOB column."));
				return;
			}

			if (!existsSync(dbPath)) {
				console.log(chalk.yellow("  No memories database found."));
				console.log(chalk.dim(`  Expected: ${dbPath}`));
				return;
			}

			console.log(chalk.dim("  Detecting vector sources..."));
			const sources = await detectSources(root);
			const vec = sources.find((source) => source.type === "vec_table");

			if (vec) {
				console.log(chalk.green(`  vec_embeddings table already populated with ${vec.count} vectors`));
				console.log(chalk.dim("  Migration appears to have already been run."));

				const zvec = sources.find((source) => source.type === "zvec");
				if (zvec && opts.removeZvec) {
					const ok = await confirm({
						message: `Delete ${zvec.path}?`,
						default: false,
					});
					if (ok) {
						rmSync(zvec.path);
						console.log(chalk.dim(`  Removed ${zvec.path}`));
					}
				}
				return;
			}

			const blob = sources.find((source) => source.type === "blob");
			if (!blob) {
				console.log(chalk.yellow("  No existing embeddings found to migrate."));
				console.log(chalk.dim("  The embeddings table is empty or already migrated."));
				return;
			}

			console.log();
			console.log(chalk.cyan("  Migration Plan:"));
			console.log(chalk.dim(`    Source: ${blob.path}`));
			console.log(chalk.dim(`    Embeddings to migrate: ${blob.count}`));
			console.log(chalk.dim(`    Keep BLOB column: ${opts.keepBlobs ? "yes" : "no"}`));

			const zvec = sources.find((source) => source.type === "zvec");
			if (zvec) {
				console.log(chalk.dim(`    zvec file found: ${zvec.path}`));
				if (opts.removeZvec) {
					console.log(chalk.dim("    Will be deleted after migration"));
				}
			}

			if (opts.dryRun) {
				console.log();
				console.log(chalk.yellow("  Dry run complete. No changes made."));
				console.log(chalk.dim("  Run without --dry-run to perform migration."));
				return;
			}

			console.log();
			const ok = await confirm({
				message: `Migrate ${blob.count} embeddings to sqlite-vec?`,
				default: true,
			});

			if (!ok) {
				console.log(chalk.dim("  Migration cancelled."));
				return;
			}

			const spinner = ora("Migrating vectors...").start();

			let db: ReturnType<typeof Database> | null = null;
			try {
				db = Database(dbPath);

				if (!loadSqliteVec(db)) {
					spinner.fail("sqlite-vec extension not found — cannot migrate vectors.");
					return;
				}

				const row = db.prepare("SELECT dimensions FROM embeddings LIMIT 1").get();
				const dims = readDims(row) ?? 768;

				spinner.text = `Creating vec_embeddings table (${dims}d)...`;
				db.exec("DROP TABLE IF EXISTS vec_embeddings");
				db.exec(`
					CREATE VIRTUAL TABLE vec_embeddings USING vec0(
						id TEXT PRIMARY KEY,
						embedding FLOAT[${dims}] distance_metric=cosine
					);
				`);

				spinner.text = "Reading existing embeddings...";
				const embeddings = db.prepare("SELECT id, vector, dimensions FROM embeddings").all();
				const rows = readEmbeddings(embeddings);
				const total = rows.length;
				let migrated = 0;
				let failed = 0;

				const stmt = db.prepare(`
					INSERT OR REPLACE INTO vec_embeddings (id, embedding)
					VALUES (?, ?)
				`);

				for (const row of rows) {
					try {
						const buf = row.vector;
						const vec = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
						stmt.run(row.id, vec);
						migrated++;

						if (migrated % 50 === 0 || migrated === total) {
							spinner.text = `Migrating ${migrated}/${total} embeddings...`;
						}
					} catch (err) {
						failed++;
						console.error(`\n  Failed to migrate embedding ${row.id}: ${readErr(err)}`);
					}
				}

				if (!opts.keepBlobs && migrated > 0) {
					spinner.text = "Removing old BLOB column...";
					try {
						db.exec(`
							CREATE TABLE embeddings_new (
								id TEXT PRIMARY KEY,
								content_hash TEXT NOT NULL UNIQUE,
								dimensions INTEGER NOT NULL,
								source_type TEXT NOT NULL,
								source_id TEXT NOT NULL,
								chunk_text TEXT NOT NULL,
								created_at TEXT NOT NULL
							);

							INSERT INTO embeddings_new (id, content_hash, dimensions, source_type, source_id, chunk_text, created_at)
							SELECT id, content_hash, dimensions, source_type, source_id, chunk_text, created_at
							FROM embeddings;

							DROP TABLE embeddings;
							ALTER TABLE embeddings_new RENAME TO embeddings;

							CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
							CREATE INDEX IF NOT EXISTS idx_embeddings_hash ON embeddings(content_hash);
						`);
					} catch (err) {
						spinner.warn("Could not remove BLOB column");
						console.log(chalk.dim(`  ${readErr(err)}`));
						console.log(chalk.dim("  Vectors were migrated successfully. BLOB column retained."));
					}
				}

				spinner.succeed(chalk.green(`Migrated ${migrated} embeddings to sqlite-vec format`));

				if (failed > 0) {
					console.log(chalk.yellow(`  ${failed} embeddings failed to migrate`));
				}

				if (opts.removeZvec && zvec) {
					try {
						rmSync(zvec.path);
						console.log(chalk.dim(`  Removed ${zvec.path}`));
					} catch (err) {
						console.log(chalk.yellow(`  Could not remove zvec file: ${readErr(err)}`));
					}
				}

				console.log();
				console.log(chalk.dim("  You may need to restart the daemon for changes to take effect:"));
				console.log(chalk.cyan("    signet daemon restart"));
			} catch (err) {
				spinner.fail("Migration failed");
				console.error(chalk.red(`  ${readErr(err)}`));
				process.exit(1);
			} finally {
				if (db) {
					db.close();
				}
			}
		});
}

async function detectSources(root: string): Promise<Source[]> {
	const out: Source[] = [];
	const dir = join(root, "memory");
	const zvec = join(dir, "vectors.zvec");

	if (existsSync(zvec)) {
		try {
			statSync(zvec);
			out.push({ type: "zvec", path: zvec, count: 0 });
		} catch {
			// Ignore
		}
	}

	const dbPath = join(dir, "memories.db");
	if (!existsSync(dbPath)) {
		return out;
	}

	let db: ReturnType<typeof Database> | null = null;
	try {
		db = Database(dbPath, { readonly: true });
		const table = db
			.prepare(`
				SELECT name FROM sqlite_master
				WHERE type='table' AND name='embeddings'
			`)
			.get();

		if (!table) {
			db.close();
			return out;
		}

		const cols = db.prepare("PRAGMA table_info(embeddings)").all();
		const vector = readVectorCol(cols);

		if (vector?.type === "BLOB") {
			const row = db.prepare("SELECT COUNT(*) as count FROM embeddings").get();
			const count = readCount(row);
			if (count > 0) {
				out.push({ type: "blob", path: dbPath, count });
			}
		}

		const vecTable = db
			.prepare(`
				SELECT name FROM sqlite_master
				WHERE type='table' AND name='vec_embeddings'
			`)
			.get();

		if (vecTable) {
			const row = db.prepare("SELECT COUNT(*) as count FROM vec_embeddings").get();
			const count = readCount(row);
			if (count > 0) {
				out.push({ type: "vec_table", path: dbPath, count });
			}
		}
	} catch {
		// Ignore
	} finally {
		if (db) {
			db.close();
		}
	}

	return out;
}

function readErr(err: unknown): string {
	return err instanceof Error ? err.message : "Unknown error";
}

function readCount(row: unknown): number {
	if (typeof row !== "object" || row === null || !("count" in row)) {
		return 0;
	}
	const count = row.count;
	return typeof count === "number" ? count : 0;
}

function readDims(row: unknown): number | null {
	if (typeof row !== "object" || row === null || !("dimensions" in row)) {
		return null;
	}
	const dims = row.dimensions;
	return typeof dims === "number" ? dims : null;
}

function readVectorCol(rows: unknown): { readonly type: string } | null {
	if (!Array.isArray(rows)) {
		return null;
	}

	for (const row of rows) {
		if (typeof row !== "object" || row === null || !("name" in row) || !("type" in row)) {
			continue;
		}
		const name = row.name;
		const type = row.type;
		if (name === "vector" && typeof type === "string") {
			return { type };
		}
	}

	return null;
}

function readEmbeddings(rows: unknown): Array<{ readonly id: string; readonly vector: Buffer }> {
	if (!Array.isArray(rows)) {
		return [];
	}

	return rows.flatMap((row) => {
		if (typeof row !== "object" || row === null || !("id" in row) || !("vector" in row)) {
			return [];
		}
		const id = row.id;
		const vector = row.vector;
		if (typeof id !== "string" || !Buffer.isBuffer(vector)) {
			return [];
		}
		return [{ id, vector }];
	});
}
