import { resolve4, resolve6 } from "node:dns/promises";
const PRIVATE_RANGES = [
	/^127\./,
	/^10\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^192\.168\./,
	/^169\.254\./,
	/^0\./,
	/^::1$/,
	/^fc00:/i,
	/^fd[0-9a-f]{2}:/i,
	/^fe80:/i,
	/^::ffff:127\./,
	/^::ffff:10\./,
	/^::ffff:172\.(1[6-9]|2\d|3[01])\./,
	/^::ffff:192\.168\./,
];

function isPrivateIp(ip: string): boolean {
	return PRIVATE_RANGES.some((r) => r.test(ip));
}
export async function validateUrl(url: string): Promise<void> {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error(`Unsupported protocol: ${parsed.protocol}`);
	}
	const [v4, v6] = await Promise.allSettled([resolve4(parsed.hostname), resolve6(parsed.hostname)]);

	const addresses: string[] = [];
	if (v4.status === "fulfilled") addresses.push(...v4.value);
	if (v6.status === "fulfilled") addresses.push(...v6.value);

	if (addresses.length === 0) {
		throw new Error(`DNS resolution failed for ${parsed.hostname}`);
	}

	const blocked = addresses.find(isPrivateIp);
	if (blocked) {
		throw new Error(`URL resolves to private IP (${blocked}) — blocked for SSRF protection`);
	}
}

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
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

const MAX_REDIRECTS = 5;
async function fetchWithSsrfProtection(url: string, timeoutMs: number): Promise<Response> {
	await validateUrl(url);
	let target = url;

	for (let hops = 0; hops < MAX_REDIRECTS; hops++) {
		const resp = await fetch(target, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				"User-Agent": "Signet/1.0 (document-ingest)",
				Accept: "text/html, text/plain, text/markdown, */*;q=0.1",
			},
			redirect: "manual",
		});

		if (resp.status < 300 || resp.status >= 400) return resp;

		const location = resp.headers.get("location");
		if (!location) {
			throw new Error(`Redirect ${resp.status} with no Location header`);
		}
		target = new URL(location, target).href;
		await validateUrl(target);
	}

	throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
}
export async function fetchUrlContent(url: string, opts?: FetchOptions): Promise<FetchResult> {
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
	const response = await fetchWithSsrfProtection(url, timeoutMs);

	if (!response.ok) {
		throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
	}

	const contentType = response.headers.get("content-type") ?? "text/plain";
	const contentLength = response.headers.get("content-length");
	if (contentLength) {
		const declared = Number.parseInt(contentLength, 10);
		if (Number.isFinite(declared) && declared > maxBytes) {
			throw new Error(`Content too large: ${declared} bytes exceeds ${maxBytes} limit`);
		}
	}
	const isHtml = contentType.includes("text/html");
	const isText =
		contentType.includes("text/") ||
		contentType.includes("application/json") ||
		contentType.includes("application/xml");

	if (!isText) {
		throw new Error(`Unsupported content type: ${contentType}. Only text-based content is supported.`);
	}
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
				throw new Error(`Content too large: exceeded ${maxBytes} byte limit during streaming`);
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
function extractHtmlTitle(html: string): string | undefined {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	if (!match?.[1]) return undefined;
	return decodeHtmlEntities(match[1].trim());
}
function stripHtmlTags(html: string): string {
	let text = removeHtmlElementBlocks(html, "script");
	text = removeHtmlElementBlocks(text, "style");
	text = text.replace(/<[^>]*>/g, " ");
	text = decodeHtmlEntities(text);
	text = text.replace(/\s+/g, " ").trim();
	return text;
}

function removeHtmlElementBlocks(html: string, tag: string): string {
	const lower = html.toLowerCase();
	const open = `<${tag}`;
	const close = `</${tag}`;
	let cursor = 0;
	let out = "";

	while (cursor < html.length) {
		const start = lower.indexOf(open, cursor);
		if (start === -1) {
			out += html.slice(cursor);
			break;
		}

		const openEnd = html.indexOf(">", start);
		if (openEnd === -1) {
			out += html.slice(cursor, start);
			break;
		}

		const closeStart = lower.indexOf(close, openEnd + 1);
		if (closeStart === -1) {
			out += html.slice(cursor, start);
			break;
		}

		const closeEnd = html.indexOf(">", closeStart);
		if (closeEnd === -1) {
			out += html.slice(cursor, start);
			break;
		}

		out += `${html.slice(cursor, start)} `;
		cursor = closeEnd + 1;
	}

	return out;
}
function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");
}
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
