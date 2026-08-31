import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { isSemanticSyncDbCallSiteToken } from "../platform/daemon/src/sync-db-attribution";

/** The synchronous APIs recorded in the migration ledger. */
export const SYNC_APIS = [
	"withWriteTx",
	"withReadDb",
	"withWriteTxAsync",
	"withWriteDbAsync",
	"withReadDbAsync",
	"checkpointWalAsync",
	"incrementalVacuumAsync",
	"vacuumConversionAsync",
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
export type ExecutionHome = "on-parent" | "off-parent";
const LEGACY_DB_APIS = ["withWriteTx", "withReadDb"] as const;
type LegacyDbApi = (typeof LEGACY_DB_APIS)[number];
const ATTRIBUTED_DB_APIS = [
	"withWriteTx",
	"withReadDb",
	"withWriteTxAsync",
	"withWriteDbAsync",
	"withReadDbAsync",
	"checkpointWalAsync",
	"incrementalVacuumAsync",
	"vacuumConversionAsync",
] as const;
type AttributedDbApi = (typeof ATTRIBUTED_DB_APIS)[number];

export interface AuditSite {
	readonly path: string;
	readonly line: number;
	readonly api: SyncApi;
	readonly source: string;
	readonly category: SiteCategory;
}

/** A database site classified by the process that executes its callback. */
export interface ExecutionHomeSite extends AuditSite {
	readonly executionHome: ExecutionHome;
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

export interface ParentExecutionSiteViolation {
	readonly kind: "new-parent-execution-site";
	readonly path: string;
	readonly line: number;
	readonly api: Exclude<AttributedDbApi, LegacyDbApi>;
	readonly message: string;
}

export interface ExecutionHomeCounts {
	readonly total: number;
	readonly onParent: number;
	readonly offParent: number;
}

export interface LegacyDbAccessCounts {
	readonly total: number;
	readonly withReadDb: number;
	readonly withWriteTx: number;
}

/** A synchronous DB call site with no LEGACY_SYNC_DB_ACCESS marker above it. */
export interface UnmarkedLegacyDbAccessViolation {
	readonly kind: "unmarked-legacy-db-access";
	readonly path: string;
	readonly unmarked: number;
	readonly message: string;
}

/** A marked legacy DB call without its static in-flight attribution token. */
export interface MissingLegacyDbSiteTokenViolation {
	readonly kind: "missing-legacy-db-site-token";
	readonly path: string;
	readonly line: number;
	readonly api: LegacyDbApi;
	readonly message: string;
}

/** An async-named parent DB call without its static in-flight attribution token. */
export interface MissingAsyncDbSiteTokenViolation {
	readonly kind: "missing-async-db-site-token";
	readonly path: string;
	readonly line: number;
	readonly api: Exclude<AttributedDbApi, LegacyDbApi>;
	readonly message: string;
}

/** A semantic token reused by multiple DB callbacks would collapse attribution. */
export interface DuplicateSemanticDbSiteTokenViolation {
	readonly kind: "duplicate-semantic-db-site-token";
	readonly path: string;
	readonly line: number;
	readonly api: AttributedDbApi;
	readonly message: string;
}

/** Committed marker-count snapshot; the ratchet fails when the live count grows past it. */
export interface LegacyDbCountBaseline {
	readonly version: 1;
	readonly generatedFrom: string;
	readonly markedCallsites: {
		readonly total: number;
		readonly withReadDb: number;
		readonly withWriteTx: number;
	};
}

export type RatchetStatus = "pass" | "decrease" | "increase";

export interface RatchetOutcome {
	readonly status: RatchetStatus;
	readonly message: string;
}

export interface AuditResult {
	readonly sites: readonly AuditSite[];
	readonly violations: readonly (
		| ImportBoundaryViolation
		| LegacyDbAccessViolation
		| ParentExecutionSiteViolation
		| UnmarkedLegacyDbAccessViolation
		| MissingLegacyDbSiteTokenViolation
		| MissingAsyncDbSiteTokenViolation
		| DuplicateSemanticDbSiteTokenViolation
	)[];
	readonly legacyDbAccess: LegacyDbAccessCounts;
	readonly executionHomeSites: readonly ExecutionHomeSite[];
	readonly executionHome: ExecutionHomeCounts;
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
const DEFAULT_COUNT_BASELINE = "scripts/legacy-sync-db-baseline.json";
const DEFAULT_REPORT = "docs/event-loop-contract-audit.md";
const SYNC_COMPAT_MODULE = "db-accessor-sync";
const SOURCE_MODULE_EXTENSIONS = [".cjs", ".cts", ".js", ".mjs", ".mts", ".ts", ".jsx", ".tsx"] as const;
/**
 * These are the only source entrypoints proven to run in the DB-owner process.
 * Shared modules stay ON-PARENT because they can also be called by the HTTP
 * daemon; an async name is not evidence of a process boundary.
 */
const OFF_PARENT_ENTRYPOINTS = new Set(["db-owner-worker.ts"]);
const LEGACY_MARKER = /@ts-expect-error LEGACY_SYNC_DB_ACCESS: (withReadDb|withWriteTx)/g;
const MARKER_LINE = /LEGACY_SYNC_DB_ACCESS/;
/**
 * A call site counts as marked only when a LEGACY_SYNC_DB_ACCESS marker sits on
 * the line directly above the call — exactly the line whose errors a
 * `@ts-expect-error` directive suppresses, and the only placement the
 * compiler accepts (an unused directive is itself an error).
 */
const MARKER_WINDOW_LINES = 1;

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

function staticAsyncSiteToken(
	node: ts.CallExpression,
	bindings: ReadonlyMap<string, ts.Expression>,
	api: Exclude<AttributedDbApi, LegacyDbApi>,
): string | null {
	const options =
		node.arguments[api === "withReadDbAsync" || api === "withWriteTxAsync" || api === "withWriteDbAsync" ? 1 : 0];
	if (options === undefined) return null;
	const unwrapped = unwrapStaticStringExpression(options);
	if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) return unwrapped.text;
	if (!ts.isObjectLiteralExpression(unwrapped)) return null;
	for (const property of unwrapped.properties) {
		if (!ts.isPropertyAssignment(property)) continue;
		const name = property.name;
		const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
		if (key !== "siteToken") continue;
		return staticStringValue(property.initializer, bindings);
	}
	return null;
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

function findLegacyDbAccessSites(sourceRoot: string): {
	readonly sites: AuditSite[];
	readonly unmarked: UnmarkedCallSite[];
	readonly missingSiteTokens: (MissingLegacyDbSiteTokenViolation | MissingAsyncDbSiteTokenViolation)[];
	readonly semanticSiteTokens: ReadonlyArray<{
		readonly token: string;
		readonly path: string;
		readonly line: number;
		readonly api: AttributedDbApi;
	}>;
} {
	const sites: AuditSite[] = [];
	const unmarked: UnmarkedCallSite[] = [];
	const missingSiteTokens: (MissingLegacyDbSiteTokenViolation | MissingAsyncDbSiteTokenViolation)[] = [];
	const semanticSiteTokens: Array<{
		token: string;
		path: string;
		line: number;
		api: AttributedDbApi;
	}> = [];
	for (const path of walk(sourceRoot)) {
		const source = readFileSync(path, "utf8");
		const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const bindings = staticStringBindings(sourceFile);
		const lines = source.split("\n");
		const markerLines = new Set<number>();
		for (let index = 0; index < lines.length; index++) {
			if (MARKER_LINE.test(lines[index] ?? "")) markerLines.add(index + 1);
		}
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
						: ts.isIdentifier(expression)
							? expression.text
							: null;
				const isLegacyDbMemberAccess =
					ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression);
				if (SYNC_APIS.includes(api as SyncApi)) {
					const position = ts.isPropertyAccessExpression(expression)
						? expression.name.getStart(sourceFile)
						: expression.getStart(sourceFile);
					const line = lineNumber(sourceFile, position);
					sites.push({
						path: relativePath,
						line,
						api: api as SyncApi,
						source: lines[line - 1]?.trim() ?? "",
						category: "hot-path",
					});
					if (isLegacyDbMemberAccess && LEGACY_DB_APIS.includes(api as LegacyDbApi)) {
						let marked = false;
						for (let candidate = line - 1; candidate >= Math.max(1, line - MARKER_WINDOW_LINES); candidate--) {
							if (markerLines.has(candidate)) {
								marked = true;
								break;
							}
						}
						if (!marked) unmarked.push({ path: relativePath, line, api: api as LegacyDbApi });
						if (marked) {
							const tokenArgument = node.arguments[1];
							const token = tokenArgument === undefined ? null : staticStringValue(tokenArgument, bindings);
							const expected = `${relativePath}:${line}`;
							if (token !== expected && (token === null || !isSemanticSyncDbCallSiteToken(token))) {
								missingSiteTokens.push({
									kind: "missing-legacy-db-site-token",
									path: relativePath,
									line,
									api: api as LegacyDbApi,
									message: `${relativePath}:${line} ${api}() must pass ${JSON.stringify(expected)} or a static db:domain.operation token; unattributed in-flight DB calls are not allowed`,
								});
							}
							if (token !== null && isSemanticSyncDbCallSiteToken(token)) {
								semanticSiteTokens.push({ token, path: relativePath, line, api: api as LegacyDbApi });
							}
						}
					}
					if (isLegacyDbMemberAccess && ATTRIBUTED_DB_APIS.includes(api as AttributedDbApi)) {
						const isLegacy = LEGACY_DB_APIS.includes(api as LegacyDbApi);
						if (!isLegacy) {
							const expected = `${relativePath}:${line}`;
							const token = staticAsyncSiteToken(node, bindings, api as Exclude<AttributedDbApi, LegacyDbApi>);
							const dynamicTokenBoundary = lines
								.slice(Math.max(0, line - 3), line)
								.some((candidate) => candidate.includes("DYNAMIC_SITE_TOKEN"));
							if (
								!dynamicTokenBoundary &&
								token !== expected &&
								(token === null || !isSemanticSyncDbCallSiteToken(token))
							) {
								missingSiteTokens.push({
									kind: "missing-async-db-site-token",
									path: relativePath,
									line,
									api: api as Exclude<AttributedDbApi, LegacyDbApi>,
									message: `${relativePath}:${line} ${api}() must pass ${JSON.stringify(expected)} or a static db:domain.operation token; unattributed in-flight DB calls are not allowed`,
								});
							}
							if (token !== null && isSemanticSyncDbCallSiteToken(token)) {
								semanticSiteTokens.push({
									token,
									path: relativePath,
									line,
									api: api as Exclude<AttributedDbApi, LegacyDbApi>,
								});
							}
						}
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return { sites, unmarked, missingSiteTokens, semanticSiteTokens };
}

function findDuplicateSemanticSiteTokens(
	uses: ReadonlyArray<{
		readonly token: string;
		readonly path: string;
		readonly line: number;
		readonly api: AttributedDbApi;
	}>,
): DuplicateSemanticDbSiteTokenViolation[] {
	const byToken = new Map<string, typeof uses>();
	for (const use of uses) byToken.set(use.token, [...(byToken.get(use.token) ?? []), use]);
	return [...byToken.entries()].flatMap(([token, tokenUses]) =>
		tokenUses.length < 2
			? []
			: tokenUses.map((use) => ({
					kind: "duplicate-semantic-db-site-token" as const,
					path: use.path,
					line: use.line,
					api: use.api,
					message: `${use.path}:${use.line} reuses semantic DB site token ${JSON.stringify(token)}; semantic attribution IDs must identify exactly one callback`,
				})),
	);
}

/**
 * Classify database accessor sites by the process that executes their callback.
 * Direct accessor calls are ON-PARENT unless the source is the explicit
 * DB-owner process entrypoint. Shared modules remain ON-PARENT when they can
 * also be reached from the HTTP daemon.
 */
export function classifyExecutionHomes(sites: readonly AuditSite[]): readonly ExecutionHomeSite[] {
	return sites.flatMap((site) => {
		if (!ATTRIBUTED_DB_APIS.includes(site.api as AttributedDbApi)) return [];
		return [
			{
				...site,
				executionHome: OFF_PARENT_ENTRYPOINTS.has(site.path) ? "off-parent" : "on-parent",
			},
		];
	});
}

export function countExecutionHomes(sites: readonly ExecutionHomeSite[]): ExecutionHomeCounts {
	const onParent = sites.filter((site) => site.executionHome === "on-parent").length;
	return { total: sites.length, onParent, offParent: sites.length - onParent };
}

/** A synchronous DB call site with no LEGACY_SYNC_DB_ACCESS marker within the marker window. */
export interface UnmarkedCallSite {
	readonly path: string;
	readonly line: number;
	readonly api: LegacyDbApi;
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

function findNewParentExecutionSiteViolations(
	sites: readonly ExecutionHomeSite[],
	baselineSites: readonly AuditSite[],
): ParentExecutionSiteViolation[] {
	const baselineKeys = occurrenceKeys(
		classifyExecutionHomes(baselineSites).filter((site) => site.executionHome === "on-parent"),
	);
	const seen = new Map<string, number>();
	const violations: ParentExecutionSiteViolation[] = [];
	for (const site of sites) {
		// New synchronous calls already have their legacy-ledger violation. This
		// rule is the additional guard for the fake-async class.
		if (site.executionHome !== "on-parent" || LEGACY_DB_APIS.includes(site.api as LegacyDbApi)) continue;
		const base = siteKey(site);
		const occurrence = (seen.get(base) ?? 0) + 1;
		seen.set(base, occurrence);
		if (baselineKeys.has(`${base}\u0000${occurrence}`)) continue;
		violations.push({
			kind: "new-parent-execution-site",
			path: site.path,
			line: site.line,
			api: site.api as Exclude<AttributedDbApi, LegacyDbApi>,
			message: `${site.path}:${site.line} adds ON-PARENT ${site.api}() beyond the committed execution-home ledger; route the callback through the DB-owner IPC boundary instead`,
		});
	}
	return violations;
}

export function countLegacyDbAccess(sourceRoot: string): LegacyDbAccessCounts {
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

export function findUnmarkedLegacyDbAccess(unmarked: readonly UnmarkedCallSite[]): UnmarkedLegacyDbAccessViolation[] {
	if (unmarked.length === 0) return [];
	const byPath = new Map<string, UnmarkedCallSite[]>();
	for (const site of unmarked) {
		const sites = byPath.get(site.path) ?? [];
		sites.push(site);
		byPath.set(site.path, sites);
	}
	return [...byPath.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([path, sites]) => ({
			kind: "unmarked-legacy-db-access" as const,
			path,
			unmarked: sites.length,
			message:
				`${path}:${sites.map((site) => `${site.line}(${site.api})`).join(", ")} calls synchronous DB APIs ` +
				`without a LEGACY_SYNC_DB_ACCESS marker on the line above; new synchronous DB access is not allowed — ` +
				`convert the call site to withReadDbAsync/withWriteTxAsync (or thread an async wrapper) instead`,
		}));
}

export function evaluateCountRatchet(counts: LegacyDbAccessCounts, baseline: LegacyDbCountBaseline): RatchetOutcome {
	const baselineTotal = baseline.markedCallsites.total;
	if (counts.total > baselineTotal) {
		return {
			status: "increase",
			message:
				`legacy sync DB marker count increased: ${baselineTotal} -> ${counts.total} ` +
				`(withReadDb ${baseline.markedCallsites.withReadDb} -> ${counts.withReadDb}, ` +
				`withWriteTx ${baseline.markedCallsites.withWriteTx} -> ${counts.withWriteTx}); ` +
				`the ratchet only goes down — convert the new call site to withReadDbAsync/withWriteTxAsync`,
		};
	}
	if (counts.total < baselineTotal) {
		return {
			status: "decrease",
			message:
				`legacy sync DB marker count decreased: ${baselineTotal} -> ${counts.total}; ` +
				`commit the new count in scripts/legacy-sync-db-baseline.json in this PR to tighten the ratchet ` +
				`(run: bun scripts/legacy-sync-db-baseline.ts)`,
		};
	}
	return { status: "pass", message: `legacy sync DB marker count holds at ${counts.total}` };
}

export function loadCountBaseline(path = DEFAULT_COUNT_BASELINE): LegacyDbCountBaseline {
	const baseline = JSON.parse(readFileSync(resolve(path), "utf8")) as LegacyDbCountBaseline;
	if (baseline.version !== 1 || typeof baseline.markedCallsites?.total !== "number") {
		throw new Error(`Invalid legacy sync DB count baseline: ${path}`);
	}
	return baseline;
}

export function writeCountBaseline(
	counts: LegacyDbAccessCounts,
	path = DEFAULT_COUNT_BASELINE,
	generatedFrom = "bun scripts/legacy-sync-db-baseline.ts",
): void {
	const output: LegacyDbCountBaseline = {
		version: 1,
		generatedFrom,
		markedCallsites: {
			total: counts.total,
			withReadDb: counts.withReadDb,
			withWriteTx: counts.withWriteTx,
		},
	};
	// Tab indentation matches Biome's canonical JSON formatting so
	// regenerated baselines never churn the tree.
	writeFileSync(resolve(path), `${JSON.stringify(output, null, "	")}\n`);
}

export function runAudit(options: AuditOptions): AuditResult {
	const { sites, unmarked, missingSiteTokens, semanticSiteTokens } = findLegacyDbAccessSites(options.sourceRoot);
	const baselineSites = options.baselineSites ?? [];
	const executionHomeSites = classifyExecutionHomes(sites);
	return {
		sites,
		violations: [
			...findImportBoundaryViolations(options.sourceRoot, new Set(options.allowedSyncCompatImporters ?? [])),
			...findNewLegacyDbAccessViolations(sites, baselineSites),
			...findNewParentExecutionSiteViolations(executionHomeSites, baselineSites),
			...findUnmarkedLegacyDbAccess(unmarked),
			...missingSiteTokens,
			...findDuplicateSemanticSiteTokens(semanticSiteTokens),
		],
		legacyDbAccess: countLegacyDbAccess(options.sourceRoot),
		executionHomeSites,
		executionHome: countExecutionHomes(executionHomeSites),
	};
}

export function loadBaseline(path = DEFAULT_BASELINE): readonly AuditSite[] {
	const baseline = JSON.parse(readFileSync(resolve(path), "utf8")) as BaselineFile;
	if (baseline.version !== 1 || !Array.isArray(baseline.sites)) throw new Error(`Invalid event-loop baseline: ${path}`);
	return baseline.sites;
}

export function writeBaseline(sites: readonly AuditSite[], path = DEFAULT_BASELINE): void {
	const output: BaselineFile = {
		version: 1,
		generatedFrom: "bun scripts/audit-event-loop-contract.ts --write-baseline",
		sites,
	};
	writeFileSync(resolve(path), `${JSON.stringify(output, null, 2)}\n`);
}

export function renderReport(baselineSites: readonly AuditSite[], legacyDbAccess: LegacyDbAccessCounts): string {
	const counts = new Map<SyncApi, number>();
	for (const site of baselineSites) counts.set(site.api, (counts.get(site.api) ?? 0) + 1);
	const asyncDbCount = ATTRIBUTED_DB_APIS.filter((api) => !LEGACY_DB_APIS.includes(api as LegacyDbApi)).reduce(
		(total, api) => total + (counts.get(api) ?? 0),
		0,
	);
	const filesystemProcessCount =
		baselineSites.length - (counts.get("withReadDb") ?? 0) - (counts.get("withWriteTx") ?? 0) - asyncDbCount;
	const executionHomeSites = classifyExecutionHomes(baselineSites);
	const executionHome = countExecutionHomes(executionHomeSites);
	const asyncDbSites = executionHomeSites.filter((site) => !LEGACY_DB_APIS.includes(site.api as LegacyDbApi));
	const asyncDbOnParent = asyncDbSites.filter((site) => site.executionHome === "on-parent").length;
	const asyncDbOffParent = asyncDbSites.length - asyncDbOnParent;
	const executionHomeList = (home: ExecutionHome): string => {
		const sites = executionHomeSites.filter((site) => site.executionHome === home);
		return sites.length === 0
			? "- None"
			: sites.map((site) => `- \`${site.path}:${site.line}\` (${site.api})`).join("\n");
	};
	return `# Event-loop synchronous contract audit

This report is generated from the deterministic migration ledger in \`scripts/event-loop-contract-baseline.json\`. Phase A enforces the type boundary structurally: production code receives an async-only \`DbAccessor\`, while the synchronous compatibility module lives outside the daemon production \`src/\` tree and is rejected by the production TypeScript project's \`rootDir\`. The AST import and call checks remain belt-and-suspenders diagnostics, and new synchronous DB call sites fail closed through exact ledger matching.

## Current inventory

- Exact ledger inventory: ${baselineSites.length} sites
- Synchronous \`withWriteTx()\` sites: ${counts.get("withWriteTx") ?? 0}
- Synchronous \`withReadDb()\` sites: ${counts.get("withReadDb") ?? 0}
- Async-named DB sites: ${asyncDbCount}
- Async-named ON-PARENT DB sites: ${asyncDbOnParent}
- Async-named OFF-PARENT DB sites: ${asyncDbOffParent}
- Synchronous filesystem/process sites: ${filesystemProcessCount}
- Compile-visible legacy DB sites remaining: ${legacyDbAccess.total}
  - \`withWriteTx\`: ${legacyDbAccess.withWriteTx}
  - \`withReadDb\`: ${legacyDbAccess.withReadDb}

The ${baselineSites.length.toLocaleString("en-US")}-site inventory excludes test, benchmark, generated, and \`__tests__\` fixtures and includes every synchronous filesystem, process, and database call, including async-named DB callbacks. The ${counts.get("withWriteTx") ?? 0} synchronous writes, ${counts.get("withReadDb") ?? 0} synchronous reads, and ${asyncDbCount} async-named DB sites are the complete database-call inventory; ${legacyDbAccess.total} compatibility DB operations remain transitional callers for the later migration phase. The async-named DB counts above separate the ${asyncDbOnParent} ON-PARENT callbacks from the ${asyncDbOffParent} OFF-PARENT callbacks. Those compatibility calls are marked with \`@ts-expect-error LEGACY_SYNC_DB_ACCESS\`, so the compiler reports every remaining site without forcing this phase to migrate them.

## Execution-home inventory

- Database accessor sites classified: ${executionHome.total}
- ON-PARENT callback execution: ${executionHome.onParent}
- OFF-PARENT callback execution: ${executionHome.offParent}
- Ratchet: new ON-PARENT async-named sites fail the audit; the campaign target is ON-PARENT → 0

The classifier follows execution home, not API spelling. A direct accessor callback is ON-PARENT unless its source is the explicit DB-owner process entrypoint; shared modules remain ON-PARENT when they can also be reached from the HTTP daemon. Owner IPC helpers named dbOwner, owner, or ThroughDbOwner are already off-parent by construction because their SQL statements execute in the owner child rather than through a local accessor callback.

### ON-PARENT sites

${executionHomeList("on-parent")}

### OFF-PARENT sites

${executionHomeList("off-parent")}

## A3 Slice 2 migration notes

The converted async sites are distributed as follows: document-worker (18), dreaming (28), retention (6), repair-actions (31), and source-lifecycle-telemetry (8), for 91 sites total.

## Enforcement boundary

- Statically-resolved production imports of the compatibility module fail the daemon TypeScript project because the module is outside its source rootDir. The AST import scan remains a supplementary diagnostic for source-tree execution.
- DbAccessor exports only asynchronous transaction and read primitives.
- db-accessor-sync.ts is the explicit compatibility surface for test/bootstrap-only code. Its module documentation records the pre-readiness bootstrap, CLI, and isolated-worker rationale.
- The migration ledger is an allowlist for existing synchronous DB callers. It may shrink, but a new synchronous DB call is a violation even when its type error is suppressed.

## Risk and follow-up

The structural boundary makes statically-resolved imports from the production source tree impossible: TypeScript reports TS6059 before aliases or computed member calls can use the compatibility type. The production bundle also only starts from source entrypoints, so this compatibility module is not a shipped production artifact.

A runtime-computed require() or import() can still reach a source-tree file when a development process deliberately constructs the path. TypeScript cannot prove an unresolved runtime string, and the AST audit remains the supplementary guard for that source-execution residual. This Phase A boundary intentionally leaves the synchronous methods on the runtime accessor so the ${legacyDbAccess.total} transitional callers keep working. The deferred final cleanup is explicit: first land the six A3 caller-migration slices that convert all ${legacyDbAccess.withWriteTx} write and ${legacyDbAccess.withReadDb} read markers to async, then remove the runtime synchronous methods and compatibility module in a follow-up.
`;
}

function main(): void {
	const regenerateBaseline = process.argv.includes("--write-baseline");
	const committedBaseline = loadBaseline();
	const countBaseline = loadCountBaseline();
	const result = runAudit({ sourceRoot: resolve(DEFAULT_SOURCE_ROOT), baselineSites: committedBaseline });
	if (regenerateBaseline) writeBaseline(result.sites);
	const baselineSites = regenerateBaseline ? result.sites : committedBaseline;
	const report = renderReport(baselineSites, result.legacyDbAccess);
	writeFileSync(resolve(DEFAULT_REPORT), report);
	console.log(`Ledger inventory: ${baselineSites.length}`);
	console.log(
		`Legacy DB sites: ${result.legacyDbAccess.total} (${result.legacyDbAccess.withWriteTx} writes, ${result.legacyDbAccess.withReadDb} reads)`,
	);
	console.log(
		`Execution home: ${result.executionHome.onParent} ON-PARENT, ${result.executionHome.offParent} OFF-PARENT`,
	);
	const ratchet = evaluateCountRatchet(result.legacyDbAccess, countBaseline);
	if (ratchet.status === "increase") {
		console.error(`RATCHET FAIL: ${ratchet.message}`);
		process.exitCode = 1;
	} else {
		console.log(`Ratchet: ${ratchet.message}`);
	}
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
