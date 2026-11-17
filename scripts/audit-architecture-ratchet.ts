import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const SQL_OWNERS = [
	"platform/core/src/database.ts",
	"platform/core/src/fts-schema.ts",
	"platform/core/src/search.ts",
	"platform/daemon/src/db-owner-worker.ts",
	"platform/daemon/src/db-helpers.ts",
	"platform/daemon/src/db-vacuum.ts",
	"platform/daemon/src/agent-removal.ts",
	"platform/daemon/src/memory-lineage.ts",
	"platform/daemon/src/memory-head-owner.ts",
	"platform/daemon/src/obsidian-source-graph.ts",
	"platform/daemon/src/source-artifact-graph.ts",
	"platform/daemon/src/source-purge-tx.ts",
	"platform/daemon/src/source-snapshots.ts",
	"platform/daemon/src/source-claim-review.ts",
	"platform/daemon/src/transcript-import-commit.ts",
	"platform/daemon/src/ontology-contradictions.ts",
	"platform/daemon/src/semantic-memory-projection.ts",
	"platform/daemon/src/knowledge-graph-hygiene.ts",
	"platform/daemon/src/vector-repair-owner.ts",
	"platform/daemon/src/pipeline/graph-transactions.ts",
	"platform/daemon/src/pipeline/dreaming-attention.ts",
	"platform/daemon/src/pipeline/dreaming-surprisal.ts",
	"platform/daemon/src/pipeline/dreaming-evidence-consumption.ts",
] as const;
const OWNERS: ReadonlySet<string> = new Set(SQL_OWNERS);
const EXCLUDED = new Set([
	".astro",
	".git",
	".svelte-kit",
	".wrangler",
	"__tests__",
	"build",
	"built",
	"coverage",
	"dist",
	"fixtures",
	"generated",
	"memorybench",
	"node_modules",
	"references",
	"target",
	"test",
	"tests",
	"test-support",
	"test-utils",
	"web",
]);
const CATEGORIES = ["raw-sql", "swallowed-error", "unchecked-cast"] as const;
type Category = (typeof CATEGORIES)[number];
type Counts = Record<Category, number>;
interface CountsWithDetails {
	readonly counts: Counts;
	readonly sql: { text: number; helper: number; request: number; accessor: number; marker: number };
}
const RAW_HELPERS = new Set(["ownerReadAll", "ownerReadOne", "ownerRun", "ownerBatch"]);
const SQL =
	/\b(?:SELECT\b[\s\S]*?\bFROM|INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE\b[\s\S]*?\bSET|DELETE\s+FROM|REPLACE\s+INTO|(?:CREATE\s+(?:UNIQUE\s+)?|DROP\s+|ALTER\s+)(?:TABLE|INDEX|TRIGGER)|PRAGMA)\b/i;

function git(...args: readonly string[]): string {
	const result = Bun.spawnSync(["git", "-C", process.cwd(), ...args]);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
	return result.stdout.toString();
}

function tree(ref: string): ReadonlySet<string> {
	const files = new Set<string>();
	for (const entry of git("ls-tree", "-r", "-z", "--full-tree", ref).split("\0")) {
		if (!entry) continue;
		const tab = entry.indexOf("	");
		if (entry.slice(0, tab).split(" ")[1] === "blob") files.add(entry.slice(tab + 1));
	}
	return files;
}

function production(path: string): boolean {
	return (
		/^(?:platform|surfaces|libs|integrations)\//.test(path) &&
		/\.tsx?$/.test(path) &&
		!/\.(?:test|bench|spec|d)\.tsx?$/.test(path) &&
		!path.split("/").some((part) => EXCLUDED.has(part))
	);
}

function owner(path: string): boolean {
	return OWNERS.has(path) || /^platform\/core\/src\/migrations\/(?:\d{3}-[^/]+|index)\.ts$/.test(path);
}

function unwrap(expression: ts.Expression): ts.Expression {
	let node = expression;
	while (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) node = node.expression;
	return node;
}

function name(node: ts.Node): string | undefined {
	if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	if (ts.isElementAccessExpression(node) && node.argumentExpression) return name(node.argumentExpression);
	return undefined;
}

function defaultValue(expression: ts.Expression): boolean {
	const node = unwrap(expression);
	return (
		ts.isLiteralExpression(node) ||
		[ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.kind) ||
		(ts.isIdentifier(node) && node.text === "undefined") ||
		(ts.isArrayLiteralExpression(node) && node.elements.length === 0) ||
		(ts.isObjectLiteralExpression(node) && node.properties.length === 0) ||
		(ts.isPrefixUnaryExpression(node) &&
			[ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator) &&
			ts.isNumericLiteral(node.operand))
	);
}

function logging(expression: ts.Expression): boolean {
	const node = unwrap(expression);
	return (
		ts.isCallExpression(node) && /^(?:this\.)?(?:console|logger|log)(?:\.[\w$]+)+$/.test(node.expression.getText())
	);
}

function swallowed(body: ts.ConciseBody): boolean {
	if (!ts.isBlock(body)) return defaultValue(body) || logging(body);
	return body.statements.every(
		(statement) =>
			(ts.isExpressionStatement(statement) && logging(statement.expression)) ||
			(ts.isReturnStatement(statement) && (statement.expression === undefined || defaultValue(statement.expression))),
	);
}

function expectedMiss(path: string, node: ts.CatchClause): boolean {
	if (path !== "platform/core/src/attempt.ts") return false;
	const block = node.parent.parent;
	const fn = block.parent;
	return (
		ts.isBlock(block) &&
		ts.isFunctionDeclaration(fn) &&
		fn.body === block &&
		(fn.name?.text === "attempt" || fn.name?.text === "attemptAsync")
	);
}

function requestJson(expression: ts.Expression): boolean {
	const node = unwrap(expression);
	if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
	if (node.expression.name.text === "catch") return requestJson(node.expression.expression);
	return node.expression.name.text === "json" && /^(?:req|request)$/.test(name(node.expression.expression) ?? "");
}

function prepared(expression: ts.Expression): boolean {
	const node = unwrap(expression);
	if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
	return node.expression.name.text === "prepare" || prepared(node.expression.expression);
}

function count(path: string, content: string): CountsWithDetails {
	const counts: Counts = { "raw-sql": 0, "swallowed-error": 0, "unchecked-cast": 0 };
	const sql = { text: 0, helper: 0, request: 0, accessor: 0, marker: 0 };
	const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
	const aliases = new Map<string, string>();
	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const bindings = statement.importClause?.namedBindings;
		if (bindings && ts.isNamedImports(bindings)) {
			for (const element of bindings.elements)
				aliases.set(element.name.text, element.propertyName?.text ?? element.name.text);
		}
	}
	const callName = (expression: ts.Expression): string => {
		const value = name(unwrap(expression)) ?? "";
		return aliases.get(value) ?? value;
	};
	const visit = (node: ts.Node): void => {
		if (!owner(path)) {
			const text =
				ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
					? node.text
					: ts.isTemplateExpression(node)
						? node.head.text + node.templateSpans.map((span) => ` ? ${span.literal.text}`).join("")
						: "";
			if (SQL.test(text)) sql.text++;
			if (ts.isCallExpression(node)) {
				const called = callName(node.expression);
				if (RAW_HELPERS.has(called)) sql.helper++;
				if (/^with(?:ReadDb|WriteTx|WriteDb)(?:Async)?$/.test(called)) sql.accessor++;
			}
			if (
				ts.isObjectLiteralExpression(node) &&
				node.properties.some(
					(property) =>
						ts.isPropertyAssignment(property) &&
						name(property.name) === "kind" &&
						ts.isStringLiteralLike(property.initializer) &&
						/^(?:query|transaction|batch)$/.test(property.initializer.text),
				)
			)
				sql.request++;
		}
		if (ts.isCatchClause(node) && !expectedMiss(path, node) && swallowed(node.block)) counts["swallowed-error"]++;
		if (ts.isCallExpression(node)) {
			if (callName(node.expression) === "catch") {
				const callback = node.arguments[0];
				if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && swallowed(callback.body))
					counts["swallowed-error"]++;
			}
			if (/^ownerRead(?:All|One)$/.test(callName(node.expression)) && node.typeArguments?.length)
				counts["unchecked-cast"]++;
		}
		if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
			const constant =
				ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName) && node.type.typeName.text === "const";
			const operand = unwrap(node.expression);
			const database =
				ts.isCallExpression(operand) &&
				(/^(?:all|get|run|values|ownerReadAll|ownerReadOne)$/.test(callName(operand.expression)) || prepared(operand));
			if (!constant && (requestJson(operand) || database)) counts["unchecked-cast"]++;
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	if (!owner(path)) sql.marker = [...content.matchAll(/@ts-expect-error\s+LEGACY_SYNC_DB_ACCESS\b/g)].length;
	counts["raw-sql"] = Object.values(sql).reduce((sum, value) => sum + value, 0);
	return { counts, sql };
}

function origins(base: string): ReadonlyMap<string, string> {
	const paths = new Map<string, string>();
	const entries = git(
		"diff",
		"--find-renames",
		"--find-copies",
		"--find-copies-harder",
		base,
		"HEAD",
		"--name-status",
		"-z",
	).split("\0");
	for (let i = 0; i < entries.length; ) {
		const status = entries[i++];
		const from = entries[i++];
		if (status?.startsWith("R") || status?.startsWith("C")) {
			const to = entries[i++];
			if (from && to) paths.set(to, from);
		}
	}
	return paths;
}

function retiredPaths(after: ReadonlySet<string>): readonly string[] {
	const registry = "scripts/retired-paths.json";
	if (!after.has(registry)) throw new Error(`Missing retirement registry: ${registry}`);
	const entries: unknown = JSON.parse(git("show", `HEAD:${registry}`));
	if (!Array.isArray(entries)) throw new Error("Retirement registry must be an array");
	const failures: string[] = [];
	const candidates: readonly unknown[] = entries;
	for (const entry of candidates) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			!("path" in entry) ||
			typeof entry.path !== "string" ||
			!("reason" in entry) ||
			typeof entry.reason !== "string" ||
			!entry.reason ||
			!("retiredIn" in entry) ||
			typeof entry.retiredIn !== "string" ||
			!entry.retiredIn ||
			!entry.path ||
			entry.path.startsWith("/") ||
			entry.path.split("/").includes("..")
		)
			throw new Error("Invalid retirement entry");
		if (after.has(entry.path) || lstatSync(resolve(entry.path), { throwIfNoEntry: false }))
			failures.push(`Retired path exists: ${entry.path}`);
		const result = Bun.spawnSync([
			"git",
			"-C",
			process.cwd(),
			"grep",
			"-a",
			"-l",
			"-z",
			"-F",
			"-e",
			entry.path,
			"HEAD",
			"--",
			".",
			":(exclude)docs/**",
			`:(exclude)${registry}`,
		]);
		if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(result.stderr.toString().trim());
		for (const match of result.stdout.toString().split("\0").filter(Boolean))
			failures.push(`${match.replace(/^HEAD:/, "")} references retired path: ${entry.path}`);
	}
	return failures;
}

function main(): void {
	const args = process.argv.slice(2);
	if (args.length !== 0 && (args.length !== 2 || args[0] !== "--base" || !args[1]))
		throw new Error("Usage: bun scripts/audit-architecture-ratchet.ts [--base <ref>]");
	const base = git("merge-base", args[1] ?? "origin/main", "HEAD").trim();
	const before = tree(base);
	const after = tree("HEAD");
	const sources = origins(base);
	const totals: Counts = { "raw-sql": 0, "swallowed-error": 0, "unchecked-cast": 0 };
	const failures: string[] = [...retiredPaths(after)];
	let files = 0;
	for (const path of after) {
		if (!production(path)) continue;
		files++;
		const head = count(path, git("show", `HEAD:${path}`));
		const source = before.has(path) ? path : (sources.get(path) ?? path);
		const previous =
			before.has(source) && production(source)
				? count(source, git("show", `${base}:${source}`))
				: { counts: { "raw-sql": 0, "swallowed-error": 0, "unchecked-cast": 0 } };
		for (const category of CATEGORIES) {
			totals[category] += head.counts[category];
			if (head.counts[category] > previous.counts[category]) {
				const detail =
					category === "raw-sql"
						? ` (${Object.entries(head.sql)
								.map(([key, value]) => `${key}=${value}`)
								.join(", ")})`
						: "";
				failures.push(`${path}\t${category}\t${previous.counts[category]} -> ${head.counts[category]}${detail}`);
			}
		}
	}
	if (failures.length) {
		console.error(`Architecture ratchet failed against ${base}:\nfile\tcategory\tbase -> head\n${failures.join("\n")}`);
		process.exitCode = 1;
		return;
	}
	console.log(
		`Architecture ratchet passed against ${base}: ${files} files; ${CATEGORIES.map((category) => `${category}=${totals[category]}`).join(", ")}`,
	);
}

if (import.meta.main) main();
