import type { Database } from "bun:sqlite";
import { ftsShardTables, readScopeSql, type ReadScope } from "@signet/core";

const TYPE_HINTS: ReadonlyArray<readonly [string, string]> = [
	["prefer", "preference"],
	["likes", "preference"],
	["want", "preference"],
	["decided", "decision"],
	["agreed", "decision"],
	["will use", "decision"],
	["learned", "learning"],
	["discovered", "learning"],
	["til ", "learning"],
	["bug", "issue"],
	["issue", "issue"],
	["broken", "issue"],
	["never", "rule"],
	["always", "rule"],
	["must", "rule"],
] as const;

export function inferType(content: string): string {
	const lower = content.toLowerCase();
	for (const [hint, type] of TYPE_HINTS) {
		if (lower.includes(hint)) return type;
	}
	return "fact";
}
export function effectiveScore(importance: number, createdAt: string, pinned: boolean): number {
	if (pinned) return 1.0;
	const ageDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
	return importance * 0.95 ** ageDays;
}
export function isDuplicate(db: Database, content: string, agentId: string, readScope?: ReadScope): boolean {
	const words = content
		.toLowerCase()
		.split(/\W+/)
		.filter((w) => w.length >= 3);
	if (words.length === 0) return false;

	try {
		const ftsQuery = words.slice(0, 10).join(" OR ");
		const scope: ReadScope = readScope ?? { reach: { kind: "own", agentId }, compartments: "all", projects: null };
		const filter = readScopeSql("m", scope);
		const args = filter.args.map((value) => {
			if (typeof value === "string" || typeof value === "number") return value;
			throw new Error("Invalid duplicate search scope");
		});
		const catalogue = {
			exec: () => {
				throw new Error("Read-only duplicate index catalogue");
			},
			prepare: (sql: string) => ({
				run: () => {
					throw new Error("Read-only duplicate index catalogue");
				},
				get: () => undefined,
				all: (...values: unknown[]) =>
					db.prepare<Record<string, unknown>, string[]>(sql).all(
						...values.map((value) => {
							if (typeof value !== "string") throw new Error("Invalid shard catalogue parameter");
							return value;
						}),
					),
			}),
		};
		const rows = ftsShardTables("memories_fts", scope.compartments, catalogue)
			.flatMap((table) =>
				db
					.prepare(`SELECT m.content,bm25(${table}) AS raw_score FROM ${table}
				JOIN memories m ON ${table}.rowid=m.rowid
				WHERE ${table} MATCH ? AND m.is_deleted=0${filter.sql}
				ORDER BY raw_score LIMIT 10`)
					.all(ftsQuery, ...args)
					.flatMap((row) =>
						typeof row === "object" &&
						row !== null &&
						"content" in row &&
						typeof row.content === "string" &&
						"raw_score" in row &&
						typeof row.raw_score === "number"
							? [{ content: row.content, raw_score: row.raw_score }]
							: [],
					),
			)
			.sort((left, right) => left.raw_score - right.raw_score)
			.slice(0, 10);

		const inputWords = new Set(words);
		for (const row of rows) {
			const rowWords = new Set(
				row.content
					.toLowerCase()
					.split(/\W+/)
					.filter((w) => w.length >= 3),
			);
			let overlap = 0;
			for (const w of inputWords) {
				if (rowWords.has(w)) overlap++;
			}
			if (overlap / inputWords.size >= 0.7) return true;
		}
	} catch {}
	return false;
}
