import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { formatFromExtension, toMarkdownBytes } from "@firecrawl/anydoc";

export const IMPORT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const IMPORT_MAX_BATCH_BYTES = 100 * 1024 * 1024;
export const IMPORT_MAX_FILES = 25;

export interface NormalizedImport {
	readonly fileName: string;
	readonly format: string;
	readonly content: string;
	readonly canonicalContent?: string;
	readonly contentHash: string;
	readonly sourceMeta: Readonly<Record<string, unknown>>;
	readonly searchChunks: readonly NormalizedImportChunk[];
}

export interface NormalizedImportChunk {
	readonly content: string;
	readonly sourceMeta: Readonly<Record<string, unknown>>;
}

export type NormalizeImportResult =
	| { readonly ok: true; readonly value: NormalizedImport }
	| { readonly ok: false; readonly error: string };

const ANYDOC_EXTENSIONS = new Set([
	".doc",
	".docx",
	".docm",
	".odt",
	".rtf",
	".pdf",
	".ppt",
	".pptx",
	".ppsx",
	".odp",
	".epub",
	".xls",
	".xlsx",
	".xlsm",
	".ods",
]);

export async function normalizeImportedFile(
	fileName: string,
	bytes: Uint8Array,
	mediaType?: string,
): Promise<NormalizeImportResult> {
	const safeName = basename(fileName).trim();
	if (!safeName) return { ok: false, error: "File name is required" };
	if (bytes.byteLength === 0) return { ok: false, error: "File is empty" };
	if (bytes.byteLength > IMPORT_MAX_FILE_BYTES) {
		return { ok: false, error: `File exceeds the ${IMPORT_MAX_FILE_BYTES} byte limit` };
	}

	const extension = extname(safeName).toLowerCase();
	try {
		if (extension === ".json" || mediaType === "application/json") {
			const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
			const canonicalContent = `${JSON.stringify(parsed)}\n`;
			const content = `${JSON.stringify(parsed, null, 2)}\n`;
			return success(
				safeName,
				"json",
				content,
				{
					representation: "structured-json",
					rootType: Array.isArray(parsed) ? "array" : typeof parsed,
				},
				[],
				canonicalContent,
			);
		}
		if (extension === ".html" || extension === ".htm" || mediaType === "text/html") {
			const content = htmlToText(new TextDecoder().decode(bytes));
			return content.trim()
				? success(safeName, "html", content, { representation: "text-projection" })
				: failure("HTML has no meaningful text content");
		}
		if (extension === ".csv" || mediaType === "text/csv") {
			const content = normalizeText(new TextDecoder().decode(bytes));
			return success(
				safeName,
				"csv",
				content,
				{
					representation: "table",
					rowCount: Math.max(0, csvRecords(content).length - 1),
				},
				csvSearchChunks(content),
			);
		}
		if (
			extension === ".txt" ||
			extension === ".text" ||
			extension === ".md" ||
			extension === ".markdown" ||
			mediaType?.startsWith("text/")
		) {
			return success(
				safeName,
				extension === ".md" || extension === ".markdown" ? "markdown" : "text",
				normalizeText(new TextDecoder().decode(bytes)),
				{
					representation: extension === ".md" || extension === ".markdown" ? "markdown" : "plain-text",
				},
			);
		}
		if (!ANYDOC_EXTENSIONS.has(extension)) return failure(`Unsupported file format: ${extension || "unknown"}`);

		const markdown = await toMarkdownBytes(bytes, formatFromExtension(extension));
		if (new TextEncoder().encode(markdown).byteLength > IMPORT_MAX_FILE_BYTES)
			return failure(`Converted file exceeds the ${IMPORT_MAX_FILE_BYTES} byte limit`);
		const normalizedMarkdown = normalizeText(markdown);
		if (!normalizedMarkdown.trim()) return failure("Document conversion produced no meaningful content");
		return success(safeName, extension.slice(1), normalizedMarkdown, {
			representation: "markdown-projection",
			converter: "anydoc",
		});
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "conversion";
		return failure(`Could not normalize ${safeName} (${code})`);
	}
}

function success(
	fileName: string,
	format: string,
	content: string,
	sourceMeta: Readonly<Record<string, unknown>>,
	searchChunks: readonly NormalizedImportChunk[] = [],
	canonicalContent?: string,
): NormalizeImportResult {
	const encoder = new TextEncoder();
	if (encoder.encode(content).byteLength > IMPORT_MAX_FILE_BYTES)
		return failure(`Normalized file exceeds the ${IMPORT_MAX_FILE_BYTES} byte limit`);
	if (canonicalContent !== undefined && encoder.encode(canonicalContent).byteLength > IMPORT_MAX_FILE_BYTES)
		return failure(`Canonical file exceeds the ${IMPORT_MAX_FILE_BYTES} byte limit`);
	return {
		ok: true,
		value: {
			fileName,
			format,
			content,
			...(canonicalContent === undefined ? {} : { canonicalContent }),
			contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
			sourceMeta,
			searchChunks,
		},
	};
}

function failure(error: string): NormalizeImportResult {
	return { ok: false, error };
}

const CSV_CHUNK_ROWS = 100;

function csvRecords(content: string): string[] {
	const records: string[] = [];
	let current = "";
	let quoted = false;
	for (let index = 0; index < content.length; index += 1) {
		const character = content[index] ?? "";
		if (character === '"') {
			if (quoted && content[index + 1] === '"') {
				current += '""';
				index += 1;
				continue;
			}
			quoted = !quoted;
			current += character;
			continue;
		}
		if (character === "\n" && !quoted) {
			if (current.trim().length > 0) records.push(current);
			current = "";
			continue;
		}
		current += character;
	}
	if (current.trim().length > 0) records.push(current);
	return records;
}

function csvSearchChunks(content: string): NormalizedImportChunk[] {
	const records = csvRecords(content);
	if (records.length <= 1) return [];
	const header = records[0] ?? "";
	const chunks: NormalizedImportChunk[] = [];
	for (let offset = 1; offset < records.length; offset += CSV_CHUNK_ROWS) {
		const rows = records.slice(offset, offset + CSV_CHUNK_ROWS);
		const rowStart = offset;
		const rowEnd = offset + rows.length - 1;
		chunks.push({
			content: `${[header, ...rows].join("\n")}\n`,
			sourceMeta: {
				representation: "table-row-range",
				rowStart,
				rowEnd,
				rowCount: rows.length,
			},
		});
	}
	return chunks;
}

function normalizeText(value: string): string {
	return `${value.replace(/\r\n?/g, "\n").split(String.fromCharCode(0)).join("").trimEnd()}\n`;
}

function htmlToText(value: string): string {
	return normalizeText(
		decodeEntities(
			value
				.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
				.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
				.replace(/<br\s*\/?>(?=.)/gi, "\n")
				.replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
				.replace(/<[^>]+>/g, "")
				.replace(/[ \t]+/g, " "),
		),
	);
}

function decodeEntities(value: string): string {
	return value
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'");
}
