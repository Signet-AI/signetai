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
	readonly wholeLine?: boolean;
}

const TOOL_DIRECTIVE = /(?:@license\b|@preserve\b|biome-ignore|prettier-ignore)/i;
const TYPESCRIPT_DIRECTIVE =
	/(?:<reference\s|[@#]__(?:NO_SIDE_EFFECTS|PURE)__|@(?:jest|vitest)-environment|@jsx|@ts-(?:check|expect-error|ignore|nocheck)|c8\s+ignore|deno-lint-ignore|DYNAMIC_SITE_TOKEN|eslint-(?:disable|enable)|istanbul\s+ignore|sourceMappingURL|sourceURL|vite-ignore|webpack(?:Ignore|ChunkName))/i;
const PYTHON_DIRECTIVE =
	/(?:coding[:=][^\S\r\n]*[-\w.]+|fmt:\s*(?:off|on|skip)|mypy:|noqa|pragma:\s*no cover|pylint:|pyright:|ruff:|type:\s*ignore)/i;
const YAML_DIRECTIVE = /(?:actionlint|yaml-language-server|yamllint)/i;
const C_DIRECTIVE = /(?:clang-format|NOLINT)/i;
const ATTRIBUTED_DB_APIS = new Set([
	"checkpointWalAsync",
	"incrementalVacuumAsync",
	"vacuumConversionAsync",
	"withReadDb",
	"withReadDbAsync",
	"withWriteDbAsync",
	"withWriteTx",
	"withWriteTxAsync",
]);
const LEGACY_DB_APIS = new Set(["withReadDb", "withWriteTx"]);
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
	if (path === "web/marketing/public/redesign-home-mockup.html") return false;
	if (path === "platform/core/src/child-process.ts") return false;
	if (path.endsWith("/agent.yaml.template")) return true;
	if (SUPPORTED_EXTENSION.test(path)) return true;
	if (/^(?:Caddyfile|Dockerfile|_headers|_redirects)$/i.test(name)) return true;
	if (/^\.(?:dockerignore|gitignore|prettierignore)$/i.test(name)) return true;
	return /^\.githooks\/(?:commit-msg|pre-commit)$/.test(path);
}

function isPreservedComment(source: string, span: Span, path: string): boolean {
	const comment = source.slice(span.start, span.end);
	if ((span.start === 0 && comment.startsWith("#!")) || LEGAL_NOTICE.test(comment) || TOOL_DIRECTIVE.test(comment))
		return true;
	const name = path.slice(path.lastIndexOf("/") + 1);
	if (/\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/i.test(path) || /\.(?:astro|html)$/i.test(path)) {
		if (TYPESCRIPT_DIRECTIVE.test(comment)) return true;
	}
	if (/\.py$/i.test(path) && PYTHON_DIRECTIVE.test(comment)) return true;
	if (/\.(?:ya?ml)$/i.test(path) || path.endsWith("/agent.yaml.template")) {
		if (YAML_DIRECTIVE.test(comment)) return true;
	}
	if (/\.(?:c|cc|cpp|cs|h|hh|hpp)$/i.test(path) && C_DIRECTIVE.test(comment)) return true;
	if (/\.sh$/i.test(path) && /shellcheck/i.test(comment)) return true;
	if (/\.ps1$/i.test(path) && /^#requires\b/i.test(comment)) return true;
	if (/^Dockerfile$/i.test(name) && /^#\s*(?:check|escape|syntax)=/i.test(comment)) return true;
	return /^<!--\[if\b/i.test(comment);
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
		return { start: lineStart, end: newline < 0 ? lineEnd : lineEnd + 1, replacement: "", wholeLine: true };
	}
	if (after.trim().length !== 0) return span;
	let start = span.start;
	while (start > lineStart && (source[start - 1] === " " || source[start - 1] === "	")) start -= 1;
	let end = span.end;
	while (end < lineEnd && (source[end] === " " || source[end] === "	")) end += 1;
	return { start, end, replacement: "" };
}

function mergeWholeLineSpans(spans: readonly Span[]): readonly Span[] {
	const merged: Span[] = [];
	for (const span of [...spans].sort((left, right) => left.start - right.start)) {
		const previous = merged.at(-1);
		if (previous?.wholeLine === true && span.wholeLine === true && span.start <= previous.end) {
			merged[merged.length - 1] = {
				start: previous.start,
				end: Math.max(previous.end, span.end),
				replacement: "",
				wholeLine: true,
			};
			continue;
		}
		merged.push(span);
	}
	return merged;
}

function trimAdjacentBlankLine(source: string, span: Span): Span {
	if (span.wholeLine !== true) return span;
	if (span.start > 0) {
		const previousStart = source.lastIndexOf("\n", span.start - 2) + 1;
		const previousLine = source.slice(previousStart, span.start - 1).replace(/\r$/, "");
		if (previousLine.trim().length === 0) return { ...span, start: previousStart };
	}
	if (span.start !== 0) return span;
	if (source.startsWith("\r\n", span.end)) return { ...span, end: span.end + 2 };
	if (source[span.end] === "\n") return { ...span, end: span.end + 1 };
	return span;
}

export function scanTypeScriptCommentSpans(
	source: string,
	path: string,
): readonly { readonly end: number; readonly start: number }[] {
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

interface SourceLine {
	readonly end: number;
	readonly start: number;
	readonly text: string;
}

function sourceLines(source: string): readonly SourceLine[] {
	const lines: SourceLine[] = [];
	let start = 0;
	while (start < source.length) {
		const newline = source.indexOf("\n", start);
		const end = newline < 0 ? source.length : newline + 1;
		let contentEnd = newline < 0 ? source.length : newline;
		if (contentEnd > start && source[contentEnd - 1] === "\r") contentEnd -= 1;
		lines.push({ start, end, text: source.slice(start, contentEnd) });
		start = end;
	}
	return lines;
}

interface HashRegions {
	readonly protectedSpans: readonly Span[];
	readonly shellSpans: readonly Span[];
}

function yamlHashRegions(source: string): HashRegions {
	const lines = sourceLines(source);
	const protectedSpans: Span[] = [];
	const shellSpans: Span[] = [];
	const header = /^([ ]*)(?:-\s+)?(?:[^#\r\n]*?:\s*)?[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*(?:#.*)?$/;
	for (let index = 0; index < lines.length; index += 1) {
		const headerLine = lines[index];
		if (headerLine === undefined) continue;
		const match = header.exec(headerLine.text);
		if (match === null) continue;
		const headerIndent = (match[1] ?? "").length;
		let payloadEnd = index + 1;
		for (; payloadEnd < lines.length; payloadEnd += 1) {
			const line = lines[payloadEnd];
			if (line === undefined) break;
			if (line.text.trim().length === 0) continue;
			const indent = /^ */.exec(line.text)?.[0].length ?? 0;
			if (indent <= headerIndent) break;
		}
		const payloadLines = lines.slice(index + 1, payloadEnd);
		if (/^\s*(?:-\s+)?run\s*:/.test(headerLine.text)) {
			const nonblank = payloadLines.filter((line) => line.text.trim().length > 0);
			const contentIndent = Math.min(...nonblank.map((line) => /^ */.exec(line.text)?.[0].length ?? 0));
			const payloadStart = payloadLines[0]?.start;
			const payloadStop = payloadLines.at(-1)?.end;
			if (payloadStart !== undefined && payloadStop !== undefined && Number.isFinite(contentIndent)) {
				for (const span of shellHeredocSpans(source.slice(payloadStart, payloadStop), contentIndent)) {
					protectedSpans.push({ start: payloadStart + span.start, end: payloadStart + span.end });
				}
				shellSpans.push({ start: payloadStart, end: payloadStop });
			}
		} else {
			for (const line of payloadLines) protectedSpans.push({ start: line.start, end: line.end });
		}
		index = payloadEnd - 1;
	}
	return { protectedSpans, shellSpans };
}

interface Heredoc {
	readonly delimiter: string;
	readonly stripTabs: boolean;
}

function shellHeredocs(line: string): readonly Heredoc[] {
	const heredocs: Heredoc[] = [];
	let quote: '"' | "'" | "`" | undefined;
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index];
		if (quote !== undefined) {
			if (character === "\\" && quote !== "'") index += 1;
			else if (character === quote) quote = undefined;
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			quote = character;
			continue;
		}
		if (character === "\\") {
			index += 1;
			continue;
		}
		if (character === "#" && (index === 0 || /[\s;&|()]/.test(line[index - 1] ?? ""))) break;
		if (!line.startsWith("<<", index) || line[index - 1] === "<" || line[index + 2] === "<") continue;
		let cursor = index + 2;
		const stripTabs = line[cursor] === "-";
		if (stripTabs) cursor += 1;
		while (line[cursor] === " " || line[cursor] === "	") cursor += 1;
		let delimiter = "";
		const delimiterQuote = line[cursor];
		if (delimiterQuote === '"' || delimiterQuote === "'") {
			cursor += 1;
			while (cursor < line.length && line[cursor] !== delimiterQuote) {
				if (line[cursor] === "\\" && delimiterQuote === '"' && cursor + 1 < line.length) cursor += 1;
				delimiter += line[cursor];
				cursor += 1;
			}
			if (line[cursor] !== delimiterQuote) continue;
		} else {
			if (line[cursor] === "\\") cursor += 1;
			const start = cursor;
			while (cursor < line.length && !/[\s;&|()<>]/.test(line[cursor] ?? "")) cursor += 1;
			delimiter = line.slice(start, cursor);
		}
		if (delimiter.length === 0) continue;
		heredocs.push({ delimiter, stripTabs });
		index = cursor;
	}
	return heredocs;
}

function shellHeredocSpans(source: string, indent = 0): readonly Span[] {
	const spans: Span[] = [];
	const pending: Heredoc[] = [];
	for (const line of sourceLines(source)) {
		const text = line.text.startsWith(" ".repeat(indent)) ? line.text.slice(indent) : line.text;
		const heredoc = pending[0];
		if (heredoc !== undefined) {
			let candidate = text;
			if (heredoc.stripTabs) {
				let tabs = 0;
				while (candidate[tabs] === "	") tabs += 1;
				candidate = candidate.slice(tabs);
			}
			if (candidate === heredoc.delimiter) pending.shift();
			else spans.push({ start: line.start, end: line.end });
			continue;
		}
		pending.push(...shellHeredocs(text));
	}
	return spans;
}

function hashCommentSpans(source: string, path: string): readonly Span[] {
	const spans: Span[] = [];
	let quote: '"' | "'" | '"""' | "'''" | "`" | undefined;
	const python = /\.py$/i.test(path);
	const name = path.slice(path.lastIndexOf("/") + 1);
	const shellLike = /\.sh$/i.test(path) || /^(?:Caddyfile|Dockerfile)$/i.test(name) || /^\.githooks\//.test(path);
	const regions =
		/\.(?:ya?ml)$/i.test(path) || path.endsWith("/agent.yaml.template")
			? yamlHashRegions(source)
			: shellLike
				? { protectedSpans: shellHeredocSpans(source), shellSpans: [{ start: 0, end: source.length }] }
				: { protectedSpans: [], shellSpans: [] };
	let protectedIndex = 0;
	let shellIndex = 0;
	for (let index = 0; index < source.length; index += 1) {
		while (true) {
			const candidate = regions.protectedSpans[protectedIndex];
			if (candidate === undefined || candidate.end > index) break;
			protectedIndex += 1;
		}
		const protectedSpan = regions.protectedSpans[protectedIndex];
		if (protectedSpan !== undefined && protectedSpan.start <= index) {
			index = protectedSpan.end - 1;
			continue;
		}
		while (true) {
			const candidate = regions.shellSpans[shellIndex];
			if (candidate === undefined || candidate.end > index) break;
			shellIndex += 1;
		}
		const shellSpan = regions.shellSpans[shellIndex];
		const shell = shellSpan !== undefined && shellSpan.start <= index;
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
		if (!python && !/\s/.test(previous) && !(shell && /[;&|()]/.test(previous))) continue;
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
				scanTypeScriptCommentSpans(source.slice(frontmatter[0].length, match.index), "frontmatter.ts"),
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
					? scanTypeScriptCommentSpans(source.slice(start, end), "embedded.ts")
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

function rewriteDatabaseSiteTokens(source: string, path: string): string {
	const prefix = "platform/daemon/src/";
	if (!path.startsWith(prefix) || !/\.ts$/i.test(path)) return source;
	const relativePath = path.slice(prefix.length);
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const bindings = new Map<string, ts.Expression>();
	const replacements = new Map<string, { readonly end: number; readonly start: number; readonly value: string }>();
	const lineTokenPattern = new RegExp(`^${relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\d+$`);
	const queueReplacement = (token: ts.StringLiteralLike, value: string, priority: boolean): void => {
		const replacement = { start: token.getStart(file) + 1, end: token.end - 1, value };
		const key = `${replacement.start}:${replacement.end}`;
		if (priority || !replacements.has(key)) replacements.set(key, replacement);
	};
	const unwrap = (expression: ts.Expression): ts.Expression => {
		let current = expression;
		while (
			ts.isParenthesizedExpression(current) ||
			ts.isAsExpression(current) ||
			ts.isTypeAssertionExpression(current) ||
			ts.isSatisfiesExpression(current)
		) {
			current = current.expression;
		}
		return current;
	};
	const literal = (expression: ts.Expression): ts.StringLiteralLike | undefined => {
		const current = unwrap(expression);
		if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) return current;
		if (!ts.isIdentifier(current)) return undefined;
		const initializer = bindings.get(current.text);
		return initializer === undefined ? undefined : literal(initializer);
	};
	const replaceLiteral = (expression: ts.Expression, expected: string): void => {
		const token = literal(expression);
		if (token === undefined || !lineTokenPattern.test(token.text)) return;
		queueReplacement(token, expected, true);
	};
	const visit = (node: ts.Node): void => {
		if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && lineTokenPattern.test(node.text)) {
			const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
			queueReplacement(node, `${relativePath}:${line}`, false);
		}
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer !== undefined &&
			ts.isVariableDeclarationList(node.parent) &&
			(node.parent.flags & ts.NodeFlags.Const) !== 0
		) {
			bindings.set(node.name.text, node.initializer);
		}
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			const api = ts.isPropertyAccessExpression(callee)
				? callee.name.text
				: ts.isElementAccessExpression(callee) &&
						callee.argumentExpression !== undefined &&
						ts.isStringLiteralLike(callee.argumentExpression)
					? callee.argumentExpression.text
					: undefined;
			if (api !== undefined && ATTRIBUTED_DB_APIS.has(api)) {
				const position = ts.isPropertyAccessExpression(callee) ? callee.name.getStart(file) : callee.getStart(file);
				const line = file.getLineAndCharacterOfPosition(position).line + 1;
				const expected = `${relativePath}:${line}`;
				if (LEGACY_DB_APIS.has(api)) {
					const token = node.arguments[1];
					if (token !== undefined) replaceLiteral(token, expected);
				} else {
					const options =
						node.arguments[
							api === "withReadDbAsync" || api === "withWriteTxAsync" || api === "withWriteDbAsync" ? 1 : 0
						];
					if (options !== undefined) {
						const current = unwrap(options);
						if (ts.isStringLiteralLike(current) || ts.isIdentifier(current)) replaceLiteral(current, expected);
						if (ts.isObjectLiteralExpression(current)) {
							for (const property of current.properties) {
								if (!ts.isPropertyAssignment(property)) continue;
								const name = property.name;
								if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "siteToken") {
									replaceLiteral(property.initializer, expected);
								}
							}
						}
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	let output = source;
	for (const replacement of [...replacements.values()].sort((left, right) => right.start - left.start)) {
		output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
	}
	return output;
}

export function stripComments(source: string, path: string): StripResult {
	let spans: readonly Span[];
	if (/\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/i.test(path)) spans = scanTypeScriptCommentSpans(source, path);
	else if (/\.(?:ini|py|sh|toml|ya?ml)$/i.test(path) || path.endsWith("/agent.yaml.template"))
		spans = hashCommentSpans(source, path);
	else if (/\.(?:c|cc|cpp|cs|css|h|hh|hpp|jsonc|rs|sql)$/i.test(path)) spans = slashCommentSpans(source, path);
	else if (/\.(?:astro|html)$/i.test(path)) spans = astroCommentSpans(source);
	else if (/\.(?:plist|svg)$/i.test(path)) spans = xmlCommentSpans(source);
	else if (/\.ps1$/i.test(path)) spans = powerShellCommentSpans(source, path);
	else if (isCommentPurgePath(path)) spans = hashCommentSpans(source, path);
	else throw new Error(`Unsupported comment syntax: ${path}`);
	const removable = spans.filter((span) => !isPreservedComment(source, span, path));
	spans = mergeWholeLineSpans(removable.map((span) => normalizeCommentSpan(source, span))).map((span) =>
		trimAdjacentBlankLine(source, span),
	);
	const content = rewriteDatabaseSiteTokens(applySpans(source, spans), path);
	return { content, removed: removable.length };
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
