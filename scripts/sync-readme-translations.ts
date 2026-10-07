#!/usr/bin/env bun

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SOURCE = "README.md";
const MODEL = "zai/glm-5.3-flash";
const MAX_ATTEMPTS = 2;
const PI_TIMEOUT_MS = 10 * 60 * 1000;
const MARKER = /^<!-- readme-sync source=README\.md blob=([0-9a-f]{40}) [^\n]*-->\n/;

export interface Locale {
	readonly code: string;
	readonly file: string;
	readonly label: string;
	readonly language: string;
	readonly note: string;
	readonly style: string;
}

export const LOCALES: readonly Locale[] = [
	{
		code: "de",
		file: "README.de.md",
		label: "Deutsch",
		language: "German",
		note: "Diese Übersetzung wurde automatisch erstellt. Bei Abweichungen gilt die [englische Version](README.md).",
		style: "Address the reader informally with du, as German open-source developer documentation usually does.",
	},
	{
		code: "ko",
		file: "README.ko.md",
		label: "한국어",
		language: "Korean",
		note: "이 문서는 자동 번역본입니다. 내용이 다를 경우 [영어 원문](README.md)이 우선합니다.",
		style: "Use the polite formal register (합니다체) common in Korean technical documentation.",
	},
	{
		code: "zh-CN",
		file: "README.zh-CN.md",
		label: "简体中文",
		language: "Simplified Chinese",
		note: "本文档为自动翻译版本。如有出入，以[英文原版](README.md)为准。",
		style: "Write in Simplified Chinese as used in mainland China. Use full-width Chinese punctuation in prose.",
	},
	{
		code: "ja",
		file: "README.ja.md",
		label: "日本語",
		language: "Japanese",
		note: "このドキュメントは自動翻訳です。内容に相違がある場合は[英語版](README.md)が優先されます。",
		style: "Use the polite です/ます style common in Japanese technical documentation.",
	},
];

export const SWITCHER = ["[English](README.md)", ...LOCALES.map((locale) => `[${locale.label}](${locale.file})`)].join(
	" · ",
);

export function noteLine(locale: Locale): string {
	return `<sub>${locale.note}</sub>`;
}

function markerLine(blob: string): string {
	return `<!-- readme-sync source=README.md blob=${blob} Generated from README.md by scripts/sync-readme-translations.ts. Manual fixes are kept on later syncs. -->\n`;
}

export function splitTranslation(file: string, locale: Locale): { blob: string | null; body: string } {
	const match = MARKER.exec(file);
	const withoutMarker = match ? file.slice(match[0].length) : file;
	const body = withoutMarker
		.split("\n")
		.filter(
			(line, index, lines) => line !== noteLine(locale) && !(line === "" && lines[index - 1] === noteLine(locale)),
		)
		.join("\n");
	return { blob: match?.[1] ?? null, body };
}

export function assembleTranslation(body: string, locale: Locale, blob: string): string {
	const lines = body.split("\n");
	const index = lines.indexOf(SWITCHER);
	lines.splice(index + 1, 0, "", noteLine(locale));
	return `${markerLine(blob)}${lines.join("\n")}`;
}

function codeBlocks(markdown: string): string[] {
	const blocks: string[] = [];
	let current: string[] | null = null;
	for (const line of markdown.split("\n")) {
		if (line.startsWith("```")) {
			if (current) {
				blocks.push(current.join("\n"));
				current = null;
			} else {
				current = [line];
			}
			continue;
		}
		current?.push(line);
	}
	return blocks;
}

function prose(markdown: string): string {
	return markdown.replace(/^```[^\n]*\n[\s\S]*?^```$/gm, "");
}

function headings(markdown: string): string[] {
	return prose(markdown)
		.split("\n")
		.filter((line) => /^#{1,6} /.test(line));
}

export function githubSlug(heading: string): string {
	return heading
		.replace(/^#{1,6} /, "")
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
		.replace(/\s/g, "-");
}

function anchors(markdown: string): Set<string> {
	const seen = new Map<string, number>();
	const result = new Set<string>();
	for (const heading of headings(markdown)) {
		const slug = githubSlug(heading);
		const count = seen.get(slug) ?? 0;
		seen.set(slug, count + 1);
		result.add(count === 0 ? slug : `${slug}-${count}`);
	}
	return result;
}

function targets(markdown: string): string[] {
	const text = prose(markdown);
	const found = [
		...[...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]),
		...[...text.matchAll(/\b(?:href|src|srcset)="([^"]+)"/g)].map((match) => match[1]),
	];
	return found.filter((target): target is string => target !== undefined);
}

function decodeFragment(fragment: string): string {
	try {
		return decodeURIComponent(fragment.slice(1));
	} catch {
		return fragment.slice(1);
	}
}

export function validateTranslation(english: string, translated: string): string[] {
	const errors: string[] = [];
	const switchers = translated.split("\n").filter((line) => line === SWITCHER).length;
	if (switchers !== 1) errors.push(`The language switcher line must appear exactly once, unchanged: ${SWITCHER}`);

	const sourceBlocks = codeBlocks(english);
	const translatedBlocks = codeBlocks(translated);
	if (sourceBlocks.length !== translatedBlocks.length) {
		errors.push(`Expected ${sourceBlocks.length} code blocks, found ${translatedBlocks.length}.`);
	} else {
		sourceBlocks.forEach((block, index) => {
			if (translatedBlocks[index] !== block) errors.push(`Code block ${index + 1} must be copied unchanged.`);
		});
	}

	const sourceHeadings = headings(english).map((line) => line.split(" ")[0]);
	const translatedHeadings = headings(translated).map((line) => line.split(" ")[0]);
	if (sourceHeadings.join(",") !== translatedHeadings.join(",")) {
		errors.push("Headings must keep the same count, order, and levels as the English source.");
	}

	const sourceTargets = targets(english);
	const translatedTargets = targets(translated);
	const sourceExternal = sourceTargets.filter((target) => !target.startsWith("#")).sort();
	const translatedExternal = translatedTargets.filter((target) => !target.startsWith("#")).sort();
	if (sourceExternal.join("\n") !== translatedExternal.join("\n")) {
		for (const target of new Set(sourceExternal.filter((item) => !translatedExternal.includes(item)))) {
			errors.push(`Link or image target is missing or changed: ${target}`);
		}
		for (const target of new Set(translatedExternal.filter((item) => !sourceExternal.includes(item)))) {
			errors.push(`Link or image target does not exist in the English source: ${target}`);
		}
		errors.push("Links and images must match the English source, including how many times each appears.");
	}

	const sourceFragments = sourceTargets.filter((target) => target.startsWith("#"));
	const translatedFragments = translatedTargets.filter((target) => target.startsWith("#"));
	if (sourceFragments.length !== translatedFragments.length) {
		errors.push(`Expected ${sourceFragments.length} in-page links, found ${translatedFragments.length}.`);
	}
	const valid = anchors(translated);
	for (const fragment of translatedFragments) {
		if (!valid.has(decodeFragment(fragment))) {
			errors.push(
				`In-page link ${fragment} does not match any translated heading. GitHub builds anchors by lowercasing the heading, removing punctuation, and replacing spaces with hyphens.`,
			);
		}
	}
	return errors;
}

export function stripFence(output: string): string {
	const trimmed = output.trim();
	const fenced = /^```(?:markdown|md)?\n([\s\S]*)\n```$/.exec(trimmed);
	return `${(fenced?.[1] ?? trimmed).trim()}\n`;
}

function systemPrompt(locale: Locale): string {
	return [
		`You translate the README of Signet, an open-source memory layer for AI agents, from English into ${locale.language}.`,
		"Output only the complete translated Markdown document: no preamble, no commentary, no surrounding code fence.",
		"Keep every Markdown and HTML structure, table, list, blank line between blocks, and the order of sections exactly as in the English source.",
		"Copy fenced code blocks and inline code unchanged, including comments inside code blocks.",
		"Copy every URL, file path, image source, and HTML attribute unchanged, except that alt text may be translated.",
		"Keep these in English: Signet, Dreaming, MemoryBench, LongMemEval, product, company, harness, and platform names, CLI commands, configuration keys, and environment variables.",
		"Translate heading text. When a link points to a heading in this document (#...), rewrite the fragment to match the translated heading the way GitHub builds anchors: lowercase, remove punctuation, replace spaces with hyphens.",
		`Keep this language switcher line exactly as it is: ${SWITCHER}`,
		"Write natural, fluent technical prose that a native-speaking developer would write. Do not translate word for word.",
		locale.style,
	].join("\n");
}

function userPrompt(english: string, previous: { english: string; translation: string } | null): string {
	if (!previous) return `Translate this README:\n\n<english>\n${english}</english>`;
	return [
		"The English README changed. Update the existing translation so it matches the current English README.",
		"Change only the parts that correspond to changes between the previous and current English text. Keep every other line of the existing translation exactly as it is.",
		"Return the complete updated translation.",
		"",
		`<previous_english>\n${previous.english}</previous_english>`,
		"",
		`<current_english>\n${english}</current_english>`,
		"",
		`<existing_translation>\n${previous.translation}</existing_translation>`,
	].join("\n");
}

function runPi(system: string, prompt: string): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(
			"pi",
			[
				"--print",
				"--model",
				MODEL,
				"--no-tools",
				"--no-session",
				"--no-context-files",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-approve",
				"--system-prompt",
				system,
			],
			{ cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], timeout: PI_TIMEOUT_MS },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (code === 0) resolvePromise(stdout);
			else reject(new Error(`pi exited with ${signal ?? `code ${code}`}: ${stderr.trim().slice(-2000)}`));
		});
		child.stdin.end(prompt);
	});
}

function git(args: string[], input?: string): string {
	return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", input }).trim();
}

function readBlob(blob: string): string | null {
	try {
		return execFileSync("git", ["cat-file", "blob", blob], {
			cwd: ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
}

async function translate(locale: Locale, english: string, blob: string, full: boolean): Promise<string> {
	const path = join(ROOT, locale.file);
	const existing = existsSync(path) ? splitTranslation(readFileSync(path, "utf8"), locale) : null;
	if (!full && existing?.blob === blob) return "current";
	const previousEnglish = !full && existing?.blob ? readBlob(existing.blob) : null;
	const previous = existing && previousEnglish ? { english: previousEnglish, translation: existing.body } : null;

	let errors: string[] = [];
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const retry =
			errors.length === 0
				? ""
				: `\n\nYour previous output failed these checks. Produce the full document again and fix them:\n${errors.map((error) => `- ${error}`).join("\n")}`;
		const output = stripFence(await runPi(systemPrompt(locale), `${userPrompt(english, previous)}${retry}`));
		errors = validateTranslation(english, output);
		if (errors.length === 0) {
			writeFileSync(path, assembleTranslation(output, locale, blob));
			return previous ? "updated" : "translated";
		}
	}
	throw new Error(`${locale.file} failed validation after ${MAX_ATTEMPTS} attempts:\n${errors.join("\n")}`);
}

function check(english: string): number {
	const failures: string[] = [];
	if (!english.split("\n").includes(SWITCHER))
		failures.push(`${SOURCE} must contain the language switcher: ${SWITCHER}`);
	const blob = git(["hash-object", "--stdin"], english);
	for (const locale of LOCALES) {
		const path = join(ROOT, locale.file);
		if (!existsSync(path)) {
			failures.push(`${locale.file} is missing.`);
			continue;
		}
		const { blob: sourceBlob, body } = splitTranslation(readFileSync(path, "utf8"), locale);
		if (!sourceBlob) {
			failures.push(`${locale.file} is missing its readme-sync marker.`);
			continue;
		}
		const source = readBlob(sourceBlob);
		if (source === null) {
			failures.push(`${locale.file} names source blob ${sourceBlob}, which is not in this repository.`);
			continue;
		}
		for (const error of validateTranslation(source, body)) failures.push(`${locale.file}: ${error}`);
		if (sourceBlob !== blob) console.log(`${locale.file}: behind ${SOURCE}; the next sync on main will update it.`);
	}
	for (const failure of failures) console.error(failure);
	return failures.length === 0 ? 0 : 1;
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	const english = readFileSync(join(ROOT, SOURCE), "utf8");
	if (args.includes("--check")) return check(english);
	if (!english.split("\n").includes(SWITCHER)) {
		console.error(`${SOURCE} must contain the language switcher: ${SWITCHER}`);
		return 1;
	}

	const only = args.includes("--locale") ? args[args.indexOf("--locale") + 1] : undefined;
	const selected = only ? LOCALES.filter((locale) => locale.code === only) : LOCALES;
	if (selected.length === 0) {
		console.error(`Unknown locale: ${only}. Known locales: ${LOCALES.map((locale) => locale.code).join(", ")}`);
		return 1;
	}

	const blob = git(["hash-object", "--stdin"], english);
	const full = args.includes("--full");
	const results = await Promise.allSettled(selected.map((locale) => translate(locale, english, blob, full)));
	let failed = 0;
	results.forEach((result, index) => {
		const file = selected[index]?.file;
		if (result.status === "fulfilled") {
			console.log(`${file}: ${result.value}`);
		} else {
			failed++;
			console.error(result.reason instanceof Error ? result.reason.message : `${file}: ${String(result.reason)}`);
		}
	});
	return failed === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
