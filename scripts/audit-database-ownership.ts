#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "..");
const SOURCE_EXTENSIONS = [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"] as const;
const EXCLUDED_PARTS = new Set([
	".astro",
	".git",
	".svelte-kit",
	".wrangler",
	"__tests__",
	"build",
	"built",
	"coverage",
	"dist",
	"docs",
	"fixtures",
	"generated",
	"node_modules",
	"references",
	"scripts",
	"target",
	"test",
	"tests",
]);
const FORBIDDEN_MODULES = new Set(["better-sqlite3", "bun:sqlite", "node:sqlite"]);
const DATABASE_OWNERS = new Set([
	"memorybench/src/server/db/index.ts",
	"platform/core/src/database.ts",
	"platform/core/src/signet.ts",
	"platform/daemon/src/database-integrity-worker.ts",
	"platform/daemon/src/database-integrity.ts",
	"platform/daemon/src/db-accessor.ts",
	"platform/daemon/src/db-owner-worker.ts",
	"platform/daemon/src/db.ts",
	"surfaces/cli/src/sqlite.ts",
]);

export interface DatabaseSource {
	readonly content: string;
	readonly path: string;
}

export interface DatabaseOwnershipViolation {
	readonly line: number;
	readonly module: string;
	readonly path: string;
}

function extension(path: string): string {
	const index = path.lastIndexOf(".");
	return index === -1 ? "" : path.slice(index);
}

export function isDatabaseOwnershipSource(path: string): boolean {
	const normalized = path.replaceAll("\\", "/");
	if (!SOURCE_EXTENSIONS.includes(extension(normalized) as (typeof SOURCE_EXTENSIONS)[number])) return false;
	const parts = normalized.split("/");
	if (parts.some((part) => EXCLUDED_PARTS.has(part))) return false;
	const name = parts.at(-1) ?? "";
	return !/\.(?:bench|test|spec)\.[^.]+$/.test(name);
}

function staticModule(node: ts.Expression, bindings: ReadonlyMap<string, string>): string | undefined {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	if (ts.isIdentifier(node)) return bindings.get(node.text);
	return undefined;
}

function staticBindings(sourceFile: ts.SourceFile): ReadonlyMap<string, string> {
	const bindings = new Map<string, string>();
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
			const value = staticModule(node.initializer, bindings);
			if (value !== undefined) bindings.set(node.name.text, value);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return bindings;
}

function importHasRuntimeBinding(node: ts.ImportDeclaration): boolean {
	const clause = node.importClause;
	if (clause === undefined) return true;
	if (clause.isTypeOnly) return false;
	if (clause.name !== undefined) return true;
	const bindings = clause.namedBindings;
	if (bindings === undefined || ts.isNamespaceImport(bindings)) return true;
	return bindings.elements.some((element) => !element.isTypeOnly);
}

function importedModule(node: ts.Node, bindings: ReadonlyMap<string, string>): string | undefined {
	if (ts.isImportDeclaration(node)) {
		if (!importHasRuntimeBinding(node)) return undefined;
		return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
	}
	if (ts.isImportEqualsDeclaration(node)) {
		if (node.isTypeOnly || !ts.isExternalModuleReference(node.moduleReference)) return undefined;
		const expression = node.moduleReference.expression;
		return expression !== undefined && ts.isStringLiteral(expression) ? expression.text : undefined;
	}
	if (ts.isExportDeclaration(node)) {
		if (node.isTypeOnly || node.moduleSpecifier === undefined) return undefined;
		return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
	}
	if (!ts.isCallExpression(node) || node.arguments.length !== 1) return undefined;
	const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
	const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
	if (!isRequire && !isImport) return undefined;
	return staticModule(node.arguments[0] as ts.Expression, bindings);
}

export function auditDatabaseOwnership(sources: readonly DatabaseSource[]): readonly DatabaseOwnershipViolation[] {
	const violations: DatabaseOwnershipViolation[] = [];
	for (const source of sources) {
		const path = source.path.replaceAll("\\", "/");
		if (!isDatabaseOwnershipSource(path) || DATABASE_OWNERS.has(path)) continue;
		const sourceFile = ts.createSourceFile(path, source.content, ts.ScriptTarget.Latest, true);
		const bindings = staticBindings(sourceFile);
		const visit = (node: ts.Node): void => {
			const module = importedModule(node, bindings);
			if (module !== undefined && FORBIDDEN_MODULES.has(module)) {
				violations.push({
					line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
					module,
					path,
				});
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return violations.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}

function gitTrackedSources(): readonly DatabaseSource[] {
	const result = Bun.spawnSync({
		cmd: ["git", "ls-files", ...SOURCE_EXTENSIONS.map((value) => `*${value}`)],
		cwd: ROOT,
		stderr: "pipe",
		stdout: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr).trim() || "git ls-files failed");
	return new TextDecoder()
		.decode(result.stdout)
		.split("\n")
		.filter(Boolean)
		.map((path) => ({ content: readFileSync(resolve(ROOT, path), "utf8"), path }));
}

function main(): void {
	const violations = auditDatabaseOwnership(gitTrackedSources());
	if (violations.length === 0) {
		console.log("Database ownership audit passed");
		return;
	}
	console.error(`Database ownership audit found ${violations.length} violation${violations.length === 1 ? "" : "s"}:`);
	for (const violation of violations) {
		console.error(`${violation.path}:${violation.line} imports ${violation.module}`);
	}
	console.error("Direct SQLite access is restricted to exact database-owner modules.");
	process.exitCode = 1;
}

if (import.meta.main) main();
