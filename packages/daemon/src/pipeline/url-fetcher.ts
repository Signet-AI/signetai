/**
 * URL content fetcher for the document ingest pipeline.
 *
 * Fetches web content with timeout and size guards, strips HTML
 * to plain text for downstream chunking and embedding.
 */

export interface FetchResult {
	readonly content: string;
	readonly contentType: string;
	readonly title?: string;
	readonly byteLength: number;
}

export interface FetchOptions {
	readonly timeoutMs?: number;
	readonly maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Fetch URL content with timeout and size guards.
 *
 * For HTML responses, strips tags and extracts title.
 * For plain text, returns content directly.
 * Rejects unsupported content types (binary, PDF, etc.).
 */
export async function fetchUrlContent(
	url: string,
	opts?: FetchOptions,
): Promise<FetchResult> {
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;

	const response = await fetch(url, {
		signal: AbortSignal.timeout(timeoutMs),
		headers: {
			"User-Agent": "Signet/1.0 (document-ingest)",
			Accept: "text/html, text/plain, text/markdown, */*;q=0.1",
		},
		redirect: "follow",
	});

	if (!response.ok) {
		throw new Error(
			`Fetch failed: ${response.status} ${response.statusText}`,
		);
	}

	const contentType = response.headers.get("content-type") ?? "text/plain";
	const contentLength = response.headers.get("content-length");

	// Pre-flight size check from header
	if (contentLength) {
		const declared = Number.parseInt(contentLength, 10);
		if (Number.isFinite(declared) && declared > maxBytes) {
			throw new Error(
				`Content too large: ${declared} bytes exceeds ${maxBytes} limit`,
			);
		}
	}

	// Check content type is text-based
	const isHtml = contentType.includes("text/html");
	const isText =
		contentType.includes("text/") ||
		contentType.includes("application/json") ||
		contentType.includes("application/xml");

	if (!isText) {
		throw new Error(
			`Unsupported content type: ${contentType}. Only text-based content is supported.`,
		);
	}

	// Stream-read with size guard
	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error("Response body is not readable");
	}

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				throw new Error(
					`Content too large: exceeded ${maxBytes} byte limit during streaming`,
				);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const decoder = new TextDecoder();
	const rawText = decoder.decode(concatUint8Arrays(chunks));

	if (isHtml) {
		const title = extractHtmlTitle(rawText);
		const content = stripHtmlTags(rawText);
		return { content, contentType, title, byteLength: totalBytes };
	}

	return { content: rawText, contentType, byteLength: totalBytes };
}

/** Extract content of the first <title> tag. */
function extractHtmlTitle(html: string): string | undefined {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	if (!match?.[1]) return undefined;
	return decodeHtmlEntities(match[1].trim());
}

/** Strip HTML tags and normalize whitespace. */
function stripHtmlTags(html: string): string {
	// Remove script and style blocks entirely
	let text = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
	text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
	// Remove all remaining tags
	text = text.replace(/<[^>]*>/g, " ");
	// Decode common HTML entities
	text = decodeHtmlEntities(text);
	// Normalize whitespace
	text = text.replace(/\s+/g, " ").trim();
	return text;
}

/** Decode common HTML entities. */
function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ");
}

/** Concatenate Uint8Array chunks into one. */
function concatUint8Arrays(chunks: readonly Uint8Array[]): Uint8Array {
	const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}
