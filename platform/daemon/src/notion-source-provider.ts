import { createHash } from "node:crypto";
import {
	type SignetSourceEntry,
	type SourceFailureState,
	type SourceProviderKind,
	parseNotionSettings,
} from "@signet/core";
import { yieldEvery } from "./async-yield";
import { dbOwnerQuery, dbOwnerTransaction, ownerStatement } from "./db-owner-runtime";
import { logger } from "./logger";
import { indexExternalMemoryArtifact } from "./memory-lineage";
import {
	type NotionPage,
	type NotionPageMarkdown,
	NotionRequestError,
	type NotionSearchResult,
	fetchNotionPage,
	fetchNotionPageMarkdown,
	searchNotionPages,
} from "./notion-source-fetch";
import { getSecret } from "./secrets";
import { indexSourceArtifactStructureAsync, purgeSourceArtifactStructureAsync } from "./source-artifact-graph";
import type { SourceProviderAdapter, SourceProviderSyncContext, SourceProviderSyncResult } from "./source-providers";
import { purgeSourceOwnedRows } from "./source-purge";

const NOTION_PROVIDER_KIND: SourceProviderKind = "notion";
const NOTION_HARNESS = "notion";
const PAGE_KIND = "source_notion_page";
export const NOTION_EDIT_GRANULARITY_MS = 60_000;
export const NOTION_MAX_PURGE_CONFIRMATIONS = 200;
export const NOTION_MAX_UNKNOWN_BLOCK_RESOLUTIONS = 25;
const VERSION_BATCH = 100;
const STALE_SCAN_BATCH = 500;
const PURGE_BATCH = 100;

interface IndexedPageVersion {
	readonly mtimeMs: number | null;
	readonly syncedAtMs: number | null;
	readonly incomplete: boolean;
}

interface CompletedMarkdown {
	readonly markdown: string;
	readonly unsupportedBlocks: number;
	readonly missingBlocks: number;
}

interface StaleCandidate {
	readonly rowid: number;
	readonly sourcePath: string;
	readonly pageId: string | null;
	readonly mtimeMs: number | null;
}

export const notionSourceProvider: SourceProviderAdapter = {
	kind: NOTION_PROVIDER_KIND,
	sync: syncNotionSource,
	purge: async (source, agentId) => await purgeSourceOwnedRows({ sourceId: source.id, agentId }),
};

async function syncNotionSource(context: SourceProviderSyncContext): Promise<SourceProviderSyncResult> {
	const source = context.source;
	const agentId = context.agentId;
	const settings = parseNotionSettings(source.providerSettings);
	const syncStartedAt = new Date().toISOString();
	const token = await resolveToken(settings.tokenRef);
	const failures: SourceFailureState[] = [];
	let indexed = 0;
	let scanned = 0;
	let total = 0;
	context.onProgress?.({ scanned, total, indexed, currentPath: source.root });

	let search: NotionSearchResult | null = null;
	try {
		search = await searchNotionPages(token, settings.maxPages, context.shouldContinue);
	} catch (err) {
		failures.push(failureState(source, `Notion search failed: ${errorMessage(err)}`, { phase: "search" }));
	}

	if (search) {
		total = search.pages.length;
		if (search.capped) {
			logger.warn("notion-source", "Notion page enumeration hit configured cap", {
				sourceId: source.id,
				maxPages: settings.maxPages,
			});
		}
		if (search.incomplete) {
			failures.push(
				failureState(source, "Notion search returned an incomplete result set; stale pages were not purged", {
					phase: "search",
				}),
			);
		}
		const seenPaths = new Set(search.partialIds.map((id) => pagePath(source, id)));
		if (search.partialIds.length > 0) {
			logger.warn("notion-source", "Notion search returned partial page objects; kept existing artifacts", {
				sourceId: source.id,
				partial: search.partialIds.length,
			});
		}
		const yielder = yieldEvery(5);
		let stateReadable = true;
		for (
			let start = 0;
			start < search.pages.length && stateReadable && context.shouldContinue();
			start += VERSION_BATCH
		) {
			const batch = search.pages.slice(start, start + VERSION_BATCH);
			let versions: ReadonlyMap<string, IndexedPageVersion>;
			try {
				versions = await readIndexedPageVersions(
					source.id,
					agentId,
					batch.map((page) => pagePath(source, page.id)),
				);
			} catch (err) {
				failures.push(failureState(source, `Notion index state read failed: ${errorMessage(err)}`, { phase: "state" }));
				stateReadable = false;
				break;
			}
			for (const page of batch) {
				if (!context.shouldContinue()) break;
				const path = pagePath(source, page.id);
				seenPaths.add(path);
				context.onProgress?.({ scanned, total, indexed, currentPath: path });
				if (isCurrent(versions.get(path), page)) {
					indexed++;
				} else if (await syncPage(source, agentId, token, page, failures, context.shouldContinue)) {
					indexed++;
				}
				scanned++;
				await yielder();
			}
		}
		context.onProgress?.({ scanned, total, indexed, currentPath: source.root });
		if (context.shouldContinue() && scanned === total && !search.incomplete) {
			try {
				await purgeStalePages(
					source,
					agentId,
					token,
					search,
					seenPaths,
					syncStartedAt,
					failures,
					context.shouldContinue,
				);
			} catch (err) {
				failures.push(failureState(source, `Notion stale page purge failed: ${errorMessage(err)}`, { phase: "purge" }));
			}
		}
	}

	if (!context.shouldContinue()) return { indexed, scanned, total, failures };
	await purgeStaleFailureArtifacts(source.id, agentId, syncStartedAt);
	for (const failure of failures) {
		await writeFailureArtifact(source, agentId, failure);
	}
	return { indexed: indexed + failures.length, scanned, total, failures };
}

function isCurrent(stored: IndexedPageVersion | undefined, page: NotionPage): boolean {
	if (!stored || stored.incomplete || stored.syncedAtMs === null) return false;
	const editedMs = Date.parse(page.lastEditedTime);
	return stored.mtimeMs === editedMs && stored.syncedAtMs >= editedMs + NOTION_EDIT_GRANULARITY_MS;
}

async function syncPage(
	source: SignetSourceEntry,
	agentId: string,
	token: string,
	page: NotionPage,
	failures: SourceFailureState[],
	shouldContinue: () => boolean,
): Promise<boolean> {
	const fetchedAtMs = Date.now();
	let markdown: CompletedMarkdown;
	try {
		markdown = await completeMarkdown(
			token,
			await fetchNotionPageMarkdown(token, page.id, shouldContinue),
			shouldContinue,
		);
	} catch (err) {
		failures.push(
			failureState(source, `Notion page fetch failed for "${page.title}": ${errorMessage(err)}`, {
				phase: "markdown",
				pageId: page.id,
			}),
		);
		return false;
	}
	try {
		await writePageArtifact(source, agentId, page, markdown, fetchedAtMs);
	} catch (err) {
		failures.push(
			failureState(source, `Notion page indexing failed for "${page.title}": ${errorMessage(err)}`, {
				phase: "index",
				pageId: page.id,
			}),
		);
		return false;
	}
	if (markdown.missingBlocks > 0) {
		failures.push(
			failureState(
				source,
				`Notion page "${page.title}" is incomplete: ${markdown.missingBlocks} block(s) could not be retrieved`,
				{ phase: "markdown", pageId: page.id, missingBlocks: markdown.missingBlocks },
			),
		);
	}
	return true;
}

async function completeMarkdown(
	token: string,
	fetched: NotionPageMarkdown,
	shouldContinue: () => boolean,
): Promise<CompletedMarkdown> {
	let markdown = fetched.markdown;
	let unsupportedBlocks = 0;
	let missingBlocks = fetched.truncated && fetched.unknownBlockIds.length === 0 ? 1 : 0;
	for (const [index, blockId] of fetched.unknownBlockIds.entries()) {
		if (index >= NOTION_MAX_UNKNOWN_BLOCK_RESOLUTIONS || !shouldContinue()) {
			missingBlocks++;
			continue;
		}
		let resolved: NotionPageMarkdown;
		try {
			resolved = await fetchNotionPageMarkdown(token, blockId, shouldContinue);
		} catch (err) {
			if (err instanceof NotionRequestError && (err.status === 403 || err.status === 404)) unsupportedBlocks++;
			else missingBlocks++;
			continue;
		}
		const text = resolved.markdown.trim();
		if (!text.replace(UNKNOWN_TAG, "").trim()) {
			unsupportedBlocks++;
			continue;
		}
		markdown = substituteUnknownBlock(markdown, blockId, text);
	}
	return {
		markdown: markdown.replace(UNKNOWN_TAG, (tag) => `[Unsupported Notion block: ${unknownTagLabel(tag)}]`),
		unsupportedBlocks,
		missingBlocks,
	};
}

const UNKNOWN_TAG = /<unknown\b[^>]*>/g;

function substituteUnknownBlock(markdown: string, blockId: string, replacement: string): string {
	const compact = blockId.replace(/-/g, "");
	let replaced = false;
	const next = markdown.replace(UNKNOWN_TAG, (tag) => {
		if (replaced || (!tag.includes(blockId) && !tag.includes(compact))) return tag;
		replaced = true;
		return replacement;
	});
	return replaced ? next : `${markdown}\n\n${replacement}`;
}

function unknownTagLabel(tag: string): string {
	return tag.match(/alt="([^"]*)"/)?.[1] || "block";
}

async function writePageArtifact(
	source: SignetSourceEntry,
	agentId: string,
	page: NotionPage,
	markdown: CompletedMarkdown,
	fetchedAtMs: number,
): Promise<void> {
	const sourcePath = pagePath(source, page.id);
	const sourceParentPath = parentPath(source, page);
	const content = pageContent(page, markdown);
	await indexExternalMemoryArtifact({
		agentId,
		harness: NOTION_HARNESS,
		sourceId: source.id,
		sourceRoot: source.root,
		sourceExternalId: page.id,
		sourceParentPath,
		sourcePath,
		sourceKind: PAGE_KIND,
		sourceMtimeMs: Date.parse(page.lastEditedTime),
		capturedAt: page.lastEditedTime,
		content,
		sourceMeta: {
			provider: NOTION_PROVIDER_KIND,
			pageId: page.id,
			url: page.url,
			title: page.title,
			parentType: page.parentType,
			parentId: page.parentId,
			createdTime: page.createdTime,
			lastEditedTime: page.lastEditedTime,
			incomplete: markdown.missingBlocks > 0,
			missingBlocks: markdown.missingBlocks,
			unsupportedBlocks: markdown.unsupportedBlocks,
		},
	});
	await indexSourceArtifactStructureAsync({
		agentId,
		sourceId: source.id,
		sourceKind: PAGE_KIND,
		sourceRoot: source.root,
		sourceParentPath,
		sourcePath,
		displayName: page.title,
		content,
	});
	await dbOwnerTransaction(
		[
			ownerStatement(
				`UPDATE memory_artifacts SET source_meta_json = json_set(COALESCE(source_meta_json, '{}'), '$.syncedAtMs', ?)
				 WHERE agent_id = ? AND source_id = ? AND source_path = ? AND COALESCE(is_deleted, 0) = 0`,
				[fetchedAtMs, agentId, source.id, sourcePath],
			),
		],
		{ operation: "sources.notion.mark_synced", lane: "write", deadlineMs: 5_000, estimatedWorkUnits: 1 },
	);
}

function pageContent(page: NotionPage, markdown: CompletedMarkdown): string {
	const lines = [`# ${page.title}`, ""];
	if (page.url) lines.push(`URL: ${page.url}`);
	lines.push(`Last edited: ${page.lastEditedTime}`);
	if (page.properties.length > 0) {
		lines.push("", "## Properties", "");
		for (const property of page.properties) lines.push(`- ${property.name}: ${property.value}`);
	}
	lines.push("", markdown.markdown.trim());
	if (markdown.missingBlocks > 0)
		lines.push("", `> ${markdown.missingBlocks} Notion block(s) on this page could not be retrieved.`);
	return lines.join("\n");
}

function pagePath(source: SignetSourceEntry, pageId: string): string {
	return `notion://sources/${source.id}/pages/${pageId}`;
}

function parentPath(source: SignetSourceEntry, page: NotionPage): string {
	if (!page.parentId) return source.root;
	if (page.parentType === "page_id") return `notion://sources/${source.id}/parents/pages/${page.parentId}`;
	if (page.parentType === "data_source_id" || page.parentType === "database_id")
		return `notion://sources/${source.id}/parents/data-sources/${page.parentId}`;
	return source.root;
}

async function readIndexedPageVersions(
	sourceId: string,
	agentId: string,
	paths: readonly string[],
): Promise<ReadonlyMap<string, IndexedPageVersion>> {
	const versions = new Map<string, IndexedPageVersion>();
	if (paths.length === 0) return versions;
	const rows = await dbOwnerQuery<
		Array<{
			readonly source_path: string;
			readonly source_mtime_ms: number | null;
			readonly synced_at_ms: number | null;
			readonly incomplete: number | null;
		}>
	>(
		{
			sql: `SELECT source_path, source_mtime_ms,
			        json_extract(source_meta_json, '$.syncedAtMs') AS synced_at_ms,
			        json_extract(source_meta_json, '$.incomplete') AS incomplete
			 FROM memory_artifacts
			 WHERE agent_id = ? AND source_id = ? AND source_kind = 'source_notion_page'
			   AND COALESCE(is_deleted, 0) = 0
			   AND source_path IN (${paths.map(() => "?").join(", ")})`,
			params: [agentId, sourceId, ...paths],
			result: "all",
		},
		{ operation: "sources.notion.read_versions", lane: "read", deadlineMs: 5_000 },
	);
	for (const row of rows) {
		versions.set(row.source_path, {
			mtimeMs: typeof row.source_mtime_ms === "number" ? row.source_mtime_ms : null,
			syncedAtMs: typeof row.synced_at_ms === "number" ? row.synced_at_ms : null,
			incomplete: row.incomplete === 1,
		});
	}
	return versions;
}

async function purgeStalePages(
	source: SignetSourceEntry,
	agentId: string,
	token: string,
	search: NotionSearchResult,
	seenPaths: ReadonlySet<string>,
	syncStartedAt: string,
	failures: SourceFailureState[],
	shouldContinue: () => boolean,
): Promise<void> {
	const candidates = await readStaleCandidates(source.id, agentId, seenPaths);
	if (candidates.length === 0) return;
	const windowFloorMs = search.capped
		? search.pages.reduce((floor, page) => Math.min(floor, Date.parse(page.lastEditedTime)), Number.POSITIVE_INFINITY)
		: Number.NEGATIVE_INFINITY;
	const stale: StaleCandidate[] = [];
	let confirmations = 0;
	let unconfirmed = 0;
	for (const candidate of candidates) {
		if (!shouldContinue()) return;
		if (candidate.mtimeMs !== null && candidate.mtimeMs < windowFloorMs) {
			stale.push(candidate);
			continue;
		}
		if (!candidate.pageId || confirmations >= NOTION_MAX_PURGE_CONFIRMATIONS) {
			unconfirmed++;
			continue;
		}
		confirmations++;
		try {
			const lookup = await fetchNotionPage(token, candidate.pageId, shouldContinue);
			if (lookup.status === "gone" || Date.parse(lookup.page.lastEditedTime) < windowFloorMs) stale.push(candidate);
		} catch {
			unconfirmed++;
		}
	}
	if (unconfirmed > 0) {
		failures.push(
			failureState(source, `Could not confirm removal of ${unconfirmed} Notion page(s); kept them for the next sync`, {
				phase: "purge",
				unconfirmed,
			}),
		);
	}
	for (let start = 0; start < stale.length; start += PURGE_BATCH) {
		if (!shouldContinue()) return;
		const batch = stale.slice(start, start + PURGE_BATCH);
		for (const row of batch) {
			await purgeSourceArtifactStructureAsync({ agentId, sourceId: source.id, sourcePath: row.sourcePath });
		}
		await dbOwnerTransaction(
			[
				ownerStatement(
					`UPDATE memory_artifacts SET is_deleted = 1, updated_at = ?
					 WHERE agent_id = ? AND source_id = ? AND rowid IN (${batch.map(() => "?").join(", ")})`,
					[syncStartedAt, agentId, source.id, ...batch.map((row) => row.rowid)],
				),
			],
			{ operation: "sources.notion.purge_stale", lane: "write", deadlineMs: 30_000, estimatedWorkUnits: batch.length },
		);
	}
}

async function readStaleCandidates(
	sourceId: string,
	agentId: string,
	seenPaths: ReadonlySet<string>,
): Promise<StaleCandidate[]> {
	const candidates: StaleCandidate[] = [];
	let after = "";
	for (;;) {
		const rows = await dbOwnerQuery<
			Array<{
				readonly rowid: number;
				readonly source_path: string;
				readonly source_external_id: string | null;
				readonly source_mtime_ms: number | null;
			}>
		>(
			{
				sql: `SELECT rowid, source_path, source_external_id, source_mtime_ms FROM memory_artifacts
				 WHERE agent_id = ? AND source_id = ? AND source_kind = 'source_notion_page'
				   AND COALESCE(is_deleted, 0) = 0 AND source_path > ?
				 ORDER BY source_path ASC LIMIT ?`,
				params: [agentId, sourceId, after, STALE_SCAN_BATCH],
				result: "all",
			},
			{ operation: "sources.notion.scan_stale", lane: "read", deadlineMs: 5_000 },
		);
		for (const row of rows) {
			if (seenPaths.has(row.source_path)) continue;
			candidates.push({
				rowid: row.rowid,
				sourcePath: row.source_path,
				pageId: row.source_external_id,
				mtimeMs: typeof row.source_mtime_ms === "number" ? row.source_mtime_ms : null,
			});
		}
		if (rows.length < STALE_SCAN_BATCH) return candidates;
		after = rows[rows.length - 1]?.source_path ?? after;
	}
}

async function purgeStaleFailureArtifacts(sourceId: string, agentId: string, syncStartedAt: string): Promise<void> {
	await dbOwnerTransaction(
		[
			ownerStatement(
				`UPDATE memory_artifacts SET is_deleted = 1, updated_at = ?
				 WHERE agent_id = ? AND source_id = ? AND source_kind = 'source_notion_failure'
				   AND updated_at < ? AND COALESCE(is_deleted, 0) = 0`,
				[syncStartedAt, agentId, sourceId, syncStartedAt],
			),
		],
		{ operation: "sources.notion.purge_failures", lane: "write", deadlineMs: 5_000, estimatedWorkUnits: 1 },
	);
}

async function writeFailureArtifact(
	source: SignetSourceEntry,
	agentId: string,
	failure: SourceFailureState,
): Promise<void> {
	const fingerprint = failureFingerprint(failure);
	await indexExternalMemoryArtifact({
		agentId,
		harness: NOTION_HARNESS,
		sourceId: source.id,
		sourceRoot: source.root,
		sourceExternalId: `failure:${fingerprint}`,
		sourcePath: `notion://sources/${source.id}/failures/${fingerprint}`,
		sourceKind: "source_notion_failure",
		sourceMtimeMs: Date.parse(failure.failedAt) || Date.now(),
		capturedAt: failure.failedAt,
		content: `# Notion sync failed\n\n${failure.message}`,
		sourceMeta: { provider: NOTION_PROVIDER_KIND, recoverable: failure.recoverable, ...failure.metadata },
	});
}

function failureFingerprint(failure: SourceFailureState): string {
	return createHash("sha256")
		.update(failure.message)
		.update("\0")
		.update(JSON.stringify(failure.metadata ?? {}))
		.digest("hex")
		.slice(0, 16);
}

function failureState(
	source: SignetSourceEntry,
	message: string,
	metadata?: Readonly<Record<string, unknown>>,
): SourceFailureState {
	return {
		sourceId: source.id,
		providerKind: NOTION_PROVIDER_KIND,
		failedAt: new Date().toISOString(),
		recoverable: true,
		message,
		metadata,
	};
}

async function resolveToken(tokenRef: string): Promise<string> {
	try {
		return await getSecret(tokenRef);
	} catch (err) {
		throw new Error(`Failed to resolve Notion token ref '${tokenRef}': ${errorMessage(err)}`);
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
