import type { GitHubSourceSettings, SignetSourceEntry } from "@signet/core";
import { loadSourcesConfig, parseGitHubSettings } from "@signet/core";
import { homedir } from "node:os";
import { resolveDaemonAgentId } from "./agent-id";
import { getDbAccessor } from "./db-accessor";
import { yieldEvery } from "./async-yield";
import type { GitHubResource } from "./github-source-fetch";
import {
	type GitHubFetchConfig,
	expandRepoGlob,
	fetchDiscussionComments,
	fetchDiscussions,
	fetchIssueComments,
	fetchIssues,
	fetchPullRequests,
	fetchRepoDocs,
	fetchRepoInfo,
} from "./github-source-fetch";
import { indexGitHubSourceStructure, purgeGitHubSourceStructure } from "./github-source-graph";
import {
	indexGitHubSourceEmbeddings,
	purgeGitHubSourceEmbeddings,
} from "./github-source-embeddings";
import { logger } from "./logger";
import type { EmbeddingConfig } from "./memory-config";
import type { SourceEmbeddingFetch } from "./obsidian-source-embeddings";
import { getSecret } from "./secrets";

export interface GitHubSourceBridgeHandle {
	readonly sync: () => Promise<number>;
	readonly close: () => Promise<void>;
}

export interface GitHubSourceBridgeOptions {
	readonly agentId?: string;
	readonly pollIntervalMs?: number;
	readonly embeddingConfig?: EmbeddingConfig;
	readonly fetchEmbedding?: SourceEmbeddingFetch;
	readonly agentsDir?: string;
	readonly sourceActiveCheck?: () => boolean;
}

interface ResolvedRepo {
	readonly owner: string;
	readonly repo: string;
	readonly fullName: string;
	defaultBranch: string;
}

export async function resolveRepos(settings: GitHubSourceSettings, token?: string): Promise<ResolvedRepo[]> {
	const resolved: ResolvedRepo[] = [];
	for (const pattern of settings.repos) {
		const [owner, repoPart] = pattern.split("/");
		if (!owner || !repoPart) continue;
		if (repoPart === "*" || repoPart.includes("*")) {
			const expanded = await expandRepoGlob(owner, repoPart, token);
			for (const fullName of expanded) {
				const [o, r] = fullName.split("/");
				if (!o || !r) continue;
				resolved.push({ owner: o, repo: r, fullName, defaultBranch: "main" });
			}
		} else {
			resolved.push({ owner, repo: repoPart, fullName: `${owner}/${repoPart}`, defaultBranch: "main" });
		}
	}
	for (const repo of resolved) {
		const info = await fetchRepoInfo({ owner: repo.owner, repo: repo.repo, token });
		if (info) {
			repo.defaultBranch = info.defaultBranch;
		}
	}
	return resolved;
}

export async function syncGitHubSource(
	source: SignetSourceEntry,
	options: GitHubSourceBridgeOptions = {},
): Promise<number> {
	const agentId = options.agentId ?? resolveDaemonAgentId();
	const settings = parseGitHubSettings(source.settings);
	const token = settings.tokenRef ? await resolveToken(settings.tokenRef, options.agentsDir) : undefined;
	let totalIndexed = 0;

	const repos = await resolveRepos(settings, token);
	logger.info("github-source", "Starting GitHub source sync", {
		sourceId: source.id,
		repoCount: repos.length,
		resourceTypes: settings.resourceTypes,
	});

	const agentsDir = options.agentsDir ?? process.env.SIGNET_PATH ?? `${homedir()}/.agents`;
	const isSourceActive = (): boolean =>
		loadSourcesConfig(agentsDir).sources.some((s) => s.id === source.id && s.enabled);
	const syncOpts: GitHubSourceBridgeOptions = { ...options, sourceActiveCheck: isSourceActive };

	for (const repo of repos) {
		const config: GitHubFetchConfig = { owner: repo.owner, repo: repo.repo, token };
		const yielder = yieldEvery(5);
		let repoIndexed = 0;
		const seenKeys = new Set<string>();
		const completeTypes = new Set<string>();

		try {
			if (!isSourceActive()) {
				logger.info("github-source", "Source removed during sync, aborting", { sourceId: source.id });
				break;
			}
			if (settings.resourceTypes.includes("issues")) {
				const result = await fetchIssues(config, undefined, settings.state, settings.maxItemsPerRepo, settings.labels);
				const capped = result.resources.length >= settings.maxItemsPerRepo;
				for (const resource of result.resources) {
					seenKeys.add(resourceKey(resource));
					const comments =
						settings.includeComments && resource.commentsCount > 0
							? await fetchIssueComments(config, resource.number ?? 0)
							: undefined;
					await indexResource(source.id, repo.fullName, resource, comments, agentId, syncOpts);
					repoIndexed++;
					await yielder();
				}
				logErrors(source.id, repo.fullName, "issues", result.resources.length, result.errors);
				if (!capped && result.errors.length === 0) completeTypes.add("issues");
			}

			if (settings.resourceTypes.includes("pulls")) {
				const result = await fetchPullRequests(config, undefined, settings.state, settings.maxItemsPerRepo, settings.labels);
				const capped = result.resources.length >= settings.maxItemsPerRepo;
				for (const resource of result.resources) {
					seenKeys.add(resourceKey(resource));
					const comments =
						settings.includeComments && resource.commentsCount > 0
							? await fetchIssueComments(config, resource.number ?? 0)
							: undefined;
					await indexResource(source.id, repo.fullName, resource, comments, agentId, syncOpts);
					repoIndexed++;
					await yielder();
				}
				logErrors(source.id, repo.fullName, "pulls", result.resources.length, result.errors);
				if (!capped && result.errors.length === 0) completeTypes.add("pulls");
			}

			if (settings.resourceTypes.includes("discussions")) {
				const result = await fetchDiscussions(config, undefined, settings.maxItemsPerRepo);
				const capped = result.resources.length >= settings.maxItemsPerRepo;
				const labelSet = settings.labels?.length ? new Set(settings.labels) : null;
				for (const resource of result.resources) {
					if (labelSet && !resource.labels.some((l) => labelSet.has(l))) continue;
					seenKeys.add(resourceKey(resource));
					const rawComments =
						settings.includeComments && resource.commentsCount > 0
							? await fetchDiscussionComments(config, resource.number ?? 0)
							: undefined;
					const comments = rawComments?.map((c) => ({
						author: typeof c.author === "string" ? c.author : c.author?.login ?? null,
						body: c.body,
						createdAt: c.created_at,
					}));
					await indexResource(source.id, repo.fullName, resource, comments, agentId, syncOpts);
					repoIndexed++;
					await yielder();
				}
				logErrors(source.id, repo.fullName, "discussions", result.resources.length, result.errors);
				if (!capped && result.errors.length === 0) completeTypes.add("discussions");
			}

			if (settings.resourceTypes.includes("docs")) {
				const docPaths = settings.docPaths ?? ["README.md", "CHANGELOG.md"];
				const result = await fetchRepoDocs(config, docPaths, repo.defaultBranch);
				for (const resource of result.resources) {
					seenKeys.add(resourceKey(resource));
					await indexResource(source.id, repo.fullName, resource, undefined, agentId, syncOpts);
					repoIndexed++;
					await yielder();
				}
				logErrors(source.id, repo.fullName, "docs", result.resources.length, result.errors);
				if (result.errors.length === 0) completeTypes.add("docs");
			}

			await reconcileStaleResources(source.id, repo.fullName, seenKeys, completeTypes, agentId);
		} catch (err) {
			logger.warn("github-source", "Failed to sync repo", {
				sourceId: source.id,
				repo: repo.fullName,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		logger.info("github-source", "Repo sync complete", {
			sourceId: source.id,
			repo: repo.fullName,
			indexed: repoIndexed,
		});
		totalIndexed += repoIndexed;
	}
	return totalIndexed;
}

async function indexResource(
	sourceId: string,
	repo: string,
	resource: GitHubResource,
	comments: { author: string | null; body: string; createdAt: string }[] | undefined,
	agentId: string,
	options: GitHubSourceBridgeOptions,
): Promise<void> {
	if (options.sourceActiveCheck && !options.sourceActiveCheck()) {
		throw new Error(`Source ${sourceId} removed during sync`);
	}
	indexGitHubSourceStructure({
		agentId,
		sourceId,
		sourceName: repo,
		repo,
		resource,
	});

	if (options.embeddingConfig && options.fetchEmbedding) {
		await indexGitHubSourceEmbeddings({
			agentId,
			sourceId,
			repo,
			resource,
			comments: comments?.map((c) => ({ author: c.author, body: c.body, createdAt: c.createdAt })),
			embeddingConfig: options.embeddingConfig,
			fetchEmbedding: options.fetchEmbedding,
		});
	}
}

async function resolveToken(tokenRef: string, _agentsDir?: string): Promise<string | undefined> {
	try {
		return await getSecret(tokenRef);
	} catch {
		logger.warn("github-source", "Failed to resolve token from secrets", { tokenRef });
	}
	return undefined;
}

function logErrors(
	sourceId: string,
	repo: string,
	type: string,
	count: number,
	errors: readonly { message: string }[],
): void {
	if (errors.length > 0) {
		logger.warn("github-source", `Errors during ${type} fetch`, {
			sourceId,
			repo,
			type,
			fetched: count,
			errors: errors.length,
		});
	}
}

function resourceKey(resource: GitHubResource): string {
	if (resource.type === "doc" && resource.path) return `docs:${resource.path}`;
	return `${resource.type}:${resource.number}`;
}

async function reconcileStaleResources(
	sourceId: string,
	repo: string,
	seenKeys: Set<string>,
	completeTypes: Set<string>,
	agentId: string,
): Promise<void> {
	if (seenKeys.size === 0 || completeTypes.size === 0) return;
	const { purgeGitHubResourceEmbeddings } = await import("./github-source-embeddings");
	const { purgeGitHubResourceStructure } = await import("./github-source-graph");
	const db = getDbAccessor();
	const rows = db.withReadDb((d) =>
		d
			.prepare(
				"SELECT source_path FROM entities WHERE source_id = ? AND agent_id = ? AND entity_type = 'source_document'",
			)
			.all(sourceId, agentId),
	) as Array<{ source_path: string }>;
	let purged = 0;
	for (const row of rows) {
		const sp = row.source_path;
		const key = sp.startsWith("github:") ? sp.slice("github:".length) : sp;
		const repoPrefix = `${repo}:`;
		if (!key.startsWith(repoPrefix)) continue;
		const localKey = key.slice(repoPrefix.length);
		if (seenKeys.has(localKey)) continue;
		const rawType = localKey.split(":")[0] ?? "";
		const isDoc = rawType === "docs";
		const type = isDoc ? "doc" : rawType;
		if (!completeTypes.has(type === "pull" ? "pulls" : type === "issue" ? "issues" : type === "discussion" ? "discussions" : "docs")) continue;
		const numOrPath = localKey.slice(rawType.length + 1);
		const resource: GitHubResource = {
			type: type as GitHubResource["type"],
			number: !isDoc ? Number(numOrPath) || 0 : undefined,
			path: isDoc ? numOrPath : undefined,
			title: "",
			body: "",
			state: "",
			labels: [],
			author: null,
			createdAt: "",
			updatedAt: "",
			closedAt: null,
			mergedAt: null,
			commentsCount: 0,
			extra: {},
		};
		purgeGitHubResourceEmbeddings({ sourceId, repo, agentId, resource });
		purgeGitHubResourceStructure({ sourceId, repo, agentId, resource });
		purged++;
	}
	if (purged > 0) {
		logger.info("github-source", "Reconciled stale resources", { sourceId, repo, purged });
	}
}

export function startGitHubSourceBridge(
	sourcesOrLoader: readonly SignetSourceEntry[] | (() => readonly SignetSourceEntry[]),
	options: GitHubSourceBridgeOptions = {},
): GitHubSourceBridgeHandle {
	const loadSources = typeof sourcesOrLoader === "function" ? sourcesOrLoader : () => sourcesOrLoader;
	const agentId = options.agentId ?? resolveDaemonAgentId();
	let syncInFlight: Promise<number> | null = null;

	const sync = async (): Promise<number> => {
		if (syncInFlight) return syncInFlight;
		syncInFlight = (async () => {
			let total = 0;
			const sources = loadSources();
			for (const source of sources) {
				if (!source.enabled || source.kind !== "github") continue;
				try {
					total += await syncGitHubSource(source, { ...options, agentId });
				} catch (err) {
					logger.warn("github-source", "Source sync failed", {
						sourceId: source.id,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
			return total;
		})().finally(() => {
			syncInFlight = null;
		});
		return syncInFlight;
	};

	const pollIntervalMs = options.pollIntervalMs ?? 300_000;
	const pollTimer =
		pollIntervalMs > 0
			? setInterval(() => {
					sync().catch((err) => {
						logger.warn("github-source", "Polling sync failed", {
							error: err instanceof Error ? err.message : String(err),
						});
					});
				}, pollIntervalMs)
			: null;
	pollTimer?.unref?.();

	return {
		sync,
		async close(): Promise<void> {
			if (pollTimer) clearInterval(pollTimer);
			if (syncInFlight) await syncInFlight.catch(() => 0);
		},
	};
}

export function purgeGitHubSource(sourceId: string, agentId?: string): number {
	const id = agentId ?? resolveDaemonAgentId();
	const embeddings = purgeGitHubSourceEmbeddings({ sourceId, agentId: id });
	const structure = purgeGitHubSourceStructure({ sourceId, agentId: id });
	return embeddings + structure;
}
