#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { scanTypeScriptCommentSpans } from "./strip-comments";

const ROOT = resolve(import.meta.dir, "..");
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
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
	"target",
	"test",
	"tests",
]);
const SPDX_HEADER = /^SPDX-License-Identifier:\s*[A-Za-z0-9.-]+$/;
const COPYRIGHT_HEADER = /^Copyright(?:\s+\(c\)|\s+©)?\s+\d{4}(?:-\d{4})?\s+\S.*$/;
const DYNAMIC_SITE_TOKEN = /^DYNAMIC_SITE_TOKEN$/;

export interface CommentSpan {
	readonly allowed: boolean;
	readonly endLine: number;
	readonly source: string;
	readonly startLine: number;
}

export interface CommentViolation extends CommentSpan {
	readonly path: string;
}

export type SourceReader = (path: string) => string | undefined;

interface DiffFile {
	readonly addedLines: ReadonlySet<number>;
	readonly path: string;
}

function extension(path: string): string {
	const index = path.lastIndexOf(".");
	return index === -1 ? "" : path.slice(index);
}

export function isProductionSourcePath(path: string): boolean {
	const normalized = path.replaceAll("\\", "/");
	if (!SOURCE_EXTENSIONS.has(extension(normalized))) return false;
	const parts = normalized.split("/");
	if (parts.some((part) => EXCLUDED_PARTS.has(part))) return false;
	const name = parts.at(-1) ?? "";
	return !/\.(?:test|spec)\.[^.]+$/.test(name);
}

function isAllowedComment(source: string): boolean {
	const lines = source
		.split("\n")
		.map((line) =>
			line
				.replace(/^\s*(?:\/\/+|\/\*+|\*)\s?/, "")
				.replace(/\s*\*\/\s*$/, "")
				.trim(),
		)
		.filter(Boolean);
	return (
		lines.length > 0 &&
		lines.every((line) => SPDX_HEADER.test(line) || COPYRIGHT_HEADER.test(line) || DYNAMIC_SITE_TOKEN.test(line))
	);
}

export function scanTypeScriptComments(path: string, source: string): readonly CommentSpan[] {
	const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
	const comments: CommentSpan[] = [];
	for (const { start, end } of scanTypeScriptCommentSpans(source, path)) {
		const startLine = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
		const endPosition = Math.max(start, end - 1);
		const endLine = sourceFile.getLineAndCharacterOfPosition(endPosition).line + 1;
		const text = source.slice(start, end);
		comments.push({ allowed: isAllowedComment(text), endLine, source: text, startLine });
	}
	return comments;
}

function parseDiff(diff: string): readonly DiffFile[] {
	const files: Array<{ path: string; addedLines: Set<number> }> = [];
	let file: { path: string; addedLines: Set<number> } | undefined;
	let newLine: number | undefined;
	let inHunk = false;
	for (const line of diff.replaceAll("\r\n", "\n").split("\n")) {
		if (line.startsWith("diff --git ")) {
			file = undefined;
			newLine = undefined;
			inHunk = false;
			continue;
		}
		if (!inHunk && line.startsWith("+++ ")) {
			const value = line.slice(4);
			if (value === "/dev/null") {
				file = undefined;
				newLine = undefined;
				continue;
			}
			const path = value.startsWith("b/") ? value.slice(2) : value;
			file = { addedLines: new Set(), path };
			files.push(file);
			newLine = undefined;
			continue;
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk !== null) {
			newLine = Number.parseInt(hunk[1] ?? "0", 10);
			inHunk = true;
			continue;
		}
		if (file === undefined || newLine === undefined) continue;
		if (line.startsWith("+")) {
			file.addedLines.add(newLine);
			newLine += 1;
			continue;
		}
		if (line.startsWith("-") || line.startsWith("\\")) continue;
		newLine += 1;
	}
	return files;
}

function intersects(lines: ReadonlySet<number>, start: number, end: number): boolean {
	for (let line = start; line <= end; line += 1) {
		if (lines.has(line)) return true;
	}
	return false;
}

export function findAddedProductionComments(diff: string, readSource: SourceReader): readonly CommentViolation[] {
	const violations: CommentViolation[] = [];
	for (const file of parseDiff(diff)) {
		if (!isProductionSourcePath(file.path)) continue;
		const source = readSource(file.path);
		if (source === undefined) continue;
		for (const comment of scanTypeScriptComments(file.path, source)) {
			if (comment.allowed || !intersects(file.addedLines, comment.startLine, comment.endLine)) continue;
			violations.push({ ...comment, path: file.path });
		}
	}
	return violations.sort((left, right) => left.path.localeCompare(right.path) || left.startLine - right.startLine);
}

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

function git(args: readonly string[]): string {
	const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: ROOT, stderr: "pipe", stdout: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(result.stderr).trim() || `git ${args.join(" ")} failed`);
	}
	return new TextDecoder().decode(result.stdout).trim();
}

function defaultBase(): string {
	try {
		return git(["merge-base", "origin/main", "HEAD"]);
	} catch {
		return "HEAD^";
	}
}

function main(): void {
	const base = argument("--base") ?? defaultBase();
	const head = argument("--head") ?? "HEAD";
	const diff = git(["diff", "--no-ext-diff", "--unified=0", "--diff-filter=ACMR", `${base}...${head}`, "--"]);
	const violations = findAddedProductionComments(diff, (path) => {
		try {
			return readFileSync(resolve(ROOT, path), "utf8");
		} catch {
			return undefined;
		}
	});
	if (violations.length === 0) {
		console.log("Production comment ratchet passed");
		return;
	}
	console.error(
		`Production comment ratchet found ${violations.length} newly added comment${violations.length === 1 ? "" : "s"}:`,
	);
	for (const violation of violations) {
		console.error(`\n${violation.path}:${violation.startLine}\n  ${violation.source.split("\n")[0]?.trim() ?? ""}`);
	}
	console.error("\nRemove the comment or use a narrow legal-header exception.");
	process.exitCode = 1;
}

if (import.meta.main) main();
