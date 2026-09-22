#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

export interface StripResult {
	readonly content: string;
	readonly removed: number;
}

interface Span {
	readonly end: number;
	readonly replacement?: string;
	readonly start: number;
}

const SEMANTIC_DIRECTIVE =
	/(?:^#!|^#\s*(?:check|escape|requires|syntax)\b|<reference\s|[@#]__(?:NO_SIDE_EFFECTS|PURE)__|@(?:jest|vitest)-environment|@license\b|@preserve\b|@ts-(?:check|expect-error|ignore|nocheck)|actionlint|biome-ignore|c8\s+ignore|clang-format|coding[:=]|deno-lint-ignore|eslint-(?:disable|enable)|fmt:|istanbul\s+ignore|mypy:|NOLINT|noqa|pragma:\s*no cover|prettier-ignore|pylint|pyright|ruff:|shellcheck|sourceMappingURL|sourceURL|type:\s*ignore|webpack(?:Ignore|ChunkName)|vite-ignore|yaml-language-server|yamllint|@jsx(?:ImportSource)?\b)/i;
const LEGAL_NOTICE = /(?:SPDX-License-Identifier:|Copyright(?:\s+\(c\)|\s+©)?\s+\d{4})/i;
const SUPPORTED_EXTENSION =
	/\.(?:astro|c|cc|cjs|cpp|cs|css|cts|h|hh|hpp|html|ini|js|jsx|jsonc|mjs|mts|plist|ps1|py|rs|sh|sql|toml|ts|tsx|ya?ml)$/i;

export function isCommentPurgePath(input: string): boolean {
	const path = input.replaceAll("\\", "/");
	const name = path.slice(path.lastIndexOf("/") + 1);
	if (/(?:^|\/)(?:assets|dist|docs|generated|node_modules|references|vendor)(?:\/|$)/i.test(path)) return false;
	if (/(?:^|[._-])generated(?:[._-]|$)/i.test(name)) return false;
	if (/(?:^|\/)(?:license|notice|third_party_licenses\.md)$/i.test(path)) return false;
	if (/\.lock$/i.test(path) || /(?:^|\/)scripts\/vector-repair-compiled-fixture\.ts$/i.test(path)) return false;
	if (path.endsWith("/agent.yaml.template")) return true;
	if (SUPPORTED_EXTENSION.test(path)) return true;
	if (/^(?:Caddyfile|Dockerfile|_headers|_redirects)$/i.test(name)) return true;
	if (/^\.(?:dockerignore|gitignore|prettierignore)$/i.test(name)) return true;
	return /^\.githooks\/(?:commit-msg|pre-commit)$/.test(path);
}

function isPreservedComment(source: string, span: Span): boolean {
	const comment = source.slice(span.start, span.end);
	return SEMANTIC_DIRECTIVE.test(comment) || LEGAL_NOTICE.test(comment);
}

function replacementFor(source: string, span: Span): string {
	if (span.replacement !== undefined) return span.replacement;
	const text = source.slice(span.start, span.end);
	const lineBreaks = text.match(/\r\n|\r|\n/g);
	if (lineBreaks !== null) return lineBreaks.join("");
	const before = source[span.start - 1] ?? "";
	const after = source[span.end] ?? "";
	return /[\p{ID_Continue}$]/u.test(before) && /[\p{ID_Continue}$]/u.test(after) ? " " : "";
}

function normalizeCommentSpan(source: string, span: Span): Span {
	const lineStart = source.lastIndexOf("\n", span.start - 1) + 1;
	const newline = source.indexOf("\n", span.end);
	const lineEnd = newline < 0 ? source.length : newline;
	const before = source.slice(lineStart, span.start);
	const after = source.slice(span.end, lineEnd);
	if (before.trim().length === 0 && after.trim().length === 0) {
		return { start: lineStart, end: newline < 0 ? lineEnd : lineEnd + 1, replacement: "" };
	}
	if (after.trim().length !== 0) return span;
	let start = span.start;
	while (start > lineStart && (source[start - 1] === " " || source[start - 1] === "	")) start -= 1;
	let end = span.end;
	while (end < lineEnd && (source[end] === " " || source[end] === "	")) end += 1;
	return { start, end, replacement: "" };
}

function typeScriptCommentSpans(source: string, path: string): readonly Span[] {
	let kind = ts.ScriptKind.TS;
	if (/\.tsx$/i.test(path)) kind = ts.ScriptKind.TSX;
	if (/\.jsx$/i.test(path)) kind = ts.ScriptKind.JSX;
	if (/\.(?:cjs|js|mjs)$/i.test(path)) kind = ts.ScriptKind.JS;
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
	const spans = new Map<string, Span>();
	const protectedSpans: Span[] = [];
	const collect = (ranges: readonly ts.CommentRange[] | undefined): void => {
		for (const range of ranges ?? []) spans.set(`${range.pos}:${range.end}`, { start: range.pos, end: range.end });
	};
	const visit = (node: ts.Node): void => {
		if (
			node.kind === ts.SyntaxKind.StringLiteral ||
			node.kind === ts.SyntaxKind.RegularExpressionLiteral ||
			node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
			node.kind === ts.SyntaxKind.TemplateHead ||
			node.kind === ts.SyntaxKind.TemplateMiddle ||
			node.kind === ts.SyntaxKind.TemplateTail ||
			node.kind === ts.SyntaxKind.JsxText
		) {
			protectedSpans.push({ start: node.getStart(file), end: node.end });
		}
		collect(ts.getLeadingCommentRanges(source, node.pos));
		collect(ts.getTrailingCommentRanges(source, node.end));
		for (const child of node.getChildren(file)) visit(child);
	};
	visit(file);
	return [...spans.values()]
		.filter(
			(span) =>
				!protectedSpans.some((protectedSpan) => span.start < protectedSpan.end && span.end > protectedSpan.start),
		)
		.sort((left, right) => left.start - right.start);
}

function hashCommentSpans(source: string, path: string): readonly Span[] {
	const spans: Span[] = [];
	let quote: '"' | "'" | '"""' | "'''" | "`" | undefined;
	const python = /\.py$/i.test(path);
	for (let index = 0; index < source.length; index += 1) {
		if (quote !== undefined) {
			if (quote.length === 3 && source.startsWith(quote, index)) {
				index += 2;
				quote = undefined;
				continue;
			}
			if (source[index] === "\\") {
				index += 1;
				continue;
			}
			if (quote.length === 1 && source[index] === quote) quote = undefined;
			continue;
		}
		if (source.startsWith('"""', index) || source.startsWith("'''", index)) {
			quote = source.startsWith('"""', index) ? '"""' : "'''";
			index += 2;
			continue;
		}
		const character = source[index];
		if (character === '"' || character === "'" || character === "`") {
			quote = character;
			continue;
		}
		if (character !== "#") continue;
		const previous = source[index - 1] ?? "\n";
		if (!python && !/\s/.test(previous)) continue;
		let end = index;
		while (end < source.length && source[end] !== "\n" && source[end] !== "\r") end += 1;
		spans.push({ start: index, end });
		index = end - 1;
	}
	return spans;
}

function isRustLifetime(source: string, index: number): boolean {
	const match = /^'[A-Za-z_]\w*/.exec(source.slice(index));
	return match !== null && source[index + match[0].length] !== "'";
}

function slashCommentSpans(source: string, path: string): readonly Span[] {
	const spans: Span[] = [];
	const rust = /\.rs$/i.test(path);
	const sql = /\.sql$/i.test(path);
	const lineSlash = !/\.(?:css|sql)$/i.test(path);
	let quote: '"' | "'" | "`" | undefined;
	for (let index = 0; index < source.length; index += 1) {
		if (quote !== undefined) {
			if (source[index] === "\\") {
				index += 1;
				continue;
			}
			if (source[index] === quote) quote = undefined;
			continue;
		}
		if (rust) {
			const raw = /^r(#+)?"/.exec(source.slice(index));
			if (raw !== null) {
				const marker = `"${raw[1] ?? ""}`;
				const end = source.indexOf(marker, index + raw[0].length);
				if (end >= 0) index = end + marker.length - 1;
				continue;
			}
		}
		if (!sql) {
			const raw = /^R"([^()\\\s]{0,16})\(/.exec(source.slice(index));
			if (raw !== null) {
				const marker = `)${raw[1]}"`;
				const end = source.indexOf(marker, index + raw[0].length);
				if (end >= 0) index = end + marker.length - 1;
				continue;
			}
		}
		if (sql && source[index] === "$") {
			const dollar = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(source.slice(index));
			if (dollar !== null) {
				const end = source.indexOf(dollar[0], index + dollar[0].length);
				if (end >= 0) index = end + dollar[0].length - 1;
				continue;
			}
		}
		const character = source[index];
		if (character === '"' || character === "`" || (character === "'" && !(rust && isRustLifetime(source, index)))) {
			quote = character;
			continue;
		}
		const lineComment = (lineSlash && source.startsWith("//", index)) || (sql && source.startsWith("--", index));
		if (lineComment) {
			let end = index;
			while (end < source.length && source[end] !== "\n" && source[end] !== "\r") end += 1;
			spans.push({ start: index, end });
			index = end - 1;
			continue;
		}
		if (!source.startsWith("/*", index)) continue;
		const close = source.indexOf("*/", index + 2);
		const end = close < 0 ? source.length : close + 2;
		spans.push({ start: index, end });
		index = end - 1;
	}
	return spans;
}

function astroCommentSpans(source: string): readonly Span[] {
	const spans: Span[] = [];
	const embedded: Span[] = [];
	const addEmbedded = (start: number, end: number, comments: readonly Span[]): void => {
		embedded.push({ start, end });
		for (const comment of comments) spans.push({ start: start + comment.start, end: start + comment.end });
	};
	const frontmatter = /^(?:\uFEFF)?---[^\S\r\n]*\r?\n/.exec(source);
	if (frontmatter !== null) {
		const closing = /^---[^\S\r\n]*\r?$/gm;
		closing.lastIndex = frontmatter[0].length;
		const match = closing.exec(source);
		if (match !== null) {
			addEmbedded(
				frontmatter[0].length,
				match.index,
				typeScriptCommentSpans(source.slice(frontmatter[0].length, match.index), "frontmatter.ts"),
			);
		}
	}
	const collectTag = (tag: "script" | "style"): void => {
		const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi");
		for (const match of source.matchAll(pattern)) {
			const openEnd = match[0].indexOf(">");
			if (match.index === undefined || openEnd < 0) continue;
			const start = match.index + openEnd + 1;
			const end = start + (match[1]?.length ?? 0);
			const comments =
				tag === "script"
					? typeScriptCommentSpans(source.slice(start, end), "embedded.ts")
					: slashCommentSpans(source.slice(start, end), "embedded.css");
			addEmbedded(start, end, comments);
		}
	};
	collectTag("script");
	collectTag("style");
	const insideEmbedded = (index: number): boolean => embedded.some(({ start, end }) => index >= start && index < end);
	for (const match of source.matchAll(/<!--[\s\S]*?-->/g)) {
		if (match.index !== undefined && !insideEmbedded(match.index))
			spans.push({ start: match.index, end: match.index + match[0].length });
	}
	for (const match of source.matchAll(/\/\*[\s\S]*?\*\//g)) {
		if (match.index !== undefined && !insideEmbedded(match.index))
			spans.push({ start: match.index, end: match.index + match[0].length });
	}
	return spans.sort((left, right) => left.start - right.start);
}

function xmlCommentSpans(source: string): readonly Span[] {
	const spans: Span[] = [];
	for (const match of source.matchAll(/<!--[\s\S]*?-->/g)) {
		if (match.index !== undefined) spans.push({ start: match.index, end: match.index + match[0].length });
	}
	return spans;
}

function powerShellCommentSpans(source: string, path: string): readonly Span[] {
	const blocks: Span[] = [];
	for (const match of source.matchAll(/<#[\s\S]*?#>/g)) {
		if (match.index !== undefined) blocks.push({ start: match.index, end: match.index + match[0].length });
	}
	const lines = hashCommentSpans(source, path).filter(
		(line) => !blocks.some((block) => line.start >= block.start && line.start < block.end),
	);
	return [...blocks, ...lines].sort((left, right) => left.start - right.start);
}

function applySpans(source: string, spans: readonly Span[]): string {
	let content = "";
	let cursor = 0;
	for (const span of spans) {
		content += source.slice(cursor, span.start);
		content += replacementFor(source, span);
		cursor = span.end;
	}
	return content + source.slice(cursor);
}

export function stripComments(source: string, path: string): StripResult {
	let spans: readonly Span[];
	if (/\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/i.test(path)) spans = typeScriptCommentSpans(source, path);
	else if (/\.(?:ini|py|sh|toml|ya?ml)$/i.test(path) || path.endsWith("/agent.yaml.template"))
		spans = hashCommentSpans(source, path);
	else if (/\.(?:c|cc|cpp|cs|css|h|hh|hpp|jsonc|rs|sql)$/i.test(path)) spans = slashCommentSpans(source, path);
	else if (/\.(?:astro|html)$/i.test(path)) spans = astroCommentSpans(source);
	else if (/\.(?:plist|svg)$/i.test(path)) spans = xmlCommentSpans(source);
	else if (/\.ps1$/i.test(path)) spans = powerShellCommentSpans(source, path);
	else if (isCommentPurgePath(path)) spans = hashCommentSpans(source, path);
	else throw new Error(`Unsupported comment syntax: ${path}`);
	spans = spans.filter((span) => !isPreservedComment(source, span)).map((span) => normalizeCommentSpan(source, span));
	return { content: applySpans(source, spans), removed: spans.length };
}

type Mode = "check" | "write";

function trackedFiles(root: string): readonly string[] {
	const result = Bun.spawnSync({ cmd: ["git", "ls-files", "-z"], cwd: root });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "git ls-files failed");
	return result.stdout
		.toString()
		.split("\0")
		.filter((path) => path.length > 0)
		.sort();
}

export function runCommentPurge(mode: Mode, root = process.cwd()): number {
	const changed: { readonly path: string; readonly removed: number }[] = [];
	for (const path of trackedFiles(root)) {
		if (!isCommentPurgePath(path)) continue;
		const absolute = resolve(root, path);
		const source = readFileSync(absolute, "utf8");
		if (source.includes("\0")) throw new Error(`Refusing binary file: ${path}`);
		const result = stripComments(source, path);
		if (result.content === source) continue;
		changed.push({ path, removed: result.removed });
		if (mode === "write") writeFileSync(absolute, result.content);
	}
	for (const file of changed) console.log(`${file.path}: ${file.removed} comment${file.removed === 1 ? "" : "s"}`);
	const comments = changed.reduce((sum, file) => sum + file.removed, 0);
	if (mode === "check") {
		if (changed.length === 0) {
			console.log("Comment purge is current");
			return 0;
		}
		console.log(`${changed.length} file${changed.length === 1 ? "" : "s"} would change (${comments} comments)`);
		return 1;
	}
	console.log(`${changed.length} file${changed.length === 1 ? "" : "s"} changed (${comments} comments)`);
	return 0;
}

if (import.meta.main) {
	const argument = process.argv[2];
	if (argument !== "--check" && argument !== "--write") {
		console.error("Usage: bun scripts/strip-comments.ts --check|--write");
		process.exitCode = 2;
	} else {
		const mode: Mode = argument === "--check" ? "check" : "write";
		process.exitCode = runCommentPurge(mode);
	}
}
