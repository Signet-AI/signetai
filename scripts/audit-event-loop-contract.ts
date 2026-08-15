import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

/** The synchronous APIs recorded in the migration ledger. */
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
export type SiteCategory = "pre-readiness-bootstrap" | "cli-only" | "isolated-worker" | "hot-path";
const LEGACY_DB_APIS = ["withWriteTx", "withReadDb"] as const;
type LegacyDbApi = (typeof LEGACY_DB_APIS)[number];

export interface AuditSite {
	readonly path: string;
	readonly line: number;
	readonly api: SyncApi;
	readonly source: string;
	readonly category: SiteCategory;
}

export interface ImportBoundaryViolation {
	readonly kind: "import-boundary";
	readonly path: string;
	readonly line: number;
	readonly moduleName: string;
	readonly message: string;
}

export interface LegacyDbAccessViolation {
	readonly kind: "new-legacy-db-access";
	readonly path: string;
	readonly line: number;
	readonly api: LegacyDbApi;
	readonly message: string;
}

export interface LegacyDbAccessCounts {
	readonly total: number;
	readonly withWriteTx: number;
	readonly withReadDb: number;
}

export interface AuditResult {
	readonly sites: readonly AuditSite[];
	readonly violations: readonly (ImportBoundaryViolation | LegacyDbAccessViolation)[];
	readonly legacyDbAccess: LegacyDbAccessCounts;
}

interface BaselineFile {
	readonly version: 1;
	readonly generatedFrom: string;
	readonly sites: readonly AuditSite[];
}

interface AuditOptions {
	readonly sourceRoot: string;
	readonly baselineSites?: readonly AuditSite[];
	/** Exact compatibility importers. An omitted entry is a violation. */
	readonly allowedSyncCompatImporters?: readonly string[];
}

const DEFAULT_SOURCE_ROOT = "platform/daemon/src";
const DEFAULT_BASELINE = "scripts/event-loop-contract-baseline.json";
const DEFAULT_REPORT = "docs/event-loop-contract-audit.md";
const SYNC_COMPAT_MODULE = "db-accessor-sync";
const SOURCE_MODULE_EXTENSIONS = [".cjs", ".cts", ".js", ".mjs", ".mts", ".ts", ".jsx", ".tsx"] as const;
const LEGACY_MARKER = /@ts-expect-error LEGACY_SYNC_DB_ACCESS: (withReadDb|withWriteTx)/g;

function isExcludedSource(path: string): boolean {
	return (
		path.endsWith(".test.ts") || path.endsWith(".bench.ts") || path.includes("/__tests__/") || path.includes("/dist/")
	);
}

function walk(root: string): string[] {
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(path);
				continue;
			}
			if (entry.isFile() && path.endsWith(".ts") && !path.endsWith(".d.ts") && !isExcludedSource(path))
				files.push(path);
		}
	};
	visit(root);
	return files.sort();
}

function lineNumber(sourceFile: ts.SourceFile, position: number): number {
	return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function isSyncCompatModule(moduleName: string): boolean {
	const normalized = SOURCE_MODULE_EXTENSIONS.reduce(
		(current, extension) => (current.endsWith(extension) ? current.slice(0, -extension.length) : current),
		moduleName,
	);
	return normalized === SYNC_COMPAT_MODULE || normalized.endsWith(`/${SYNC_COMPAT_MODULE}`);
}

function isAllowedSyncCompatImporter(relativePath: string, allowed: ReadonlySet<string>): boolean {
	return allowed.has(relativePath);
}

function unwrapStaticStringExpression(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isTypeAssertionExpression(current) ||
		ts.isNonNullExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function staticStringValue(
	expression: ts.Expression,
	bindings: ReadonlyMap<string, ts.Expression>,
	resolving = new Set<string>(),
): string | null {
	const unwrapped = unwrapStaticStringExpression(expression);
	if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) return unwrapped.text;
	if (ts.isTemplateExpression(unwrapped)) {
		let value = unwrapped.head.text;
		for (const span of unwrapped.templateSpans) {
			const expressionValue = staticStringValue(span.expression, bindings, resolving);
			if (expressionValue === null) return null;
			value += expressionValue + span.literal.text;
		}
		return value;
	}
	if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const left = staticStringValue(unwrapped.left, bindings, resolving);
		const right = staticStringValue(unwrapped.right, bindings, resolving);
		return left !== null && right !== null ? left + right : null;
	}
	if (!ts.isIdentifier(unwrapped) || resolving.has(unwrapped.text)) return null;
	const initializer = bindings.get(unwrapped.text);
	if (initializer === undefined) return null;
	const nextResolving = new Set(resolving);
	nextResolving.add(unwrapped.text);
	return staticStringValue(initializer, bindings, nextResolving);
}

function staticStringBindings(sourceFile: ts.SourceFile): ReadonlyMap<string, ts.Expression> {
	const bindings = new Map<string, ts.Expression>();
	const visit = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer !== undefined &&
			ts.isVariableDeclarationList(node.parent) &&
			(node.parent.flags & ts.NodeFlags.Const) !== 0
		) {
			bindings.set(node.name.text, node.initializer);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return bindings;
}

function findImportBoundaryViolations(
	sourceRoot: string,
	allowedSyncCompatImporters: ReadonlySet<string>,
): ImportBoundaryViolation[] {
	const violations: ImportBoundaryViolation[] = [];
	for (const path of walk(sourceRoot)) {
		const source = readFileSync(path, "utf8");
		const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const relativePath = relative(sourceRoot, path).replaceAll("\\", "/");
		const bindings = staticStringBindings(sourceFile);
		if (isAllowedSyncCompatImporter(relativePath, allowedSyncCompatImporters)) continue;
		const visit = (node: ts.Node): void => {
			const report = (moduleName: string, position: number, form: string): void => {
				const line = lineNumber(sourceFile, position);
				violations.push({
					kind: "import-boundary",
					path: relativePath,
					line,
					moduleName,
					message: `${relativePath}:${line} ${form} ${moduleName}; sync compatibility imports must be explicitly allowlisted by exact call site`,
				});
			};
			const reportDynamicTemplate = (argument: ts.Expression, position: number, form: string): void => {
				const line = lineNumber(sourceFile, position);
				const moduleName = argument.getText(sourceFile);
				violations.push({
					kind: "import-boundary",
					path: relativePath,
					line,
					moduleName,
					message: `${relativePath}:${line} ${form} ${moduleName}; dynamic template module specifiers are rejected in production files, use a literal import`,
				});
			};
			if (
				ts.isImportDeclaration(node) &&
				ts.isStringLiteral(node.moduleSpecifier) &&
				isSyncCompatModule(node.moduleSpecifier.text)
			) {
				report(node.moduleSpecifier.text, node.getStart(sourceFile), "imports");
			}
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
				const [argument] = node.arguments;
				const moduleName = argument === undefined ? null : staticStringValue(argument, bindings);
				if (moduleName !== null && isSyncCompatModule(moduleName)) {
					report(moduleName, node.getStart(sourceFile), "requires");
				} else if (
					moduleName === null &&
					argument !== undefined &&
					ts.isTemplateExpression(unwrapStaticStringExpression(argument))
				) {
					reportDynamicTemplate(argument, node.getStart(sourceFile), "requires");
				}
			}
			if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				const [argument] = node.arguments;
				const moduleName = argument === undefined ? null : staticStringValue(argument, bindings);
				if (moduleName !== null && isSyncCompatModule(moduleName)) {
					report(moduleName, node.getStart(sourceFile), "dynamically imports");
				} else if (
					moduleName === null &&
					argument !== undefined &&
					ts.isTemplateExpression(unwrapStaticStringExpression(argument))
				) {
					reportDynamicTemplate(argument, node.getStart(sourceFile), "dynamically imports");
				}
			}
			if (
				ts.isImportEqualsDeclaration(node) &&
				ts.isExternalModuleReference(node.moduleReference) &&
				node.moduleReference.expression !== undefined &&
				ts.isStringLiteral(node.moduleReference.expression) &&
				isSyncCompatModule(node.moduleReference.expression.text)
			) {
				report(node.moduleReference.expression.text, node.getStart(sourceFile), "requires");
			}
			if (
				ts.isExportDeclaration(node) &&
				node.moduleSpecifier !== undefined &&
				ts.isStringLiteral(node.moduleSpecifier) &&
				isSyncCompatModule(node.moduleSpecifier.text)
			) {
				report(node.moduleSpecifier.text, node.getStart(sourceFile), "re-exports");
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return violations;
}

function findLegacyDbAccessSites(sourceRoot: string): AuditSite[] {
	const sites: AuditSite[] = [];
	for (const path of walk(sourceRoot)) {
		const source = readFileSync(path, "utf8");
		const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const lines = source.split("\n");
		const relativePath = relative(sourceRoot, path).replaceAll("\\", "/");
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				const expression = node.expression;
				const api = ts.isPropertyAccessExpression(expression)
					? expression.name.text
					: ts.isElementAccessExpression(expression) &&
							expression.argumentExpression !== undefined &&
							(ts.isStringLiteral(expression.argumentExpression) ||
								ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))
						? expression.argumentExpression.text
						: null;
				if (LEGACY_DB_APIS.includes(api as LegacyDbApi)) {
					const position = ts.isPropertyAccessExpression(expression)
						? expression.name.getStart(sourceFile)
						: expression.getStart(sourceFile);
					const line = lineNumber(sourceFile, position);
					sites.push({
						path: relativePath,
						line,
						api: api as LegacyDbApi,
						source: lines[line - 1]?.trim() ?? "",
						category: "hot-path",
					});
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return sites;
}

function siteKey(site: Pick<AuditSite, "path" | "api" | "source">): string {
	return `${site.path}\u0000${site.api}\u0000${site.source}`;
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

export function findStaleBaselineSites(
	sites: readonly AuditSite[],
	baselineSites: readonly AuditSite[],
): readonly AuditSite[] {
	const liveKeys = occurrenceKeys(sites);
	const seen = new Map<string, number>();
	return baselineSites.filter((site) => {
		if (!LEGACY_DB_APIS.includes(site.api as LegacyDbApi)) return false;
		const base = siteKey(site);
		const occurrence = (seen.get(base) ?? 0) + 1;
		seen.set(base, occurrence);
		return !liveKeys.has(`${base}\u0000${occurrence}`);
	});
}

function findNewLegacyDbAccessViolations(
	sites: readonly AuditSite[],
	baselineSites: readonly AuditSite[],
): LegacyDbAccessViolation[] {
	const baselineKeys = occurrenceKeys(baselineSites);
	const seen = new Map<string, number>();
	const violations: LegacyDbAccessViolation[] = [];
	for (const site of sites) {
		if (!LEGACY_DB_APIS.includes(site.api as LegacyDbApi)) continue;
		const base = siteKey(site);
		const occurrence = (seen.get(base) ?? 0) + 1;
		seen.set(base, occurrence);
		if (baselineKeys.has(`${base}\u0000${occurrence}`)) continue;
		violations.push({
			kind: "new-legacy-db-access",
			path: site.path,
			line: site.line,
			api: site.api as LegacyDbApi,
			message: `${site.path}:${site.line} adds synchronous ${site.api}() beyond the committed legacy migration ledger; LEGACY_SYNC_DB_ACCESS cannot authorize new callers`,
		});
	}
	return violations;
}

function countLegacyDbAccess(sourceRoot: string): LegacyDbAccessCounts {
	let withReadDb = 0;
	let withWriteTx = 0;
	for (const path of walk(sourceRoot)) {
		const matches = readFileSync(path, "utf8").match(LEGACY_MARKER) ?? [];
		for (const match of matches) {
			if (match.endsWith("withReadDb")) withReadDb++;
			if (match.endsWith("withWriteTx")) withWriteTx++;
		}
	}
	return { total: withReadDb + withWriteTx, withReadDb, withWriteTx };
}

export function runAudit(options: AuditOptions): AuditResult {
	const sites = findLegacyDbAccessSites(options.sourceRoot);
	const baselineSites = options.baselineSites ?? [];
	return {
		sites,
		violations: [
			...findImportBoundaryViolations(options.sourceRoot, new Set(options.allowedSyncCompatImporters ?? [])),
			...findNewLegacyDbAccessViolations(sites, baselineSites),
		],
		legacyDbAccess: countLegacyDbAccess(options.sourceRoot),
	};
}

export function loadBaseline(path = DEFAULT_BASELINE): readonly AuditSite[] {
	const baseline = JSON.parse(readFileSync(resolve(path), "utf8")) as BaselineFile;
	if (baseline.version !== 1 || !Array.isArray(baseline.sites)) throw new Error(`Invalid event-loop baseline: ${path}`);
	return baseline.sites;
}

export function writeBaseline(sites: readonly AuditSite[], path = DEFAULT_BASELINE): void {
	const output: BaselineFile = { version: 1, generatedFrom: "manual migration ledger", sites };
	writeFileSync(resolve(path), `${JSON.stringify(output, null, 2)}\n`);
}

export function renderReport(baselineSites: readonly AuditSite[], legacyDbAccess: LegacyDbAccessCounts): string {
	const counts = new Map<SyncApi, number>();
	for (const site of baselineSites) counts.set(site.api, (counts.get(site.api) ?? 0) + 1);
	const writeCount = counts.get("withWriteTx") ?? 0;
	const readCount = counts.get("withReadDb") ?? 0;
	const filesystemProcessCount = baselineSites.length - writeCount - readCount;
	const formatCount = (value: number): string => value.toLocaleString("en-US");
	return `# Event-loop synchronous contract audit

This report is generated from the deterministic migration ledger in \`scripts/event-loop-contract-baseline.json\`. Phase A enforces the type boundary structurally: production code receives an async-only \`DbAccessor\`, while the synchronous compatibility module lives outside the daemon production \`src/\` tree and is rejected by the production TypeScript project's \`rootDir\`. The AST import and call checks remain belt-and-suspenders diagnostics, and new synchronous DB call sites fail closed through exact ledger matching.

## Current inventory

- Exact ledger inventory: ${formatCount(baselineSites.length)} sites
- Synchronous \`withWriteTx()\` sites: ${formatCount(writeCount)}
- Synchronous \`withReadDb()\` sites: ${formatCount(readCount)}
- Synchronous filesystem/process sites: ${formatCount(filesystemProcessCount)}
- Compile-visible legacy DB sites remaining: ${formatCount(legacyDbAccess.total)}
  - \`withWriteTx\`: ${formatCount(legacyDbAccess.withWriteTx)}
  - \`withReadDb\`: ${formatCount(legacyDbAccess.withReadDb)}

The ${formatCount(baselineSites.length)}-site inventory excludes test, benchmark, generated, and \`__tests__\` fixtures. The ${formatCount(writeCount)} synchronous writes and ${formatCount(readCount)} synchronous reads remain transitional callers for the later migration phase. They are marked with \`@ts-expect-error LEGACY_SYNC_DB_ACCESS\`, so the compiler reports every remaining site without forcing this phase to migrate ${formatCount(writeCount + readCount)} database operations.

## A3 Slice 2 migration notes

The converted async sites are distributed as follows: document-worker (18), dreaming (28), retention (6), repair-actions (31), and source-lifecycle-telemetry (8), for 91 sites total.

## Enforcement boundary

- Statically-resolved production imports of the compatibility module fail the daemon TypeScript project because the module is outside its source rootDir. The AST import scan remains a supplementary diagnostic for source-tree execution.
- DbAccessor exports only asynchronous transaction and read primitives.
- db-accessor-sync.ts is the explicit compatibility surface for test/bootstrap-only code. Its module documentation records the pre-readiness bootstrap, CLI, and isolated-worker rationale.
- The migration ledger is an allowlist for existing synchronous DB callers. It may shrink, but a new synchronous DB call is a violation even when its type error is suppressed.

## Risk and follow-up

The structural boundary makes statically-resolved imports from the production source tree impossible: TypeScript reports TS6059 before aliases or computed member calls can use the compatibility type. The production bundle also only starts from source entrypoints, so this compatibility module is not a shipped production artifact.

A runtime-computed require() or import() can still reach a source-tree file when a development process deliberately constructs the path. TypeScript cannot prove an unresolved runtime string, and the AST audit remains the supplementary guard for that source-execution residual. This Phase A boundary intentionally leaves the synchronous methods on the runtime accessor so the ${formatCount(legacyDbAccess.total)} transitional callers keep working. The deferred final cleanup is explicit: first land the six A3 caller-migration slices that convert all ${formatCount(legacyDbAccess.withWriteTx)} write and ${formatCount(legacyDbAccess.withReadDb)} read markers to async, then remove the runtime synchronous methods and compatibility module in a follow-up.
`;
}

function main(): void {
	const baselineSites = loadBaseline();
	const result = runAudit({ sourceRoot: resolve(DEFAULT_SOURCE_ROOT), baselineSites });
	const report = renderReport(baselineSites, result.legacyDbAccess);
	writeFileSync(resolve(DEFAULT_REPORT), report);
	console.log(`Ledger inventory: ${baselineSites.length}`);
	console.log(
		`Legacy DB sites: ${result.legacyDbAccess.total} (${result.legacyDbAccess.withWriteTx} writes, ${result.legacyDbAccess.withReadDb} reads)`,
	);
	if (result.violations.length > 0) {
		for (const violation of result.violations) console.error(violation.message);
		process.exitCode = 1;
	}
	const stale = findStaleBaselineSites(result.sites, baselineSites);
	if (stale.length > 0) {
		const preview = stale
			.slice(0, 3)
			.map((site) => `${site.path}:${site.line}:${site.api}`)
			.join(", ");
		console.error(
			`event-loop baseline is stale: ${stale.length} baseline occurrence(s) no longer exist in the source (${preview}); run the deliberate baseline regeneration workflow`,
		);
		process.exitCode = 1;
	}
}

if (import.meta.main) main();
