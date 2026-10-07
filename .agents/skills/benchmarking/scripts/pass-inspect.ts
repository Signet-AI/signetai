import { resolve } from "node:path";
import { argValue, openReadOnly } from "./lib";

const USAGE = `Usage: bun .agents/skills/benchmarking/scripts/pass-inspect.ts <benchWorkspace> [--logs 6] [--errors 10]

Summarizes a bench workspace's Dreaming passes from its database (opened read-only): pass outcomes
and duration, tool calls by success, grouped apply_ontology_ops failures, recent pass-log summaries,
evidence exclusion reasons, and entities and claims per scope.`;

function table(title: string, rows: Record<string, unknown>[]): void {
	console.log(`\n## ${title}\n`);
	if (rows.length === 0) {
		console.log("(none)");
		return;
	}
	const columns = Object.keys(rows[0]);
	console.log(`| ${columns.join(" | ")} |`);
	console.log(`| ${columns.map(() => "---").join(" | ")} |`);
	for (const row of rows) {
		console.log(`| ${columns.map((column) => String(row[column] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`);
	}
}

function main(): void {
	const args = process.argv.slice(2);
	const workspaceArg = args.find((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));
	if (!workspaceArg || args.includes("--help")) {
		console.log(USAGE);
		process.exit(workspaceArg ? 0 : 1);
	}
	const logs = Number(argValue(args, "--logs") ?? 6);
	const errors = Number(argValue(args, "--errors") ?? 10);
	const db = openReadOnly(resolve(workspaceArg));
	try {
		table(
			"Passes",
			db
				.query(
					`SELECT status, COUNT(*) AS passes, SUM(mutations_applied) AS applied, SUM(mutations_failed) AS failed,
					        SUM(tokens_input) AS input_tokens, SUM(tokens_output) AS output_tokens,
					        ROUND(AVG((julianday(completed_at) - julianday(started_at)) * 86400)) AS avg_seconds
					 FROM dreaming_passes GROUP BY status ORDER BY passes DESC`,
				)
				.all() as Record<string, unknown>[],
		);
		table(
			"Tool calls",
			db
				.query(
					`SELECT tool_name AS tool, SUM(success = 1) AS ok, SUM(success = 0) AS failed
					 FROM dreaming_tool_calls GROUP BY tool_name ORDER BY ok + failed DESC`,
				)
				.all() as Record<string, unknown>[],
		);
		table(
			"Failed filings (apply_ontology_ops)",
			db
				.query(
					`SELECT COUNT(*) AS count, SUBSTR(COALESCE(json_extract(output_json, '$.error'), output_json), 1, 160) AS error
					 FROM dreaming_tool_calls WHERE tool_name = 'apply_ontology_ops' AND success = 0
					 GROUP BY SUBSTR(COALESCE(json_extract(output_json, '$.error'), output_json), 1, 70)
					 ORDER BY count DESC LIMIT ?`,
				)
				.all(errors) as Record<string, unknown>[],
		);
		table(
			"Exclusion reasons",
			db
				.query(
					`SELECT COUNT(*) AS count, SUBSTR(reason, 1, 140) AS reason
					 FROM dreaming_evidence_reviews GROUP BY SUBSTR(reason, 1, 60) ORDER BY count DESC LIMIT ?`,
				)
				.all(errors) as Record<string, unknown>[],
		);
		table(
			"Graph by scope",
			db
				.query(
					`SELECT e.agent_id AS scope, COUNT(DISTINCT e.id) AS entities,
					        (SELECT COUNT(*) FROM entity_attributes a WHERE a.agent_id = e.agent_id AND a.status = 'active') AS claims
					 FROM entities e WHERE COALESCE(e.status, 'active') = 'active'
					 GROUP BY e.agent_id ORDER BY claims DESC`,
				)
				.all() as Record<string, unknown>[],
		);
		const summaries = db
			.query(
				`SELECT created_at, json_extract(input_json, '$.summary') AS summary
				 FROM dreaming_tool_calls WHERE tool_name = 'runbook_write' ORDER BY created_at DESC LIMIT ?`,
			)
			.all(logs) as Array<{ created_at: string; summary: string | null }>;
		console.log(`\n## Latest ${summaries.length} pass logs`);
		for (const row of summaries) console.log(`\n### ${row.created_at}\n\n${(row.summary ?? "").slice(0, 1200)}`);
	} finally {
		db.close();
	}
}

main();
