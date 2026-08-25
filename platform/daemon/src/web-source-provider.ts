import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import {
	normalizePublicWebUrl,
	type SignetSourceEntry,
	type SourceFailureState,
	type SourceProviderKind,
	parseWebSettings as parseWebSourceSettings,
} from "@signet/core";
import { parseHTML } from "linkedom";
import { Defuddle, type DefuddleResponse } from "defuddle/node";
import { getDbAccessor } from "./db-accessor";
import { countChanges } from "./db-helpers";
import { indexExternalMemoryArtifact } from "./memory-lineage";
import { indexSourceArtifactStructure, purgeSourceArtifactStructure } from "./source-artifact-graph";
import type { SourceProviderAdapter, SourceProviderSyncContext, SourceProviderSyncResult } from "./source-providers";
import { purgeSourceOwnedRows } from "./source-purge";

const WEB_PROVIDER_KIND: SourceProviderKind = "web";
const WEB_HARNESS = "web";
export const WEB_MAX_REDIRECTS = 5;
export const WEB_FETCH_TIMEOUT_MS = 15_000;
export const WEB_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const WEB_MAX_EXTRACTED_CHARS = 750_000;

const ALLOWED_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml"]);
let webDnsLookup: typeof lookup = lookup;

export function setWebDnsLookupForTest(resolver: typeof lookup | null): void {
	webDnsLookup = resolver ?? lookup;
}

export interface WebFetchResult {
	readonly requestedUrl: string;
	readonly finalUrl: string;
	readonly contentType: string;
	readonly html: string;
	readonly responseBytes: number;
	readonly redirects: number;
}

export class WebSourceFetchError extends Error {
	readonly code: string;
	readonly recoverable: boolean;
	readonly metadata: Readonly<Record<string, unknown>>;

	constructor(
		message: string,
		options: {
			readonly code: string;
			readonly recoverable?: boolean;
			readonly metadata?: Readonly<Record<string, unknown>>;
		},
	) {
		super(message);
		this.name = "WebSourceFetchError";
		this.code = options.code;
		this.recoverable = options.recoverable ?? true;
		this.metadata = options.metadata ?? {};
	}
}

export const webSourceProvider: SourceProviderAdapter = {
	kind: WEB_PROVIDER_KIND,
	sync: syncWebSource,
	purge: async (source, agentId) => await purgeSourceOwnedRows({ sourceId: source.id, agentId }),
};

async function syncWebSource(context: SourceProviderSyncContext): Promise<SourceProviderSyncResult> {
	const settings = parseWebSourceSettings(context.source.providerSettings);
	const requestedUrl = settings.url;
	const syncStartedAt = new Date().toISOString();
	let indexed = 0;
	const failures: SourceFailureState[] = [];
	context.onProgress?.({ scanned: 0, total: 1, indexed: 0, currentPath: requestedUrl });

	try {
		const fetched = await fetchPublicWebPage(requestedUrl);
		if (!context.shouldContinue()) return { indexed: 0, scanned: 0, total: 1, failures: [] };
		const extracted = await extractWebPage(fetched);
		const sourcePath = webSourcePath(extracted.finalUrl);
		const content = webMarkdownContent(extracted, fetched);
		await indexExternalMemoryArtifact({
			agentId: context.agentId,
			harness: WEB_HARNESS,
			sourceId: context.source.id,
			sourceRoot: context.source.root,
			sourceExternalId: extracted.canonicalUrl ?? extracted.finalUrl,
			sourceParentPath: `web://${new URL(extracted.finalUrl).host}`,
			sourcePath,
			sourceKind: "source_web_page",
			sourceMtimeMs: Date.parse(extracted.published ?? "") || Date.now(),
			capturedAt: new Date().toISOString(),
			content,
			sourceMeta: {
				provider: WEB_PROVIDER_KIND,
				originalUrl: fetched.requestedUrl,
				finalUrl: fetched.finalUrl,
				canonicalUrl: extracted.canonicalUrl,
				title: extracted.title,
				author: extracted.author,
				description: extracted.description,
				published: extracted.published,
				site: extracted.site,
				language: extracted.language,
				image: extracted.image,
				contentType: fetched.contentType,
				responseBytes: fetched.responseBytes,
				redirects: fetched.redirects,
				extraction: extracted.diagnostics,
			},
		});
		indexSourceArtifactStructure({
			agentId: context.agentId,
			sourceId: context.source.id,
			sourceKind: "source_web_page",
			sourceRoot: context.source.root,
			sourceParentPath: `web://${new URL(extracted.finalUrl).host}`,
			sourcePath,
			displayName: extracted.title,
			content,
		});
		indexed = 1;
		await purgeStaleWebArtifacts(context.source.id, context.agentId, syncStartedAt, new Set([sourcePath]));
		await purgeStaleWebFailureArtifacts(context.source.id, context.agentId);
		context.onProgress?.({ scanned: 1, total: 1, indexed, currentPath: sourcePath });
		return { indexed, scanned: 1, total: 1, failures };
	} catch (error) {
		const failure = toFailureState(context.source, error);
		failures.push(failure);
		if (context.shouldContinue()) {
			indexed += await writeFailureArtifact(context.source, context.agentId, failure);
			context.onProgress?.({
				scanned: 1,
				total: 1,
				indexed,
				currentPath: failureArtifactPath(context.source, failure),
			});
		}
		return { indexed, scanned: 1, total: 1, failures };
	}
}

export async function fetchPublicWebPage(requestedUrl: string): Promise<WebFetchResult> {
	const normalized = normalizePublicWebUrl(requestedUrl);
	if (!normalized) {
		throw new WebSourceFetchError("Web page URL must be a public http(s) URL", {
			code: "unsafe_target",
			recoverable: false,
		});
	}
	let currentUrl = normalized;
	for (let redirects = 0; redirects <= WEB_MAX_REDIRECTS; redirects++) {
		await assertPublicWebHost(currentUrl);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
		timer.unref?.();
		let response: Response;
		try {
			response = await fetch(currentUrl, {
				method: "GET",
				redirect: "manual",
				signal: controller.signal,
				headers: {
					Accept: "text/html,application/xhtml+xml;q=0.9",
					"User-Agent": "Signet/1 web-source",
				},
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new WebSourceFetchError(
				controller.signal.aborted
					? `Web page request timed out after ${WEB_FETCH_TIMEOUT_MS}ms`
					: `Web page request failed: ${detail}`,
				{ code: controller.signal.aborted ? "timeout" : "fetch_failed", metadata: { url: currentUrl } },
			);
		} finally {
			clearTimeout(timer);
		}

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location)
				throw new WebSourceFetchError("Web page redirect did not include a destination", { code: "redirect" });
			const next = normalizePublicWebUrl(new URL(location, currentUrl).toString());
			if (!next) {
				throw new WebSourceFetchError("Web page redirect points to an unsafe destination", {
					code: "unsafe_redirect",
					recoverable: false,
					metadata: { from: currentUrl },
				});
			}
			if (redirects === WEB_MAX_REDIRECTS)
				throw new WebSourceFetchError(`Web page exceeded the ${WEB_MAX_REDIRECTS}-redirect limit`, {
					code: "redirect_limit",
				});
			currentUrl = next;
			continue;
		}
		if (!response.ok) {
			throw new WebSourceFetchError(`Web page returned HTTP ${response.status}`, {
				code: "http_status",
				metadata: { url: currentUrl, status: response.status },
			});
		}
		const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
		if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
			throw new WebSourceFetchError(`Web page content type is not HTML: ${contentType}`, {
				code: "content_type",
				recoverable: false,
				metadata: { url: currentUrl, contentType },
			});
		}
		const declaredBytes = Number.parseInt(response.headers.get("content-length") ?? "", 10);
		if (Number.isFinite(declaredBytes) && declaredBytes > WEB_MAX_RESPONSE_BYTES) {
			throw new WebSourceFetchError(`Web page response exceeds the ${WEB_MAX_RESPONSE_BYTES}-byte limit`, {
				code: "response_size",
				recoverable: false,
				metadata: { url: currentUrl, contentLength: declaredBytes },
			});
		}
		const { html, bytes } = await readBoundedResponse(response, currentUrl);
		return {
			requestedUrl: normalized,
			finalUrl: currentUrl,
			contentType: contentType || "text/html",
			html,
			responseBytes: bytes,
			redirects,
		};
	}
	throw new WebSourceFetchError("Web page redirect handling failed", { code: "redirect" });
}

async function readBoundedResponse(
	response: Response,
	url: string,
): Promise<{ readonly html: string; readonly bytes: number }> {
	if (!response.body) {
		const text = await response.text();
		const bytes = new TextEncoder().encode(text).byteLength;
		if (bytes > WEB_MAX_RESPONSE_BYTES) {
			throw new WebSourceFetchError(`Web page response exceeds the ${WEB_MAX_RESPONSE_BYTES}-byte limit`, {
				code: "response_size",
				recoverable: false,
				metadata: { url, bytes },
			});
		}
		return { html: text, bytes };
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
			bytes += chunk.byteLength;
			if (bytes > WEB_MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new WebSourceFetchError(`Web page response exceeds the ${WEB_MAX_RESPONSE_BYTES}-byte limit`, {
					code: "response_size",
					recoverable: false,
					metadata: { url, bytes },
				});
			}
			chunks.push(chunk);
		}
	} finally {
		reader.releaseLock();
	}
	const combined = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { html: new TextDecoder().decode(combined), bytes };
}

async function assertPublicWebHost(url: string): Promise<void> {
	const parsed = new URL(url);
	const addresses = await webDnsLookup(parsed.hostname, { all: true, verbatim: true }).catch((error) => {
		throw new WebSourceFetchError(`Unable to resolve public web host ${parsed.hostname}`, {
			code: "dns",
			metadata: { host: parsed.hostname, detail: error instanceof Error ? error.message : String(error) },
		});
	});
	for (const address of addresses) {
		if (isUnsafeResolvedAddress(address.address)) {
			throw new WebSourceFetchError("Web page host resolves to a private or local address", {
				code: "unsafe_target",
				recoverable: false,
				metadata: { host: parsed.hostname, address: address.address },
			});
		}
	}
}

function isUnsafeResolvedAddress(address: string): boolean {
	const normalized = normalizePublicWebUrl(address.includes(":") ? `https://[${address}]` : `https://${address}`);
	return normalized === null;
}

interface ExtractedWebPage {
	readonly title: string;
	readonly author: string;
	readonly description: string;
	readonly published: string;
	readonly site: string;
	readonly language: string;
	readonly image: string;
	readonly finalUrl: string;
	readonly canonicalUrl: string | null;
	readonly markdown: string;
	readonly diagnostics: Readonly<Record<string, unknown>>;
}

async function extractWebPage(fetched: WebFetchResult): Promise<ExtractedWebPage> {
	const { document } = parseHTML(fetched.html);
	const result = (await Defuddle(document, fetched.finalUrl, {
		markdown: true,
		separateMarkdown: true,
		debug: false,
		useAsync: false,
	})) as DefuddleResponse;
	const markdown = (result.contentMarkdown ?? result.content ?? "").trim();
	if (!markdown)
		throw new WebSourceFetchError("Defuddle could not extract readable page content", { code: "empty_content" });
	const canonicalUrl = canonicalUrlFromDefuddle(result, fetched.finalUrl);
	const boundedMarkdown = markdown.slice(0, WEB_MAX_EXTRACTED_CHARS);
	return {
		title: boundedString(result.title, "Untitled web page", 500),
		author: boundedString(result.author, "", 500),
		description: boundedString(result.description, "", 2_000),
		published: boundedString(result.published, "", 120),
		site: boundedString(result.site || result.domain, new URL(fetched.finalUrl).hostname, 300),
		language: boundedString(result.language, "", 80),
		image: boundedString(result.image, "", 2_048),
		finalUrl: fetched.finalUrl,
		canonicalUrl,
		markdown: boundedMarkdown,
		diagnostics: {
			extractorType: boundedString(result.extractorType, "", 120) || null,
			parseTimeMs: Number.isFinite(result.parseTime) ? Math.max(0, Math.round(result.parseTime)) : null,
			wordCount: Number.isFinite(result.wordCount) ? Math.max(0, Math.round(result.wordCount)) : null,
			contentSelector: boundedString(result.debug?.contentSelector, "", 300) || null,
			removals: (result.debug?.removals ?? []).slice(0, 20).map((removal) => ({
				step: boundedString(removal.step, "", 100),
				selector: boundedString(removal.selector, "", 200) || undefined,
				reason: boundedString(removal.reason, "", 200) || undefined,
				text: boundedString(removal.text, "", 200),
			})),
			contentTruncated: markdown.length > WEB_MAX_EXTRACTED_CHARS,
		},
	};
}

function canonicalUrlFromDefuddle(result: DefuddleResponse, fallback: string): string | null {
	const canonical = result.metaTags?.find(
		(tag) => tag.name?.toLowerCase() === "canonical" || tag.property?.toLowerCase() === "og:url",
	)?.content;
	if (!canonical) return null;
	const normalized = normalizePublicWebUrl(new URL(canonical, fallback).toString());
	return normalized ?? null;
}

function webMarkdownContent(page: ExtractedWebPage, fetched: WebFetchResult): string {
	const frontmatter = [
		"---",
		`title: ${JSON.stringify(page.title)}`,
		`author: ${JSON.stringify(page.author || null)}`,
		`description: ${JSON.stringify(page.description || null)}`,
		`published: ${JSON.stringify(page.published || null)}`,
		`site: ${JSON.stringify(page.site || null)}`,
		`language: ${JSON.stringify(page.language || null)}`,
		`image: ${JSON.stringify(page.image || null)}`,
		`original_url: ${JSON.stringify(fetched.requestedUrl)}`,
		`final_url: ${JSON.stringify(page.finalUrl)}`,
		`canonical_url: ${JSON.stringify(page.canonicalUrl)}`,
		"---",
	].join("\n");
	return `${frontmatter}\n\n# ${page.title}\n\nSource: ${page.canonicalUrl ?? page.finalUrl}\n\n${page.markdown}`;
}

function webSourcePath(url: string): string {
	const parsed = new URL(url);
	return `web://${parsed.host}${parsed.pathname || "/"}${parsed.search}`;
}

function boundedString(value: unknown, fallback: string, max: number): string {
	return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

async function writeFailureArtifact(
	source: SignetSourceEntry,
	agentId: string,
	failure: SourceFailureState,
): Promise<number> {
	await indexExternalMemoryArtifact({
		agentId,
		harness: WEB_HARNESS,
		sourceId: source.id,
		sourceRoot: source.root,
		sourceExternalId: `failure:${failure.failedAt}:${failure.message}`,
		sourcePath: failureArtifactPath(source, failure),
		sourceKind: "source_web_failure",
		sourceMtimeMs: Date.parse(failure.failedAt) || Date.now(),
		capturedAt: failure.failedAt,
		content: `# Web page import failed\n\n${failure.message}`,
		sourceMeta: { provider: WEB_PROVIDER_KIND, recoverable: failure.recoverable, ...failure.metadata },
	});
	return 1;
}

function failureArtifactPath(source: SignetSourceEntry, failure: SourceFailureState): string {
	const fingerprint = createHash("sha256")
		.update(failure.message)
		.update("\0")
		.update(JSON.stringify(failure.metadata ?? {}))
		.digest("hex")
		.slice(0, 16);
	return `web://source/${source.id}/failures/${encodeURIComponent(failure.failedAt)}-${fingerprint}`;
}

function toFailureState(source: SignetSourceEntry, error: unknown): SourceFailureState {
	const detail =
		error instanceof WebSourceFetchError
			? error
			: new WebSourceFetchError(error instanceof Error ? error.message : String(error), { code: "extract" });
	return {
		sourceId: source.id,
		providerKind: WEB_PROVIDER_KIND,
		failedAt: new Date().toISOString(),
		recoverable: detail.recoverable,
		message: detail.message,
		metadata: { code: detail.code, ...detail.metadata },
	};
}

async function purgeStaleWebArtifacts(
	sourceId: string,
	agentId: string,
	syncStartedAt: string,
	seenPaths: ReadonlySet<string>,
): Promise<void> {
	const rows = await getDbAccessor().withReadDbAsync(
		(db: import("./db-accessor").ReadDb) =>
			db
				.prepare(
					`SELECT rowid, source_path FROM memory_artifacts
			 WHERE agent_id = ? AND source_id = ? AND source_kind = 'source_web_page'
			   AND updated_at < ? AND COALESCE(is_deleted, 0) = 0`,
				)
				.all(agentId, sourceId, syncStartedAt) as Array<{ rowid: number; source_path: string }>,
		{ siteToken: "web-source-provider.ts:448" },
	);
	for (const row of rows) {
		if (seenPaths.has(row.source_path)) continue;
		purgeSourceArtifactStructure({ agentId, sourceId, sourcePath: row.source_path });
	}
	await getDbAccessor().withWriteTxAsync(
		(db: import("./db-accessor").WriteDb) => {
			for (const row of rows) {
				if (seenPaths.has(row.source_path)) continue;
				countChanges(
					db
						.prepare("UPDATE memory_artifacts SET is_deleted = 1, updated_at = ? WHERE rowid = ?")
						.run(syncStartedAt, row.rowid),
				);
			}
		},
		{ siteToken: "web-source-provider.ts:463" },
	);
}

async function purgeStaleWebFailureArtifacts(sourceId: string, agentId: string): Promise<void> {
	await getDbAccessor().withWriteTxAsync(
		(db: import("./db-accessor").WriteDb) => {
			countChanges(
				db
					.prepare(
						`UPDATE memory_artifacts SET is_deleted = 1, updated_at = ?
				 WHERE agent_id = ? AND source_id = ? AND source_kind = 'source_web_failure'
				   AND COALESCE(is_deleted, 0) = 0`,
					)
					.run(new Date().toISOString(), agentId, sourceId),
			);
		},
		{ siteToken: "web-source-provider.ts:479" },
	);
}
