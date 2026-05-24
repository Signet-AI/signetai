import { createHash } from "node:crypto";
import {
	type GitHubSourceSettings,
	type SignetSourceEntry,
	type SourceFailureState,
	type SourceProviderKind,
	parseGitHubSettings,
} from "@signet/core";
import { resolveDaemonAgentId } from "./agent-id";
import { yieldEvery } from "./async-yield";
import { getDbAccessor } from "./db-accessor";
import { countChanges } from "./db-helpers";
import {
	type GitHubComment,
	type GitHubFetchConfig,
	type GitHubResource,
	expandRepoGlob,
	fetchDiscussionComments,
	fetchDiscussions,
	fetchIssueComments,
	fetchIssues,
	fetchPullRequestComments,
	fetchPullRequests,
	fetchPullRequestsBySearch,
	fetchRepoDocs,
	fetchRepoInfo,
	logGitHubFetchError,
} from "./github-source-fetch";
import { logger } from "./logger";
import { indexExternalMemoryArtifact } from "./memory-lineage";
import { getSecret } from "./secrets";
import type { SourceProviderAdapter, SourceProviderSyncContext, SourceProviderSyncResult } from "./source-providers";
import { purgeSourceOwnedRows } from "./source-purge";

const GITHUB_PROVIDER_KIND: SourceProviderKind = "github";
const GITHUB_HARNESS = "github";

interface ResolvedRepo {
	readonly owner: string;
	readonly repo: string;
	readonly fullName: string;
	readonly defaultBranch: string;
}

interface WrittenGitHubArtifacts {
	readonly count: number;
	readonly paths: readonly string[];
}

export const githubSourceProvider: SourceProviderAdapter = {
	kind: "github",
	sync: syncGitHubSource,
	purge: (source, agentId) => purgeSourceOwnedRows({ sourceId: source.id, agentId }),
};

async function syncGitHubSource(context: SourceProviderSyncContext): Promise<SourceProviderSyncResult> {
	const settings = parseGitHubSettings(context.source.providerSettings);
	if (settings.repos.length === 0) throw new Error("GitHub source has no repositories");

	const failures: SourceFailureState[] = [];
	const syncStartedAt = new Date().toISOString();
	const agentId = context.agentId || resolveDaemonAgentId();
	const token = settings.tokenRef ? await resolveToken(settings.tokenRef) : undefined;
	const repos = await resolveRepos(context.source, settings, failures, token);
	let indexed = 0;
	let scanned = 0;

	for (const repo of repos) {
		if (!context.shouldContinue()) break;
		const failureCountBeforeRepo = failures.length;
		context.onProgress?.({ scanned, total: repos.length, indexed, currentPath: `github://${repo.fullName}` });
		const config: GitHubFetchConfig = { owner: repo.owner, repo: repo.repo, token };
		const seenPaths = new Set<string>();
		const yielder = yieldEvery(5);
		let repoIndexed = 0;

		for (const resource of await fetchRepoResources(context.source, settings, config, repo, failures)) {
			if (!context.shouldContinue()) break;
			if (repoIndexed >= settings.maxItemsPerRepo) break;
			const written = await writeResourceWithComments(
				context.source,
				agentId,
				repo.fullName,
				config,
				resource,
				settings,
				failures,
				settings.maxItemsPerRepo - repoIndexed,
			);
			repoIndexed += written.count;
			indexed += written.count;
			for (const path of written.paths) {
				seenPaths.add(path);
			}
			await yielder();
		}
		scanned++;
		context.onProgress?.({ scanned, total: repos.length, indexed, currentPath: `github://${repo.fullName}` });
		if (failures.length === failureCountBeforeRepo)
			purgeStaleGitHubArtifacts(context.source.id, agentId, syncStartedAt, seenPaths, repo.fullName);
	}
	if (context.shouldContinue()) purgeStaleGitHubFailureArtifacts(context.source.id, agentId, syncStartedAt);
	for (const failure of failures) {
		indexed += writeFailureArtifact(context.source, agentId, failure);
	}

	return { indexed, scanned, total: repos.length, failures };
}

async function fetchRepoResources(
	source: SignetSourceEntry,
	settings: GitHubSourceSettings,
	config: GitHubFetchConfig,
	repo: ResolvedRepo,
	failures: SourceFailureState[],
): Promise<readonly GitHubResource[]> {
	const resources: GitHubResource[] = [];
	if (settings.resourceTypes.includes("issues") && hasResourceBudget(resources, settings)) {
		const result = await fetchIssues(
			config,
			undefined,
			settings.state,
			remainingResourceBudget(resources, settings),
			settings.labels,
		);
		resources.push(...result.resources);
		writeFetchFailures(source, failures, repo.fullName, "issues", result.errors);
	}
	if (settings.resourceTypes.includes("pulls") && hasResourceBudget(resources, settings)) {
		const result = settings.labels?.length
			? await fetchPullRequestsBySearch(
					config,
					settings.labels,
					undefined,
					settings.state,
					remainingResourceBudget(resources, settings),
				)
			: await fetchPullRequests(config, undefined, settings.state, remainingResourceBudget(resources, settings));
		resources.push(...result.resources);
		writeFetchFailures(source, failures, repo.fullName, "pulls", result.errors);
	}
	if (settings.resourceTypes.includes("discussions") && hasResourceBudget(resources, settings)) {
		if (!config.token) {
			const failure = failureState(source, "GitHub discussions require tokenRef", {
				repo: repo.fullName,
				phase: "discussions",
			});
			failures.push(failure);
		} else {
			const result = await fetchDiscussions(
				config,
				undefined,
				settings.state,
				remainingResourceBudget(resources, settings),
			);
			const labelSet = settings.labels?.length ? new Set(settings.labels) : null;
			resources.push(
				...result.resources.filter((resource) => !labelSet || resource.labels.some((label) => labelSet.has(label))),
			);
			writeFetchFailures(source, failures, repo.fullName, "discussions", result.errors);
		}
	}
	if (settings.resourceTypes.includes("docs") && hasResourceBudget(resources, settings)) {
		const result = await fetchRepoDocs(
			config,
			settings.docPaths,
			repo.defaultBranch,
			remainingResourceBudget(resources, settings),
		);
		resources.push(...result.resources);
		writeFetchFailures(source, failures, repo.fullName, "docs", result.errors);
	}
	return resources;
}

function hasResourceBudget(resources: readonly GitHubResource[], settings: GitHubSourceSettings): boolean {
	return remainingResourceBudget(resources, settings) > 0;
}

function remainingResourceBudget(resources: readonly GitHubResource[], settings: GitHubSourceSettings): number {
	return Math.max(0, settings.maxItemsPerRepo - resources.length);
}

async function writeResourceWithComments(
	source: SignetSourceEntry,
	agentId: string,
	repo: string,
	config: GitHubFetchConfig,
	resource: GitHubResource,
	settings: GitHubSourceSettings,
	failures: SourceFailureState[],
	remainingArtifactBudget: number,
): Promise<WrittenGitHubArtifacts> {
	if (remainingArtifactBudget <= 0) return { count: 0, paths: [] };
	const paths = [writeResourceArtifact(source, agentId, repo, resource)];
	const remainingCommentBudget = remainingArtifactBudget - paths.length;
	if (
		!settings.includeComments ||
		resource.commentsCount <= 0 ||
		resource.type === "doc" ||
		remainingCommentBudget <= 0
	) {
		return { count: paths.length, paths };
	}
	try {
		const comments = await fetchCommentsForResource(config, resource);
		for (const comment of comments.slice(0, remainingCommentBudget)) {
			paths.push(writeCommentArtifact(source, agentId, repo, resource, comment));
		}
	} catch (err) {
		logGitHubFetchError(source.id, repo, `${resource.type}_comments`, err);
		failures.push(
			failureState(source, `GitHub ${resource.type} comment fetch failed: ${errorMessage(err)}`, {
				repo,
				type: resource.type,
				number: resource.number,
				path: resource.path,
			}),
		);
	}
	return { count: paths.length, paths };
}

async function fetchCommentsForResource(
	config: GitHubFetchConfig,
	resource: GitHubResource,
): Promise<readonly GitHubComment[]> {
	if (!resource.number) return [];
	if (resource.type === "issue") return fetchIssueComments(config, resource.number);
	if (resource.type === "pull") {
		const issueComments = await fetchIssueComments(config, resource.number);
		const reviewComments = await fetchPullRequestComments(config, resource.number);
		return [...issueComments, ...reviewComments];
	}
	if (resource.type === "discussion") return fetchDiscussionComments(config, resource.number);
	return [];
}

function writeResourceArtifact(
	source: SignetSourceEntry,
	agentId: string,
	repo: string,
	resource: GitHubResource,
): string {
	const path = resourcePath(repo, resource);
	indexExternalMemoryArtifact({
		agentId,
		harness: GITHUB_HARNESS,
		sourceId: source.id,
		sourceRoot: source.root,
		sourceExternalId: resourceExternalId(repo, resource),
		sourceParentPath: `github://${repo}`,
		sourcePath: path,
		sourceKind: `source_github_${resource.type}`,
		sourceMtimeMs: Date.parse(resource.updatedAt) || Date.now(),
		capturedAt: resource.updatedAt,
		content: resourceContent(repo, resource),
		sourceMeta: {
			provider: GITHUB_PROVIDER_KIND,
			repo,
			type: resource.type,
			number: resource.number,
			path: resource.path,
			url: resource.url,
			state: resource.state,
			labels: resource.labels,
			author: resource.author,
			createdAt: resource.createdAt,
			closedAt: resource.closedAt,
			mergedAt: resource.mergedAt,
			commentsCount: resource.commentsCount,
			...resource.extra,
		},
	});
	return path;
}

function writeCommentArtifact(
	source: SignetSourceEntry,
	agentId: string,
	repo: string,
	resource: GitHubResource,
	comment: GitHubComment,
): string {
	const author =
		typeof comment.author === "string" ? comment.author : (comment.author?.login ?? comment.user?.login ?? null);
	const commentId = String(comment.id);
	const path = `${resourcePath(repo, resource)}#comment-${commentId}`;
	indexExternalMemoryArtifact({
		agentId,
		harness: GITHUB_HARNESS,
		sourceId: source.id,
		sourceRoot: source.root,
		sourceExternalId: `${resourceExternalId(repo, resource)}#comment:${commentId}`,
		sourceParentPath: resourcePath(repo, resource),
		sourcePath: path,
		sourceKind: "source_github_comment",
		sourceMtimeMs: Date.parse(comment.updated_at) || Date.now(),
		capturedAt: comment.updated_at,
		content: [`# Comment on ${resource.title}`, "", `Author: ${author ?? "unknown"}`, "", comment.body].join("\n"),
		sourceMeta: {
			provider: GITHUB_PROVIDER_KIND,
			repo,
			parentType: resource.type,
			parentNumber: resource.number,
			parentPath: resource.path,
			commentId,
			author,
			createdAt: comment.created_at,
			updatedAt: comment.updated_at,
		},
	});
	return path;
}

function writeFetchFailures(
	source: SignetSourceEntry,
	failures: SourceFailureState[],
	repo: string,
	phase: string,
	errors: readonly { readonly message: string; readonly retryable: boolean }[],
): void {
	for (const error of errors) {
		failures.push(failureState(source, error.message, { repo, phase, retryable: error.retryable }));
	}
}

function writeFailureArtifact(source: SignetSourceEntry, agentId: string, failure: SourceFailureState): number {
	indexExternalMemoryArtifact({
		agentId,
		harness: GITHUB_HARNESS,
		sourceId: source.id,
		sourceRoot: source.root,
		sourceExternalId: `failure:${failure.failedAt}:${failure.message}`,
		sourcePath: failureArtifactPath(source, failure),
		sourceKind: "source_github_failure",
		sourceMtimeMs: Date.parse(failure.failedAt) || Date.now(),
		capturedAt: failure.failedAt,
		content: failure.message,
		sourceMeta: failure.metadata,
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
	return `github://source/${source.id}/failures/${encodeURIComponent(failure.failedAt)}-${fingerprint}`;
}

async function resolveRepos(
	source: SignetSourceEntry,
	settings: GitHubSourceSettings,
	failures: SourceFailureState[],
	token?: string,
): Promise<ResolvedRepo[]> {
	const resolved: ResolvedRepo[] = [];
	for (const pattern of settings.repos) {
		const [owner, repoPart] = pattern.split("/");
		if (!owner || !repoPart) continue;
		if (repoPart.includes("*")) {
			const expanded = await expandRepoGlob(owner, repoPart, token, settings.maxItemsPerRepo);
			if (expanded.repos.length === 0) {
				failures.push(
					failureState(source, `GitHub wildcard repo pattern matched no repositories: ${pattern}`, {
						owner,
						pattern,
						phase: "repo_expansion",
					}),
				);
			}
			if (expanded.truncated) {
				logger.warn("github-source", "Wildcard repo source expansion hit configured cap", {
					owner,
					pattern: repoPart,
					limit: settings.maxItemsPerRepo,
				});
			}
			for (const fullName of expanded.repos) {
				const [expandedOwner, expandedRepo] = fullName.split("/");
				if (expandedOwner && expandedRepo) {
					resolved.push({ owner: expandedOwner, repo: expandedRepo, fullName, defaultBranch: "main" });
				}
			}
		} else {
			resolved.push({ owner, repo: repoPart, fullName: `${owner}/${repoPart}`, defaultBranch: "main" });
		}
	}
	const withDefaultBranches: ResolvedRepo[] = [];
	for (const repo of resolved) {
		const info = await fetchRepoInfo({ owner: repo.owner, repo: repo.repo, token }).catch(() => null);
		withDefaultBranches.push({ ...repo, defaultBranch: info?.defaultBranch ?? repo.defaultBranch });
	}
	return withDefaultBranches;
}

async function resolveToken(tokenRef: string): Promise<string> {
	try {
		return await getSecret(tokenRef);
	} catch (err) {
		throw new Error(`Failed to resolve GitHub token ref '${tokenRef}': ${errorMessage(err)}`);
	}
}

function failureState(
	source: SignetSourceEntry,
	message: string,
	metadata?: Readonly<Record<string, unknown>>,
): SourceFailureState {
	return {
		sourceId: source.id,
		providerKind: GITHUB_PROVIDER_KIND,
		failedAt: new Date().toISOString(),
		recoverable: true,
		message,
		metadata,
	};
}

function purgeStaleGitHubArtifacts(
	sourceId: string,
	agentId: string,
	syncStartedAt: string,
	seenPaths: ReadonlySet<string>,
	repo: string,
): void {
	const repoPathPrefix = `github://${repo}/`;
	getDbAccessor().withWriteTx((db) => {
		const rows = db
			.prepare(
				`SELECT rowid, source_path FROM memory_artifacts
				 WHERE agent_id = ?
				   AND source_id = ?
				   AND source_path >= ?
				   AND source_path < ?
				   AND updated_at < ?
				   AND COALESCE(is_deleted, 0) = 0`,
			)
			.all(agentId, sourceId, repoPathPrefix, `${repoPathPrefix}\uffff`, syncStartedAt) as Array<{
			rowid: number;
			source_path: string;
		}>;
		for (const row of rows) {
			if (seenPaths.has(row.source_path)) continue;
			countChanges(
				db
					.prepare("UPDATE memory_artifacts SET is_deleted = 1, updated_at = ? WHERE rowid = ?")
					.run(syncStartedAt, row.rowid),
			);
		}
	});
}

function purgeStaleGitHubFailureArtifacts(sourceId: string, agentId: string, syncStartedAt: string): void {
	getDbAccessor().withWriteTx((db) => {
		countChanges(
			db
				.prepare(
					`UPDATE memory_artifacts
					 SET is_deleted = 1, updated_at = ?
					 WHERE agent_id = ?
					   AND source_id = ?
					   AND source_kind = 'source_github_failure'
					   AND source_path >= ?
					   AND source_path < ?
					   AND COALESCE(is_deleted, 0) = 0`,
				)
				.run(
					syncStartedAt,
					agentId,
					sourceId,
					`github://source/${sourceId}/failures/`,
					`github://source/${sourceId}/failures/\uffff`,
				),
		);
	});
}

function resourceExternalId(repo: string, resource: GitHubResource): string {
	if (resource.type === "doc") return `${repo}:docs:${resource.path ?? ""}`;
	return `${repo}:${resource.type}:${resource.number ?? 0}`;
}

function resourcePath(repo: string, resource: GitHubResource): string {
	if (resource.type === "doc") return `github://${repo}/docs/${resource.path ?? ""}`;
	return `github://${repo}/${resource.type}s/${resource.number ?? 0}`;
}

function resourceContent(repo: string, resource: GitHubResource): string {
	const title =
		resource.type === "doc" ? resource.title : `${repo} ${resource.type} #${resource.number}: ${resource.title}`;
	return [
		`# ${title}`,
		"",
		`URL: ${resource.url || `https://github.com/${repo}`}`,
		`State: ${resource.state}`,
		resource.author ? `Author: ${resource.author}` : undefined,
		resource.labels.length > 0 ? `Labels: ${resource.labels.join(", ")}` : undefined,
		"",
		resource.body,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
