import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

export const SYNC_APIS = [
	"withWriteTx",
	"withReadDb",
	"accessSync",
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
	readonly line: number;
	readonly api: SyncApi;
	readonly category: AllowlistCategory;
	readonly source: string;
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
function isTypeScriptSource(path: string): boolean {
	return path.endsWith(".ts") && !path.endsWith(".d.ts");
}

function isExcludedSource(path: string): boolean {
	return (
		path.endsWith(".test.ts") || path.endsWith(".bench.ts") || path.includes("/__tests__/") || path.includes("/dist/")
	);
}

function hasNamedImport(sourceFile: ts.SourceFile, moduleName: string, name: string): boolean {
	let found = false;
	const visit = (node: ts.Node): void => {
		if (found) return;
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			node.moduleSpecifier.text === moduleName
		) {
			const bindings = node.importClause?.namedBindings;
			if (bindings && ts.isNamedImports(bindings)) {
				found = bindings.elements.some((element) => (element.propertyName ?? element.name).text === name);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return found;
}

function hasIdentifier(sourceFile: ts.SourceFile, name: string): boolean {
	let found = false;
	const visit = (node: ts.Node): void => {
		if (found) return;
		if (ts.isIdentifier(node) && node.text === name) {
			found = true;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return found;
}

function hasStringLiteral(sourceFile: ts.SourceFile, value: string): boolean {
	let found = false;
	const visit = (node: ts.Node): void => {
		if (found) return;
		if (ts.isStringLiteral(node) && node.text === value) {
			found = true;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return found;
}

function isCliOnlySource(sourceFile: ts.SourceFile): boolean {
	const text = sourceFile.getFullText();
	return (
		text.startsWith("#!") &&
		hasNamedImport(sourceFile, "@modelcontextprotocol/sdk/server/stdio.js", "StdioServerTransport")
	);
}

function isIsolatedWorkerSource(sourceFile: ts.SourceFile): boolean {
	const workerThread =
		hasNamedImport(sourceFile, "node:worker_threads", "parentPort") ||
		hasNamedImport(sourceFile, "node:worker_threads", "workerData");
	if (workerThread && hasIdentifier(sourceFile, "isMainThread")) return true;

	return (
		hasIdentifier(sourceFile, "process") &&
		hasIdentifier(sourceFile, "argv") &&
		hasIdentifier(sourceFile, "SIGNET_DATABASE_INTEGRITY_DB_PATH") &&
		hasStringLiteral(sourceFile, "database-integrity-worker.ts")
	);
}

function functionName(node: ts.Node): string | null {
	if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
		return node.name && ts.isIdentifier(node.name) ? node.name.text : null;
	}
	if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) {
		return ts.isIdentifier(node.parent.name) ? node.parent.name.text : null;
	}
	return null;
}

function calledFunctionName(expression: ts.Expression): string | null {
	if (ts.isIdentifier(expression)) return expression.text;
	if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
	return null;
}

function destructuredSyncApis(sourceFile: ts.SourceFile): ReadonlyMap<string, SyncApi> {
	const declarations: ts.VariableDeclaration[] = [];
	const collectDeclarations = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node)) declarations.push(node);
		ts.forEachChild(node, collectDeclarations);
	};
	collectDeclarations(sourceFile);

	const accessorAliases = new Set<string>();
	const isAccessorExpression = (expression: ts.Expression): boolean => {
		const unwrapped = unwrapExpression(expression);
		if (ts.isIdentifier(unwrapped)) return accessorAliases.has(unwrapped.text);
		if (!ts.isCallExpression(unwrapped)) return false;
		const callee = unwrapExpression(unwrapped.expression);
		return ts.isIdentifier(callee) && callee.text === "getDbAccessor";
	};
	let accessorsChanged = true;
	while (accessorsChanged) {
		accessorsChanged = false;
		for (const declaration of declarations) {
			if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
			if (!isAccessorExpression(declaration.initializer) || accessorAliases.has(declaration.name.text)) continue;
			accessorAliases.add(declaration.name.text);
			accessorsChanged = true;
		}
	}

	const aliases = new Map<string, SyncApi>();
	const isDbAccessorSyncApi = (api: string): api is "withReadDb" | "withWriteTx" =>
		api === "withReadDb" || api === "withWriteTx";
	const addAlias = (name: string, api: string): void => {
		if (isDbAccessorSyncApi(api)) aliases.set(name, api);
	};
	const apiFromExpression = (expression: ts.Expression): SyncApi | null => {
		const unwrapped = unwrapExpression(expression);
		if (ts.isIdentifier(unwrapped)) return aliases.get(unwrapped.text) ?? null;
		const api = staticPropertyName(unwrapped);
		if (api === null || !isDbAccessorSyncApi(api)) return null;
		if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
			return isAccessorExpression(unwrapped.expression) ? (api as SyncApi) : null;
		}
		return null;
	};
	let aliasesChanged = true;
	while (aliasesChanged) {
		aliasesChanged = false;
		for (const declaration of declarations) {
			if (
				ts.isObjectBindingPattern(declaration.name) &&
				declaration.initializer &&
				isAccessorExpression(declaration.initializer)
			) {
				for (const element of declaration.name.elements) {
					if (!ts.isIdentifier(element.name)) continue;
					const propertyName =
						element.propertyName === undefined
							? element.name.text
							: ts.isComputedPropertyName(element.propertyName)
								? staticPropertyName(element.propertyName.expression)
								: element.propertyName.text;
					if (
						propertyName !== null &&
						isDbAccessorSyncApi(propertyName) &&
						aliases.get(element.name.text) !== propertyName
					) {
						addAlias(element.name.text, propertyName);
						aliasesChanged = true;
					}
				}
				continue;
			}
			if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
			const api = apiFromExpression(declaration.initializer);
			if (api !== null && aliases.get(declaration.name.text) !== api) {
				addAlias(declaration.name.text, api);
				aliasesChanged = true;
			}
		}
	}
	return aliases;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (true) {
		if (
			ts.isParenthesizedExpression(current) ||
			ts.isAsExpression(current) ||
			ts.isTypeAssertionExpression(current) ||
			ts.isNonNullExpression(current)
		) {
			current = current.expression;
			continue;
		}
		return current;
	}
}

function staticPropertyName(expression: ts.Expression): string | null {
	const unwrapped = unwrapExpression(expression);
	if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text;
	if (!ts.isElementAccessExpression(unwrapped) || unwrapped.argumentExpression === undefined) return null;
	const argument = unwrapExpression(unwrapped.argumentExpression);
	if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return argument.text;
	return null;
}

function functionBody(node: ts.Node): ts.Node | null {
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node)
	) {
		return node.body ?? null;
	}
	return null;
}

function collectFunctionCalls(node: ts.Node, calls: Set<string>): void {
	if (ts.isCallExpression(node)) {
		const name = calledFunctionName(node.expression);
		if (name !== null) calls.add(name);
	}
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isArrowFunction(node) ||
		ts.isFunctionExpression(node)
	) {
		return;
	}
	ts.forEachChild(node, (child) => collectFunctionCalls(child, calls));
}

interface FunctionGraph {
	readonly callsByFunction: ReadonlyMap<string, ReadonlySet<string>>;
	readonly callersByFunction: ReadonlyMap<string, ReadonlySet<string>>;
}

function functionGraph(sourceFile: ts.SourceFile): FunctionGraph {
	const callsByFunction = new Map<string, Set<string>>();
	const visit = (node: ts.Node): void => {
		const name = functionName(node);
		if (name !== null) {
			const calls = new Set<string>();
			const body = functionBody(node);
			if (body !== null) collectFunctionCalls(body, calls);
			callsByFunction.set(name, calls);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	const callersByFunction = new Map<string, Set<string>>();
	for (const [caller, calls] of callsByFunction) {
		for (const called of calls) {
			const callers = callersByFunction.get(called) ?? new Set<string>();
			callers.add(caller);
			callersByFunction.set(called, callers);
		}
	}
	return { callsByFunction, callersByFunction };
}

function reachableFunctionNames(
	callsByFunction: ReadonlyMap<string, ReadonlySet<string>>,
	seeds: Iterable<string>,
): ReadonlySet<string> {
	const reachable = new Set(seeds);
	let changed = true;
	while (changed) {
		changed = false;
		for (const name of reachable) {
			for (const called of callsByFunction.get(name) ?? []) {
				if (callsByFunction.has(called) && !reachable.has(called)) {
					reachable.add(called);
					changed = true;
				}
			}
		}
	}
	return reachable;
}

function bootstrapFunctionNames(graph: FunctionGraph): ReadonlySet<string> {
	return reachableFunctionNames(graph.callsByFunction, ["initDbAccessor", "initDbAccessorAsync"]);
}

function bootstrapOnlyFunctionNames(graph: FunctionGraph, bootstrapNames: ReadonlySet<string>): ReadonlySet<string> {
	const bootstrapOnly = new Set(["initDbAccessor", "initDbAccessorAsync"].filter((name) => bootstrapNames.has(name)));
	let changed = true;
	while (changed) {
		changed = false;
		for (const name of bootstrapNames) {
			if (bootstrapOnly.has(name)) continue;
			const callers = graph.callersByFunction.get(name);
			if (callers === undefined || [...callers].every((caller) => bootstrapOnly.has(caller))) {
				bootstrapOnly.add(name);
				changed = true;
			}
		}
	}
	return bootstrapOnly;
}

function classifySite(
	path: string,
	sourceFile: ts.SourceFile,
	functionStack: readonly string[],
	bootstrapNames: ReadonlySet<string>,
	bootstrapOnlyNames: ReadonlySet<string>,
): SiteCategory {
	const normalized = path.replaceAll("\\", "/");
	if (
		normalized === "db-accessor.ts" &&
		functionStack.some((name) => bootstrapNames.has(name)) &&
		functionStack.every((name) => bootstrapOnlyNames.has(name))
	) {
		return "pre-readiness-bootstrap";
	}
	if (isCliOnlySource(sourceFile)) return "cli-only";
	if (isIsolatedWorkerSource(sourceFile)) return "isolated-worker";
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
		const graph = functionGraph(sourceFile);
		const bootstrapNames = bootstrapFunctionNames(graph);
		const bootstrapOnlyNames = bootstrapOnlyFunctionNames(graph, bootstrapNames);
		const destructuredApis = destructuredSyncApis(sourceFile);
		const functionStack: string[] = [];
		const visit = (node: ts.Node): void => {
			const name = functionName(node);
			if (name !== null) functionStack.push(name);
			if (ts.isCallExpression(node)) {
				const call = calledSyncApi(node.expression, destructuredApis);
				if (call) {
					const line = sourceFile.getLineAndCharacterOfPosition(call.position).line;
					const source = lines[line]?.replace(/\/\/.*$/u, "").trim() ?? "";
					sites.push({
						path,
						line: line + 1,
						api: call.api,
						source,
						category: classifySite(path, sourceFile, functionStack, bootstrapNames, bootstrapOnlyNames),
					});
				}
			}
			ts.forEachChild(node, visit);
			if (name !== null) functionStack.pop();
		};
		visit(sourceFile);
	}
	return sites;
}

function calledSyncApi(
	expression: ts.Expression,
	destructuredApis: ReadonlyMap<string, SyncApi>,
): { readonly api: SyncApi; readonly position: number } | null {
	const unwrapped = unwrapExpression(expression);
	const propertyName = staticPropertyName(unwrapped);
	if (propertyName !== null) {
		if (!SYNC_APIS.includes(propertyName as SyncApi)) return null;
		const position = ts.isPropertyAccessExpression(unwrapped)
			? unwrapped.name.getStart()
			: ts.isElementAccessExpression(unwrapped)
				? (unwrapped.argumentExpression?.getStart() ?? unwrapped.getStart())
				: unwrapped.getStart();
		return { api: propertyName as SyncApi, position };
	}
	if (!ts.isIdentifier(unwrapped)) return null;
	const destructuredApi = destructuredApis.get(unwrapped.text);
	if (destructuredApi !== undefined) return { api: destructuredApi, position: expression.getStart() };
	if (unwrapped.text === "withWriteTx" || unwrapped.text === "withReadDb") return null;
	if (!SYNC_APIS.includes(unwrapped.text as SyncApi)) return null;
	return { api: unwrapped.text as SyncApi, position: unwrapped.getStart() };
}

function siteKey(site: Pick<AuditSite, "path" | "api" | "source" | "category">): string {
	return `${site.path}\u0000${site.api}\u0000${site.category}\u0000${site.source}`;
}

export function occurrenceKeys(sites: readonly AuditSite[]): Set<string> {
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

export function parseAllowlist(text: string): AllowlistEntry[] {
	const entries: AllowlistEntry[] = [];
	for (const [index, rawLine] of text.split("\n").entries()) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const [path, lineNumber, api, category, source, ...reasonParts] = line.split("|");
		const parsedLine = Number(lineNumber);
		if (
			!path ||
			!lineNumber ||
			!Number.isInteger(parsedLine) ||
			parsedLine < 1 ||
			!api ||
			!category ||
			!source ||
			reasonParts.length === 0
		) {
			throw new Error(`Invalid event-loop allowlist entry at line ${index + 1}`);
		}
		if (!SYNC_APIS.includes(api as SyncApi))
			throw new Error(`Unknown sync API in allowlist at line ${index + 1}: ${api}`);
		if (!ALLOWLIST_CATEGORIES.has(category as AllowlistCategory)) {
			throw new Error(`Invalid allowlist category at line ${index + 1}: ${category}`);
		}
		entries.push({
			path,
			line: parsedLine,
			api: api as SyncApi,
			category: category as AllowlistCategory,
			source,
			reason: reasonParts.join("|").trim(),
		});
	}
	return entries;
}

function allowlisted(site: AuditSite, entries: readonly AllowlistEntry[]): boolean {
	return entries.some(
		(entry) =>
			entry.path === site.path &&
			entry.line === site.line &&
			entry.api === site.api &&
			entry.source === site.source &&
			entry.category === site.category,
	);
}

function validateAllowlist(entries: readonly AllowlistEntry[], sites: readonly AuditSite[]): void {
	for (const entry of entries) {
		if (entry.reason.trim().length === 0) {
			throw new Error(`Allowlist entry has no justification: ${entry.path}:${entry.api}`);
		}
		const matches = sites.filter(
			(site) =>
				site.path === entry.path && site.line === entry.line && site.api === entry.api && site.source === entry.source,
		);
		if (matches.length !== 1) {
			throw new Error(
				`Allowlist entry must identify exactly one audited call site: ${entry.path}:${entry.api}:${entry.source}`,
			);
		}
		const [site] = matches;
		if (site?.category !== entry.category) {
			throw new Error(
				`Allowlist classification mismatch for ${entry.path}:${entry.api}; ` +
					`source context is ${site?.category ?? "unknown"}, not ${entry.category}`,
			);
		}
		if (HOT_PATH_MARKERS.some((marker) => entry.path.replaceAll("\\", "/").includes(marker))) {
			throw new Error(`Hot-path event-loop calls cannot be allowlisted: ${entry.path}:${entry.api}`);
		}
	}
}

export function runAudit(input: {
	readonly sourceRoot: string;
	readonly baselineSites?: readonly AuditSite[];
	readonly allowlist?: readonly AllowlistEntry[];
}): AuditResult {
	const sites = findSites(resolve(input.sourceRoot));
	validateAllowlist(input.allowlist ?? [], sites);
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

export function writeBaseline(path: string, sourceRoot: string, sites: readonly AuditSite[]): void {
	writeFileSync(path, `${JSON.stringify({ version: 1, generatedFrom: sourceRoot, sites }, null, "	")}\n`);
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
			: allowlist.map(
					(entry) =>
						`- \`${entry.path}:${entry.line}\` ${entry.api} \`${entry.source}\`: ${entry.category}. ${entry.reason}`,
				);
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
		"The legacy 1057-site baseline was not an exact inventory: it counted two comment-only lines as call sites and collapsed one real same-line call into a single site. Regenerating with the occurrence-accurate scanner yielded 1056 sites before the inventory added the four production accessSync() call sites and current-main changes now included in the 1061-site exact inventory.",
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
		"The allowlist is separate from the baseline. Every entry names one exact source call, its semantic exemption class, and a justification. The audit verifies the source context before accepting it; hot-path entries are rejected.",
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
	const liveKeys = occurrenceKeys(sites);
	const baselineKeys = occurrenceKeys(baseline.sites);
	const stale = [...baselineKeys].filter((key) => !liveKeys.has(key));
	if (stale.length > 0) {
		const preview = stale
			.slice(0, 3)
			.map((key) => {
				const [path, api] = key.split("\u0000");
				return `${path}:${api}`;
			})
			.join(", ");
		throw new Error(
			`event-loop baseline is stale: ${stale.length} baseline occurrence(s) no longer exist in the source (${preview}); run with --write-baseline to regenerate the exact inventory`,
		);
	}
	console.log(`event-loop audit passed: ${result.sites.length} production call sites checked`);
}

if (import.meta.main) await main();
