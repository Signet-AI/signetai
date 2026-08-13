import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

export const SYNC_APIS = [
	"withWriteTx",
	"withReadDb",
	"readdirSync",
	"readFileSync",
	"statSync",
	"spawnSync",
	"execSync",
	"existsSync",
	"mkdirSync",
	"copyFileSync",
	"unlinkSync",
	"renameSync",
	"rmSync",
	"writeFileSync",
	"appendFileSync",
	"readlinkSync",
	"lstatSync",
	"statfsSync",
] as const;

export type SyncApi = (typeof SYNC_APIS)[number];
export type AllowlistCategory = "pre-readiness-bootstrap" | "cli-only" | "isolated-worker";
export type SiteCategory = AllowlistCategory | "hot-path";

export interface AuditSite {
	readonly path: string;
	readonly line: number;
	readonly api: SyncApi;
	readonly source: string;
	readonly category: SiteCategory;
}

export interface AllowlistEntry {
	readonly path: string;
	readonly api: SyncApi;
	readonly category: AllowlistCategory;
	readonly reason: string;
}

export interface AuditViolation extends AuditSite {
	readonly message: string;
}

export interface AuditResult {
	readonly sites: readonly AuditSite[];
	readonly violations: readonly AuditViolation[];
}

interface BaselineFile {
	readonly version: 1;
	readonly generatedFrom: string;
	readonly sites: readonly AuditSite[];
}

const DEFAULT_SOURCE_ROOT = "platform/daemon/src";
const DEFAULT_BASELINE = "scripts/event-loop-contract-baseline.json";
const DEFAULT_ALLOWLIST = "scripts/event-loop-contract-allowlist.txt";
const DEFAULT_REPORT = "docs/event-loop-contract-audit.md";
const ALLOWLIST_CATEGORIES = new Set<AllowlistCategory>(["pre-readiness-bootstrap", "cli-only", "isolated-worker"]);
const HOT_PATH_MARKERS = [
	"routes/",
	"pipeline/",
	"scanner",
	"native-memory-sources",
	"startup-recovery",
	"telemetry",
	"maintenance",
	"memory-search",
	"recall",
	"repair",
];
const ISOLATED_WORKER_FILES = new Set([
	"database-integrity-worker.ts",
	"embedding-worker.ts",
	"embedding-worker-handle.ts",
]);

function isTypeScriptSource(path: string): boolean {
	return path.endsWith(".ts") && !path.endsWith(".d.ts");
}

function isExcludedSource(path: string): boolean {
	return (
		path.endsWith(".test.ts") || path.endsWith(".bench.ts") || path.includes("/__tests__/") || path.includes("/dist/")
	);
}

function classifySite(path: string): SiteCategory {
	const normalized = path.replaceAll("\\", "/");
	const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
	if (ISOLATED_WORKER_FILES.has(basename)) return "isolated-worker";
	if (normalized.includes("mcp-stdio") || normalized.includes("mcp-probe") || normalized.includes("/cli/")) {
		return "cli-only";
	}
	if (normalized === "db-accessor.ts") return "pre-readiness-bootstrap";
	if (HOT_PATH_MARKERS.some((marker) => normalized.includes(marker))) return "hot-path";
	return "hot-path";
}

function sourceFiles(root: string): string[] {
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(path);
				continue;
			}
			if (isTypeScriptSource(path) && !isExcludedSource(path)) files.push(path);
		}
	};
	visit(root);
	return files.sort();
}

function findSites(root: string): AuditSite[] {
	const sites: AuditSite[] = [];
	for (const absolutePath of sourceFiles(root)) {
		const path = relative(root, absolutePath).replaceAll("\\", "/");
		const text = readFileSync(absolutePath, "utf8");
		const sourceFile = ts.createSourceFile(absolutePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const lines = text.split("\n");
		const seenOnLine = new Set<string>();
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				const call = calledSyncApi(node.expression);
				if (call) {
					const line = sourceFile.getLineAndCharacterOfPosition(call.position).line;
					const key = `${line}:${call.api}`;
					if (seenOnLine.has(key)) return;
					seenOnLine.add(key);
					const source = lines[line]?.replace(/\/\/.*$/u, "").trim() ?? "";
					sites.push({ path, line: line + 1, api: call.api, source, category: classifySite(path) });
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return sites;
}

function calledSyncApi(expression: ts.Expression): { readonly api: SyncApi; readonly position: number } | null {
	if (ts.isPropertyAccessExpression(expression)) {
		const api = expression.name.text;
		if (!SYNC_APIS.includes(api as SyncApi)) return null;
		return { api: api as SyncApi, position: expression.name.getStart() };
	}
	if (!ts.isIdentifier(expression)) {
		return null;
	}
	if (expression.text === "withWriteTx" || expression.text === "withReadDb") return null;
	if (!SYNC_APIS.includes(expression.text as SyncApi)) return null;
	return { api: expression.text as SyncApi, position: expression.getStart() };
}

function siteKey(site: Pick<AuditSite, "path" | "api" | "source">): string {
	return `${site.path}\u0000${site.api}\u0000${site.source}`;
}

function occurrenceKeys(sites: readonly AuditSite[]): Set<string> {
	const seen = new Map<string, number>();
	const keys = new Set<string>();
	for (const site of sites) {
		const base = siteKey(site);
		const occurrence = (seen.get(base) ?? 0) + 1;
		seen.set(base, occurrence);
		keys.add(`${base}\u0000${occurrence}`);
	}
	return keys;
}

function parseAllowlist(text: string): AllowlistEntry[] {
	const entries: AllowlistEntry[] = [];
	for (const [index, rawLine] of text.split("\n").entries()) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const [path, api, category, ...reasonParts] = line.split("|");
		if (!path || !api || !category || reasonParts.length === 0) {
			throw new Error(`Invalid event-loop allowlist entry at line ${index + 1}`);
		}
		if (!SYNC_APIS.includes(api as SyncApi))
			throw new Error(`Unknown sync API in allowlist at line ${index + 1}: ${api}`);
		if (!ALLOWLIST_CATEGORIES.has(category as AllowlistCategory)) {
			throw new Error(`Invalid allowlist category at line ${index + 1}: ${category}`);
		}
		if (category === "hot-path" || HOT_PATH_MARKERS.some((marker) => path.includes(marker))) {
			throw new Error(`Hot-path event-loop calls cannot be allowlisted: ${path}:${api}`);
		}
		entries.push({ path, api: api as SyncApi, category: category as AllowlistCategory, reason: reasonParts.join("|") });
	}
	return entries;
}

function allowlisted(site: AuditSite, entries: readonly AllowlistEntry[]): boolean {
	return entries.some((entry) => entry.path === site.path && entry.api === site.api);
}

export function runAudit(input: {
	readonly sourceRoot: string;
	readonly baselineSites?: readonly AuditSite[];
	readonly allowlist?: readonly AllowlistEntry[];
}): AuditResult {
	const sites = findSites(resolve(input.sourceRoot));
	const baseline = occurrenceKeys(input.baselineSites ?? []);
	const seen = new Map<string, number>();
	const violations: AuditViolation[] = [];
	for (const site of sites) {
		const base = siteKey(site);
		const occurrence = (seen.get(base) ?? 0) + 1;
		seen.set(base, occurrence);
		const key = `${base}\u0000${occurrence}`;
		if (baseline.has(key) || allowlisted(site, input.allowlist ?? [])) continue;
		violations.push({
			...site,
			message: `${site.path}:${site.line} uses synchronous ${site.api}() in ${site.category}; migrate it or add a justified non-hot-path exception`,
		});
	}
	return { sites, violations };
}

function readBaseline(path: string): BaselineFile {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as BaselineFile;
	if (parsed.version !== 1 || !Array.isArray(parsed.sites)) throw new Error(`Invalid event-loop baseline: ${path}`);
	return parsed;
}

function writeBaseline(path: string, sourceRoot: string, sites: readonly AuditSite[]): void {
	writeFileSync(path, `${JSON.stringify({ version: 1, generatedFrom: sourceRoot, sites }, null, 2)}\n`);
}

function countBy(sites: readonly AuditSite[], key: "api" | "category" | "path"): Map<string, number> {
	const counts = new Map<string, number>();
	for (const site of sites) counts.set(site[key], (counts.get(site[key]) ?? 0) + 1);
	return counts;
}

function markdownTable(rows: readonly (readonly string[])[]): string {
	return [
		"| File | Category | withWriteTx | withReadDb | blocking fs/process |",
		"| --- | --- | ---: | ---: | ---: |",
		...rows.map((row) => `| ${row.join(" | ")} |`),
	].join("\n");
}

function report(sites: readonly AuditSite[], allowlist: readonly AllowlistEntry[]): string {
	const blockingSites = sites.filter((site) => site.api !== "withWriteTx" && site.api !== "withReadDb");
	const files = [...new Set(sites.map((site) => site.path))].sort();
	const rows = files.map((path) => {
		const fileSites = sites.filter((site) => site.path === path);
		const category = fileSites[0]?.category ?? "hot-path";
		return [
			`\`${path}\``,
			category,
			String(fileSites.filter((site) => site.api === "withWriteTx").length),
			String(fileSites.filter((site) => site.api === "withReadDb").length),
			String(fileSites.filter((site) => site.api !== "withWriteTx" && site.api !== "withReadDb").length),
		] as const;
	});
	const categoryCounts = countBy(sites, "category");
	const apiCounts = countBy(sites, "api");
	const allowlistLines =
		allowlist.length === 0
			? ["(empty: no non-baseline exception is currently granted)"]
			: allowlist.map((entry) => `- \`${entry.path}\` ${entry.api}: ${entry.category}. ${entry.reason}`);
	const apiLines = [...apiCounts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([api, count]) => `- \`${api}()\` : ${count}`);
	const lines = [
		"# Event-loop synchronous call-site audit",
		"",
		"Generated by the Phase A audit script for #1543. The baseline records current production call sites so CI fails only when a new synchronous call site is added. Existing hot-path sites are migration work, not permanent exceptions.",
		"",
		"## Current inventory",
		"",
		`- Production TypeScript files scanned: ${files.length}`,
		`- Synchronous \`withWriteTx()\` call sites: ${apiCounts.get("withWriteTx") ?? 0}`,
		`- Synchronous \`withReadDb()\` call sites: ${apiCounts.get("withReadDb") ?? 0}`,
		`- Synchronous filesystem/process call sites: ${blockingSites.length}`,
		`- Total audited call sites: ${sites.length}`,
		"",
		"The counts exclude test, benchmark, generated, and `__tests__` fixtures. A source line is a call site when it contains one of the named synchronous APIs followed by `()`. The baseline key includes the normalized source line and occurrence number, so line shifts do not look like new calls while added calls still fail CI.",
		"",
		"## Classification",
		"",
		"| Category | Call sites | Meaning |",
		"| --- | ---: | --- |",
		`| hot-path | ${categoryCounts.get("hot-path") ?? 0} | Request, recall, pipeline, scanner, recovery, telemetry, repair, or maintenance reachable code. These are not allowlisted and feed the next migration phases. |`,
		`| pre-readiness-bootstrap | ${categoryCounts.get("pre-readiness-bootstrap") ?? 0} | Compatibility internals in the DB bootstrap/accessor module. |`,
		`| cli-only | ${categoryCounts.get("cli-only") ?? 0} | Explicit CLI/MCP stdio process paths. |`,
		`| isolated-worker | ${categoryCounts.get("isolated-worker") ?? 0} | Explicit worker-owned modules. |`,
		"",
		"## File inventory",
		"",
		markdownTable(rows),
		"",
		"## API counts",
		"",
		...apiLines,
		"",
		"## Allowlist",
		"",
		"The allowlist is separate from the baseline. Every entry must use `pre-readiness-bootstrap`, `cli-only`, or `isolated-worker`; hot-path entries are rejected by the audit script.",
		"",
		...allowlistLines,
		"",
		"## CI behavior",
		"",
		"Run `bun scripts/audit-event-loop-contract.ts`. A new call reports the exact `file:line`, API, and classification and exits non-zero. During a migration, remove the source call and regenerate the baseline deliberately with `--write-baseline`.",
		"",
	];
	return lines.join("\n");
}

function usage(): never {
	throw new Error("Usage: bun scripts/audit-event-loop-contract.ts [--write-baseline] [--write-report]");
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
	const writeBaselineFlag = args.includes("--write-baseline");
	const writeReportFlag = args.includes("--write-report");
	if (args.some((arg) => !["--write-baseline", "--write-report"].includes(arg))) usage();
	const sourceRoot = resolve(DEFAULT_SOURCE_ROOT);
	const baselinePath = resolve(DEFAULT_BASELINE);
	const allowlistPath = resolve(DEFAULT_ALLOWLIST);
	const reportPath = resolve(DEFAULT_REPORT);
	const sites = findSites(sourceRoot);
	const allowlist = parseAllowlist(readFileSync(allowlistPath, "utf8"));
	if (writeBaselineFlag) writeBaseline(baselinePath, DEFAULT_SOURCE_ROOT, sites);
	if (writeReportFlag) writeFileSync(reportPath, report(sites, allowlist));
	const baseline = readBaseline(baselinePath);
	const result = runAudit({ sourceRoot, baselineSites: baseline.sites, allowlist });
	if (result.violations.length > 0) {
		for (const violation of result.violations) console.error(`event-loop audit: ${violation.message}`);
		throw new Error(`${result.violations.length} new synchronous event-loop call site(s) detected`);
	}
	console.log(`event-loop audit passed: ${result.sites.length} production call sites checked`);
}

if (import.meta.main) await main();
