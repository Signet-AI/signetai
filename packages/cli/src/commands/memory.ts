import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";

interface MemoryDeps {
	readonly ensureDaemonForSecrets: () => Promise<boolean>;
	readonly secretApiCall: (
		method: string,
		path: string,
		body?: unknown,
		timeoutMs?: number,
	) => Promise<{
		ok: boolean;
		data: unknown;
	}>;
}

export function registerMemoryCommands(program: Command, deps: MemoryDeps): void {
	program
		.command("remember <content>")
		.description("Save a memory (auto-embedded for vector search)")
		.option("-w, --who <who>", "Who is remembering", "user")
		.option("-t, --tags <tags>", "Comma-separated tags")
		.option("-i, --importance <n>", "Importance (0-1)", Number.parseFloat, 0.7)
		.option("--critical", "Mark as critical (pinned)", false)
		.action(async (content: string, options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;

			const spinner = ora("Saving memory...").start();
			const { ok, data } = await deps.secretApiCall("POST", "/api/memory/remember", {
				content,
				who: options.who,
				tags: options.tags,
				importance: options.importance,
				pinned: options.critical,
			});

			const err = typeof data === "object" && data !== null && "error" in data ? data.error : undefined;
			if (!ok || typeof err === "string") {
				spinner.fail(typeof err === "string" ? err : "Failed to save memory");
				process.exit(1);
			}

			const result = typeof data === "object" && data !== null ? data : {};
			const id = typeof result.id === "string" ? result.id : "unknown";
			const pinned = result.pinned === true;
			const embedded = result.embedded === true;
			const tags = typeof result.tags === "string" ? result.tags : undefined;
			const embedStatus = embedded ? chalk.dim(" (embedded)") : chalk.yellow(" (no embedding)");
			spinner.succeed(`Saved memory: ${chalk.cyan(id)}${embedStatus}`);

			if (pinned) {
				console.log(chalk.dim("  Marked as critical"));
			}
			if (tags) {
				console.log(chalk.dim(`  Tags: ${tags}`));
			}
		});

	program
		.command("recall <query>")
		.description("Search memories using hybrid (vector + keyword) search")
		.option("-l, --limit <n>", "Max results", Number.parseInt, 10)
		.option("-t, --type <type>", "Filter by type")
		.option("--tags <tags>", "Filter by tags (comma-separated)")
		.option("--who <who>", "Filter by who")
		.option("--since <date>", "Only memories created after this date (ISO or YYYY-MM-DD)")
		.option("--until <date>", "Only memories created before this date (ISO or YYYY-MM-DD)")
		.option("--json", "Output as JSON")
		.action(async (query: string, options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;

			const spinner = ora("Searching memories...").start();
			const { ok, data } = await deps.secretApiCall("POST", "/api/memory/recall", {
				query,
				limit: options.limit,
				type: options.type,
				tags: options.tags,
				who: options.who,
				since: options.since,
				until: options.until,
			});

			const err = typeof data === "object" && data !== null && "error" in data ? data.error : undefined;
			if (!ok || typeof err === "string") {
				spinner.fail(typeof err === "string" ? err : "Search failed");
				process.exit(1);
			}

			spinner.stop();
			const result = typeof data === "object" && data !== null ? data : {};
			const rows = Array.isArray(result.results) ? result.results : [];

			if (options.json) {
				console.log(JSON.stringify(rows, null, 2));
				return;
			}

			if (rows.length === 0) {
				console.log(chalk.dim("  No memories found"));
				console.log(chalk.dim("  Try a different query or add memories with `signet remember`"));
				return;
			}

			console.log(chalk.bold(`\n  Found ${rows.length} memories:\n`));
			for (const row of rows) {
				if (typeof row !== "object" || row === null) continue;
				const content = typeof row.content === "string" ? row.content : "";
				const createdAt = typeof row.created_at === "string" ? row.created_at : "";
				const scoreValue = typeof row.score === "number" ? row.score : 0;
				const source = typeof row.source === "string" ? row.source : "unknown";
				const who = typeof row.who === "string" ? row.who : "unknown";
				const type = typeof row.type === "string" ? row.type : "memory";
				const tags = typeof row.tags === "string" ? row.tags : "";
				const pinned = row.pinned === true;
				const date = createdAt.slice(0, 10);
				const score = chalk.dim(`[${(scoreValue * 100).toFixed(0)}%]`);
				const sourceLabel = chalk.dim(`(${source})`);
				const critical = pinned ? chalk.red("★") : "";
				const tagLabel = tags ? chalk.dim(` [${tags}]`) : "";
				const displayContent = content.length > 120 ? `${content.slice(0, 117)}...` : content;

				console.log(`  ${chalk.dim(date)} ${score} ${critical}${displayContent}${tagLabel}`);
				console.log(chalk.dim(`      by ${who} · ${type} · ${sourceLabel}`));
			}
			console.log();
		});

	const embedCmd = program.command("embed").description("Embedding management (audit, backfill)");

	embedCmd
		.command("audit")
		.description("Check embedding coverage for memories")
		.option("--json", "Output as JSON")
		.action(async (options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;

			const spinner = ora("Checking embedding coverage...").start();
			const { ok, data } = await deps.secretApiCall("GET", "/api/repair/embedding-gaps");
			const err = typeof data === "object" && data !== null && "error" in data ? data.error : undefined;
			if (!ok || typeof err === "string") {
				spinner.fail(typeof err === "string" ? err : "Audit failed");
				process.exit(1);
			}

			spinner.stop();
			const stats = typeof data === "object" && data !== null ? data : {};
			const total = typeof stats.total === "number" ? stats.total : 0;
			const unembedded = typeof stats.unembedded === "number" ? stats.unembedded : 0;
			const coverage = typeof stats.coverage === "string" ? stats.coverage : "0%";

			if (options.json) {
				console.log(JSON.stringify({ total, unembedded, coverage }, null, 2));
				return;
			}

			const embedded = total - unembedded;
			const coverageColor = unembedded === 0 ? chalk.green : unembedded > total * 0.3 ? chalk.red : chalk.yellow;
			console.log(chalk.bold("\n  Embedding Coverage Audit\n"));
			console.log(`  Total memories:    ${chalk.cyan(total)}`);
			console.log(`  Embedded:          ${chalk.green(embedded)}`);
			console.log(`  Missing:           ${unembedded > 0 ? chalk.red(unembedded) : chalk.green(0)}`);
			console.log(`  Coverage:          ${coverageColor(coverage)}`);
			console.log();

			if (unembedded > 0) {
				console.log(chalk.dim("  Run `signet embed backfill` to generate missing embeddings"));
				console.log(chalk.dim("  Run `signet embed backfill --dry-run` to preview without changes"));
				console.log();
			}
		});

	embedCmd
		.command("backfill")
		.description("Generate embeddings for memories that are missing them")
		.option("--dry-run", "Preview what would be embedded without making changes")
		.option("--batch-size <n>", "Number of memories to embed per batch", Number.parseInt, 50)
		.option("--json", "Output as JSON")
		.action(async (options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;

			const spinner = ora(options.dryRun ? "Checking missing embeddings..." : "Backfilling embeddings...").start();
			const { ok, data } = await deps.secretApiCall("POST", "/api/repair/re-embed", {
				batchSize: options.batchSize,
				dryRun: options.dryRun === true,
			});
			const err = typeof data === "object" && data !== null && "error" in data ? data.error : undefined;
			if (!ok || typeof err === "string") {
				spinner.fail(typeof err === "string" ? err : "Backfill failed");
				process.exit(1);
			}

			spinner.stop();
			const result = typeof data === "object" && data !== null ? data : {};
			const success = result.success === true;
			const affected = typeof result.affected === "number" ? result.affected : 0;
			const message = typeof result.message === "string" ? result.message : "Backfill complete";

			if (options.json) {
				console.log(JSON.stringify({ success, affected, message }, null, 2));
				return;
			}

			if (success) {
				console.log(chalk.bold(options.dryRun ? "\n  Dry Run Results\n" : "\n  Backfill Results\n"));
				console.log(`  ${message}`);
				if (!options.dryRun && affected > 0) {
					console.log(chalk.dim("\n  Run `signet embed audit` to check updated coverage"));
				}
			} else {
				console.log(chalk.yellow(`\n  ${message}`));
			}
			console.log();
		});
}
