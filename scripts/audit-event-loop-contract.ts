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

export interface AuditSite {
	readonly path: string;
	readonly line: number;
	readonly api: SyncApi;
	readonly source: string;
	readonly category: SiteCategory;
}

export interface ImportBoundaryViolation {
	readonly path: string;
	readonly line: number;
	readonly moduleName: string;
	readonly message: string;
}

export interface LegacyDbAccessCounts {
	readonly total: number;
	readonly withWriteTx: number;
	readonly withReadDb: number;
}

export interface AuditResult {
	readonly sites: readonly AuditSite[];
	readonly violations: readonly ImportBoundaryViolation[];
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
}

const DEFAULT_SOURCE_ROOT = "platform/daemon/src";
const DEFAULT_BASELINE = "scripts/event-loop-contract-baseline.json";
const DEFAULT_REPORT = "docs/event-loop-contract-audit.md";
const SYNC_COMPAT_MODULE = "db-accessor-sync";
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
	return moduleName === SYNC_COMPAT_MODULE || moduleName.endsWith(`/${SYNC_COMPAT_MODULE}`);
}

function isAllowedSyncCompatImporter(relativePath: string): boolean {
	return /^(?:bootstrap|cli|workers)\//.test(relativePath);
}

function findImportBoundaryViolations(sourceRoot: string): ImportBoundaryViolation[] {
	const violations: ImportBoundaryViolation[] = [];
	for (const path of walk(sourceRoot)) {
		const source = readFileSync(path, "utf8");
		const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const relativePath = relative(sourceRoot, path).replaceAll("\\", "/");
		if (isAllowedSyncCompatImporter(relativePath)) continue;
		const visit = (node: ts.Node): void => {
			if (
				ts.isImportDeclaration(node) &&
				ts.isStringLiteral(node.moduleSpecifier) &&
				isSyncCompatModule(node.moduleSpecifier.text)
			) {
				violations.push({
					path: relativePath,
					line: lineNumber(sourceFile, node.getStart(sourceFile)),
					moduleName: node.moduleSpecifier.text,
					message: `${relativePath}:${lineNumber(sourceFile, node.getStart(sourceFile))} imports ${node.moduleSpecifier.text}; only bootstrap, CLI, and isolated worker modules may use the sync compatibility surface`,
				});
			}
			if (
				(ts.isCallExpression(node) || ts.isImportEqualsDeclaration(node)) &&
				ts.isCallExpression(node) &&
				node.expression.kind === ts.SyntaxKind.ImportKeyword &&
				node.arguments.length === 1 &&
				ts.isStringLiteral(node.arguments[0]) &&
				isSyncCompatModule(node.arguments[0].text)
			) {
				violations.push({
					path: relativePath,
					line: lineNumber(sourceFile, node.getStart(sourceFile)),
					moduleName: node.arguments[0].text,
					message: `${relativePath}:${lineNumber(sourceFile, node.getStart(sourceFile))} dynamically imports ${node.arguments[0].text}; only bootstrap, CLI, and isolated worker modules may use the sync compatibility surface`,
				});
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
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
	return {
		sites: options.baselineSites ?? [],
		violations: findImportBoundaryViolations(options.sourceRoot),
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
	const filesystemProcessCount =
		baselineSites.length - (counts.get("withReadDb") ?? 0) - (counts.get("withWriteTx") ?? 0);
	return `# Event-loop synchronous contract audit

This report is generated from the deterministic migration ledger in \`scripts/event-loop-contract-baseline.json\`. The ledger is a reporting surface, not a scanner-based gate. Phase A enforces the new type boundary: production code receives an async-only \`DbAccessor\`, and CI rejects production imports of the explicit sync compatibility module.

## Current inventory

- Exact ledger inventory: ${baselineSites.length} sites
- Synchronous \`withWriteTx()\` sites: ${counts.get("withWriteTx") ?? 0}
- Synchronous \`withReadDb()\` sites: ${counts.get("withReadDb") ?? 0}
- Synchronous filesystem/process sites: ${filesystemProcessCount}
- Compile-visible legacy DB sites remaining: ${legacyDbAccess.total}
  - \`withWriteTx\`: ${legacyDbAccess.withWriteTx}
  - \`withReadDb\`: ${legacyDbAccess.withReadDb}

The 1,060-site inventory excludes test, benchmark, generated, and \`__tests__\` fixtures. The 230 synchronous writes and 346 synchronous reads remain transitional callers for the later migration phase. They are marked with \`@ts-expect-error LEGACY_SYNC_DB_ACCESS\`, so the compiler reports every remaining site without forcing this phase to migrate 576 database operations.

## Enforcement boundary

- Production imports of \`db-accessor-sync.ts\` are rejected by the CI import-boundary check.
- \`DbAccessor\` exports only asynchronous transaction and read primitives.
- \`db-accessor-sync.ts\` is the explicit compatibility surface for test/bootstrap-only code. Its module documentation records the pre-readiness bootstrap, CLI, and isolated-worker rationale.
- The ledger does not attempt alias tracking, call-site classification, or evasion detection. Those scanner rules were retired because the type boundary is the enforceable contract.

## Risk and follow-up

The remaining synchronous DB operations are still a known transitional risk. The next migration wave removes the 230 write and 346 read markers. Startup, recall, ingestion, and existing tests must continue to use the runtime implementation while their callers move to the async primitives.
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
}

if (import.meta.main) main();
