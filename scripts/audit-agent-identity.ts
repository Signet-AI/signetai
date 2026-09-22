#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "..");
const SOURCE_EXTENSIONS = [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".py", ".ts", ".tsx"] as const;
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
const PYTHON_PROVENANCE_ASSIGNMENT = /\b(?:[a-z_]*harness[a-z_]*|who)\b\s*(?::[^=,)]*)?=/i;
const PYTHON_IDENTITY_COMPARISON =
	/(?:==|!=)\s*["']hermes-agent["']|["']hermes-agent["']\s*(?:==|!=)|\b(?:not\s+)?in\s*\([^)]*["']hermes-agent["']/;

export interface AgentIdentitySource {
	readonly content: string;
	readonly path: string;
}

export interface AgentIdentityViolation {
	readonly line: number;
	readonly path: string;
}

function extension(path: string): string {
	const index = path.lastIndexOf(".");
	return index === -1 ? "" : path.slice(index);
}

export function isAgentIdentitySource(path: string): boolean {
	const normalized = path.replaceAll("\\", "/");
	if (!SOURCE_EXTENSIONS.includes(extension(normalized) as (typeof SOURCE_EXTENSIONS)[number])) return false;
	const parts = normalized.split("/");
	if (parts.some((part) => EXCLUDED_PARTS.has(part))) return false;
	const name = parts.at(-1) ?? "";
	return !/\.(?:bench|test|spec)\.[^.]+$/.test(name);
}

function unwrapExpression(node: ts.Expression): ts.Expression {
	let current = node;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isTypeAssertionExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isNonNullExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function isHarnessLiteral(node: ts.Expression): boolean {
	const unwrapped = unwrapExpression(node);
	return (
		(ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) &&
		unwrapped.text === "hermes-agent"
	);
}

function isHarnessProvenanceContext(node: ts.Node, sourceFile: ts.SourceFile): boolean {
	for (let current = node.parent; current !== undefined; current = current.parent) {
		if (ts.isVariableDeclaration(current) && /harness|\bwho\b/i.test(current.name.getText(sourceFile))) return true;
		if (ts.isPropertyAssignment(current) && /harness|\bwho\b/i.test(current.name.getText(sourceFile))) return true;
		if (ts.isCallExpression(current) && /harness|\bwho\b/i.test(current.expression.getText(sourceFile))) return true;
		if (
			(ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isMethodDeclaration(current)) &&
			current.name !== undefined &&
			/harness|\bwho\b/i.test(current.name.getText(sourceFile))
		) {
			return true;
		}
		if (ts.isStatement(current)) break;
	}
	return false;
}

function auditTypeScript(source: AgentIdentitySource): readonly AgentIdentityViolation[] {
	const sourceFile = ts.createSourceFile(source.path, source.content, ts.ScriptTarget.Latest, true);
	const violations: AgentIdentityViolation[] = [];
	const visit = (node: ts.Node): void => {
		const binaryFallback =
			ts.isBinaryExpression(node) &&
			(node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
				node.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
			isHarnessLiteral(node.right) &&
			!isHarnessProvenanceContext(node, sourceFile);
		const conditionalFallback =
			ts.isConditionalExpression(node) &&
			(isHarnessLiteral(node.whenTrue) || isHarnessLiteral(node.whenFalse)) &&
			!isHarnessProvenanceContext(node, sourceFile);
		if (binaryFallback || conditionalFallback) {
			violations.push({
				line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
				path: source.path,
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return violations;
}

function hasExactPythonHarnessLiteral(line: string): boolean {
	for (let index = 0; index < line.length; index += 1) {
		const quote = line[index];
		if (quote !== '"' && quote !== "'") continue;
		const triple = line.slice(index, index + 3) === quote.repeat(3);
		const width = triple ? 3 : 1;
		const start = index + width;
		let end = start;
		while (end < line.length) {
			if (line[end] === "\\") {
				end += 2;
				continue;
			}
			if (line.slice(end, end + width) === quote.repeat(width)) break;
			end += 1;
		}
		if (end >= line.length) return false;
		if (line.slice(start, end) === "hermes-agent") return true;
		index = end + width - 1;
	}
	return false;
}

function auditPython(source: AgentIdentitySource): readonly AgentIdentityViolation[] {
	const violations: AgentIdentityViolation[] = [];
	for (const [index, line] of source.content.split(/\r?\n/).entries()) {
		if (!hasExactPythonHarnessLiteral(line)) continue;
		if (PYTHON_PROVENANCE_ASSIGNMENT.test(line) || PYTHON_IDENTITY_COMPARISON.test(line)) continue;
		violations.push({ line: index + 1, path: source.path });
	}
	return violations;
}

export function auditAgentIdentity(sources: readonly AgentIdentitySource[]): readonly AgentIdentityViolation[] {
	const violations: AgentIdentityViolation[] = [];
	for (const source of sources) {
		const path = source.path.replaceAll("\\", "/");
		if (!isAgentIdentitySource(path)) continue;
		const normalized = { content: source.content, path };
		violations.push(...(path.endsWith(".py") ? auditPython(normalized) : auditTypeScript(normalized)));
	}
	return violations.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}

function gitTrackedSources(): readonly AgentIdentitySource[] {
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
	const violations = auditAgentIdentity(gitTrackedSources());
	if (violations.length === 0) {
		console.log("Agent identity audit passed");
		return;
	}
	console.error(`Agent identity audit found ${violations.length} violation${violations.length === 1 ? "" : "s"}:`);
	for (const violation of violations) console.error(`${violation.path}:${violation.line}`);
	console.error("Harness identity cannot be used as an implicit agent identity.");
	process.exitCode = 1;
}

if (import.meta.main) main();
