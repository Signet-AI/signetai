import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "./database";
export interface ChunkResult {
	text: string;
	tokenCount: number;
}
export interface HierarchicalChunk {
	text: string;
	tokenCount: number;
	header: string;
	level: "section" | "paragraph";
	chunkIndex: number;
}
export interface ImportResult {
	imported: number;
	skipped: number;
	errors: string[];
}
export interface ChunkOptions {
	maxTokens: number;
}
const DATE_FILENAME_PATTERN = /^(\d{4}-\d{2}-\d{2})\.md$/;
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
export function chunkContent(content: string, options: ChunkOptions): ChunkResult[] {
	const { maxTokens } = options;
	const results: ChunkResult[] = [];
	const paragraphs = content.split(/\n\n+/);

	let currentChunk: string[] = [];
	let currentTokens = 0;

	for (const paragraph of paragraphs) {
		const paragraphTokens = estimateTokens(paragraph);
		if (paragraphTokens > maxTokens) {
			if (currentChunk.length > 0) {
				const text = currentChunk.join("\n\n").trim();
				if (text) {
					results.push({ text, tokenCount: currentTokens });
				}
				currentChunk = [];
				currentTokens = 0;
			}
			const sentences = paragraph.split(/(?<=[.!?])\s+/);

			for (const sentence of sentences) {
				const sentenceTokens = estimateTokens(sentence);

				if (sentenceTokens > maxTokens) {
					const charLimit = maxTokens * 4;
					for (let i = 0; i < sentence.length; i += charLimit) {
						const chunk = sentence.slice(i, i + charLimit).trim();
						if (chunk) {
							results.push({ text: chunk, tokenCount: estimateTokens(chunk) });
						}
					}
				} else if (currentTokens + sentenceTokens > maxTokens) {
					const text = currentChunk.join(" ").trim();
					if (text) {
						results.push({ text, tokenCount: currentTokens });
					}
					currentChunk = [sentence];
					currentTokens = sentenceTokens;
				} else {
					currentChunk.push(sentence);
					currentTokens += sentenceTokens;
				}
			}
		} else if (currentTokens + paragraphTokens > maxTokens) {
			const text = currentChunk.join("\n\n").trim();
			if (text) {
				results.push({ text, tokenCount: currentTokens });
			}
			currentChunk = [paragraph];
			currentTokens = paragraphTokens;
		} else {
			currentChunk.push(paragraph);
			currentTokens += paragraphTokens;
		}
	}
	if (currentChunk.length > 0) {
		const text = currentChunk.join("\n\n").trim();
		if (text) {
			results.push({ text, tokenCount: currentTokens });
		}
	}

	return results;
}
export function chunkMarkdownHierarchically(
	content: string,
	options: ChunkOptions = { maxTokens: 512 },
): HierarchicalChunk[] {
	const results: HierarchicalChunk[] = [];
	const lines = content.split("\n");

	let currentHeader = "";
	let currentContent: string[] = [];
	let chunkIndex = 0;
	const headerPattern = /^(#{1,3})\s+(.+)$/;

	const flushSection = () => {
		if (currentContent.length === 0) return;

		const sectionText = currentContent.join("\n").trim();
		if (!sectionText) return;

		const sectionTokens = estimateTokens(sectionText);

		if (sectionTokens <= options.maxTokens) {
			const textWithHeader = currentHeader ? `${currentHeader}\n\n${sectionText}` : sectionText;
			results.push({
				text: textWithHeader,
				tokenCount: estimateTokens(textWithHeader),
				header: currentHeader,
				level: "section",
				chunkIndex: chunkIndex++,
			});
		} else {
			const paragraphs = sectionText.split(/\n\n+/);
			let chunkParas: string[] = [];
			let chunkTokens = currentHeader ? estimateTokens(currentHeader) : 0;

			for (const para of paragraphs) {
				const paraTokens = estimateTokens(para);
				if (paraTokens > options.maxTokens) {
					if (chunkParas.length > 0) {
						const text = currentHeader ? `${currentHeader}\n\n${chunkParas.join("\n\n")}` : chunkParas.join("\n\n");
						results.push({
							text,
							tokenCount: chunkTokens,
							header: currentHeader,
							level: "paragraph",
							chunkIndex: chunkIndex++,
						});
						chunkParas = [];
						chunkTokens = currentHeader ? estimateTokens(currentHeader) : 0;
					}
					const text = currentHeader ? `${currentHeader}\n\n${para}` : para;
					results.push({
						text,
						tokenCount: estimateTokens(text),
						header: currentHeader,
						level: "paragraph",
						chunkIndex: chunkIndex++,
					});
					continue;
				}

				if (chunkTokens + paraTokens + 2 > options.maxTokens && chunkParas.length > 0) {
					const text = currentHeader ? `${currentHeader}\n\n${chunkParas.join("\n\n")}` : chunkParas.join("\n\n");
					results.push({
						text,
						tokenCount: chunkTokens,
						header: currentHeader,
						level: "paragraph",
						chunkIndex: chunkIndex++,
					});
					chunkParas = [];
					chunkTokens = currentHeader ? estimateTokens(currentHeader) : 0;
				}

				chunkParas.push(para);
				chunkTokens += paraTokens + 2;
			}
			if (chunkParas.length > 0) {
				const text = currentHeader ? `${currentHeader}\n\n${chunkParas.join("\n\n")}` : chunkParas.join("\n\n");
				results.push({
					text,
					tokenCount: chunkTokens,
					header: currentHeader,
					level: "paragraph",
					chunkIndex: chunkIndex++,
				});
			}
		}

		currentContent = [];
	};

	for (const line of lines) {
		const match = line.match(headerPattern);
		if (match) {
			flushSection();
			currentHeader = line;
		} else {
			currentContent.push(line);
		}
	}

	flushSection();
	if (results.length === 0 && content.trim()) {
		const text = content.trim();
		results.push({
			text,
			tokenCount: estimateTokens(text),
			header: "",
			level: "section",
			chunkIndex: 0,
		});
	}

	return results;
}
function extractDateFromFilename(filename: string): string | null {
	const match = filename.match(DATE_FILENAME_PATTERN);
	return match ? match[1] : null;
}
export function importMemoryLogs(basePath: string, db: Database): ImportResult {
	const result: ImportResult = {
		imported: 0,
		skipped: 0,
		errors: [],
	};

	const memoryDir = join(basePath, "memory");
	if (!existsSync(memoryDir)) {
		result.errors.push(`Memory directory not found: ${memoryDir}`);
		return result;
	}
	let files: string[];
	try {
		files = readdirSync(memoryDir).filter((f) => f.endsWith(".md") && !f.startsWith("TEMPLATE"));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		result.errors.push(`Failed to read memory directory: ${message}`);
		return result;
	}
	for (const file of files) {
		const filePath = join(memoryDir, file);
		const date = extractDateFromFilename(file);

		if (!date) {
			result.skipped++;
			result.errors.push(`Invalid filename format (expected YYYY-MM-DD.md): ${file}`);
			continue;
		}
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			result.errors.push(`Failed to read file ${file}: ${message}`);
			result.skipped++;
			continue;
		}
		if (!content.trim()) {
			result.skipped++;
			continue;
		}
		const chunks = chunkContent(content, { maxTokens: 512 });
		for (const chunk of chunks) {
			try {
				db.addMemory({
					type: "daily-log",
					category: date,
					content: chunk.text,
					confidence: 1.0,
					sourceType: "import",
					sourceId: file,
					tags: ["imported", "daily-log"],
					updatedBy: "signet-import",
					vectorClock: {},
					manualOverride: false,
				});
				result.imported++;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				result.errors.push(`Failed to import chunk from ${file}: ${message}`);
			}
		}
	}

	return result;
}
