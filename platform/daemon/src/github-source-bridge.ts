import type { GitHubSourceSettings, SignetSourceEntry } from "@signet/core";
import { parseGitHubSettings } from "@signet/core";
import { resolveDaemonAgentId } from "./agent-id";
import { yieldEvery } from "./async-yield";
import { getDbAccessor } from "./db-accessor";
import { indexGitHubSourceEmbeddings, purgeGitHubSourceEmbeddings } from "./github-source-embeddings";
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
import { logger } from "./logger";
import type { EmbeddingConfig } from "./memory-config";
import type { SourceEmbeddingFetch } from "./obsidian-source-embeddings";

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
}

interface ResolvedRepo {
	readonly owner: string;
	readonly repo: string;
	readonly fullName: string;
	readonly defaultBranch: string;
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

	for (const repo of repos) {
		const config: GitHubFetchConfig = { owner: repo.owner, repo: repo.repo, token };
		const yielder = yieldEvery(5);
		let repoIndexed = 0;

		try {
			if (settings.resourceTypes.includes("issues")) {
				const result = await fetchIssues(config, undefined, settings.state, settings.maxItemsPerRepo);
				for (const resource of result.resources) {
					const comments =
						settings.includeComments && resource.commentsCount > 0
							? await fetchIssueComments(config, resource.number ?? 0)
							: undefined;
					await indexResource(source.id, repo.fullName, resource, comments, agentId, options);
					repoIndexed++;
					await yielder();
				}
				logErrors(source.id, repo.fullName, "issues", result.resources.length, []);
			}

			if (settings.resourceTypes.includes("pulls")) {
				const result = await fetchPullRequests(config, undefined, settings.state, settings.maxItemsPerRepo);
				for (const resource of result.resources) {
					const comments =
						settings.includeComments && resource.commentsCount > 0
							? await fetchIssueComments(config, resource.number ?? 0)
							: undefined;
					await indexResource(source.id, repo.fullName, resource, comments, agentId, options);
					repoIndexed++;
					await yielder();
				}
				logErrors(source.id, repo.fullName, "pulls", result.resources.length, []);
			}

			if (settings.resourceTypes.includes("discussions")) {
				const result = await fetchDiscussions(config, undefined, settings.maxItemsPerRepo);
				for (const resource of result.resources) {
					const comments =
						settings.includeComments && resource.commentsCount > 0
							? await fetchDiscussionComments(config, resource.number ?? 0)
							: undefined;
					await indexResource(source.id, repo.fullName, resource, comments, agentId, options);
					repoIndexed++;
					await yielder();
				}
				logErrors(source.id, repo.fullName, "discussions", result.resources.length, []);
			}

			if (settings.resourceTypes.includes("docs")) {
				const docPaths = settings.docPaths ?? ["README.md", "CHANGELOG.md"];
				const result = await fetchRepoDocs(config, docPaths, repo.defaultBranch);
				for (const resource of result.resources) {
					await indexResource(source.id, repo.fullName, resource, undefined, agentId, options);
					repoIndexed++;
					await yielder();
				}
				logErrors(source.id, repo.fullName, "docs", result.resources.length, []);
			}
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

async function resolveToken(tokenRef: string, agentsDir?: string): Promise<string | undefined> {
	try {
		const dir = agentsDir ?? process.env.SIGNET_PATH ?? `${require("node:os").homedir()}/.agents`;
		const response = await fetch(`http://localhost:3850/api/secrets/${encodeURIComponent(tokenRef)}`, {
			headers: { "Content-Type": "application/json" },
		});
		if (response.status === 200) {
			const data = (await response.json()) as { value?: string };
			return data.value;
		}
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

export function startGitHubSourceBridge(
	sources: readonly SignetSourceEntry[],
	options: GitHubSourceBridgeOptions = {},
): GitHubSourceBridgeHandle {
	const agentId = options.agentId ?? resolveDaemonAgentId();
	let syncInFlight: Promise<number> | null = null;

	const sync = async (): Promise<number> => {
		if (syncInFlight) return syncInFlight;
		syncInFlight = (async () => {
			let total = 0;
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

export function purgeGitHubSource(sourceId: string, agentId?: string): void {
	purgeGitHubSourceEmbeddings({ sourceId, agentId: agentId ?? resolveDaemonAgentId() });
	purgeGitHubSourceStructure({ sourceId, agentId });
}
