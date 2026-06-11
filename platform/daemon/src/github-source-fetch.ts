import type { GitHubSourceState } from "@signetai/core";
import { logger } from "./logger";

export interface GitHubFetchConfig {
	readonly token?: string;
	readonly owner: string;
	readonly repo: string;
}

export interface GitHubLabel {
	readonly name: string;
	readonly color?: string;
}

export interface GitHubIssue {
	readonly number: number;
	readonly title: string;
	readonly body: string | null;
	readonly state: string;
	readonly html_url: string;
	readonly user: { readonly login: string } | null;
	readonly labels: readonly GitHubLabel[];
	readonly created_at: string;
	readonly updated_at: string;
	readonly closed_at: string | null;
	readonly pull_request?: { readonly url: string };
	readonly comments: number;
}

export interface GitHubPullRequest {
	readonly number: number;
	readonly title: string;
	readonly body: string | null;
	readonly state: string;
	readonly html_url: string;
	readonly user: { readonly login: string } | null;
	readonly labels?: readonly GitHubLabel[];
	readonly created_at: string;
	readonly updated_at: string;
	readonly closed_at: string | null;
	readonly merged_at: string | null;
	readonly draft: boolean;
	readonly base: { readonly ref: string };
	readonly head: { readonly ref: string };
	readonly comments?: number;
	readonly review_comments?: number;
}

export interface GitHubComment {
	readonly id: number | string;
	readonly body: string;
	readonly user?: { readonly login?: string } | null;
	readonly author?: { readonly login?: string } | string | null;
	readonly created_at: string;
	readonly updated_at: string;
}

export interface GitHubResource {
	readonly type: "issue" | "pull" | "discussion" | "doc";
	readonly number?: number;
	readonly path?: string;
	readonly title: string;
	readonly body: string;
	readonly state: string;
	readonly url: string;
	readonly labels: readonly string[];
	readonly author: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly closedAt: string | null;
	readonly mergedAt: string | null;
	readonly commentsCount: number;
	readonly extra: Readonly<Record<string, unknown>>;
}

export interface GitHubFetchResult {
	readonly resources: readonly GitHubResource[];
	readonly errors: readonly { readonly message: string; readonly retryable: boolean }[];
}

export interface GitHubRepoInfo {
	readonly owner: string;
	readonly repo: string;
	readonly fullName: string;
	readonly defaultBranch: string;
	readonly htmlUrl: string;
}

export interface RepoGlobExpansion {
	readonly repos: readonly string[];
	readonly truncated: boolean;
}

interface GitHubApiResponse {
	readonly status: number;
	readonly headers: Headers;
	readonly body: unknown;
}

const GITHUB_API_BASE = "https://api.github.com";
const GRAPHQL_URL = "https://api.github.com/graphql";
const PER_PAGE = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const MAX_FILTERED_SCAN_MULTIPLIER = 5;
const MAX_FILTERED_SCAN_FLOOR = PER_PAGE * 5;
const MAX_FILTERED_SCAN_CEILING = PER_PAGE * 20;
const MAX_COMMENTS_PER_RESOURCE = 200;

async function githubRequest(url: string, token?: string, method = "GET", body?: unknown): Promise<GitHubApiResponse> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github.v3+json",
		"User-Agent": "signet-daemon",
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	if (body) headers["Content-Type"] = "application/json";

	let lastError: Error | null = null;
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		const controller = new AbortController();
		let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(url, {
				method,
				headers,
				body: body ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});
			clearTimeout(timeout);
			timeout = null;
			const remaining = Number(response.headers.get("x-ratelimit-remaining") ?? "5000");
			const reset = Number(response.headers.get("x-ratelimit-reset") ?? "0") * 1000;
			if (remaining < 10 && reset > Date.now()) {
				await new Promise((resolve) => setTimeout(resolve, Math.min(reset - Date.now() + 1000, 60_000)));
			}
			if (response.status === 403 && remaining === 0 && reset > Date.now()) {
				await new Promise((resolve) => setTimeout(resolve, Math.min(reset - Date.now() + 1000, 60_000)));
				continue;
			}
			if (response.status >= 500) {
				lastError = new Error(`GitHub API ${response.status}: ${await response.text()}`);
				await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * (attempt + 1)));
				continue;
			}
			return {
				status: response.status,
				headers: response.headers,
				body: response.status === 204 ? null : await response.json(),
			};
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt < MAX_RETRIES - 1) {
				await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * (attempt + 1)));
			}
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}
	throw lastError ?? new Error("GitHub API request failed after retries");
}

export async function fetchRepoInfo(config: GitHubFetchConfig): Promise<GitHubRepoInfo | null> {
	const response = await githubRequest(`${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}`, config.token);
	if (response.status === 404) return null;
	if (response.status !== 200) throw new Error(`Failed to fetch repo info: ${response.status}`);
	const data = response.body as Record<string, unknown>;
	return {
		owner: ((data.owner as Record<string, unknown> | undefined)?.login as string | undefined) ?? config.owner,
		repo: (data.name as string | undefined) ?? config.repo,
		fullName: (data.full_name as string | undefined) ?? `${config.owner}/${config.repo}`,
		defaultBranch: (data.default_branch as string | undefined) ?? "main",
		htmlUrl: (data.html_url as string | undefined) ?? `https://github.com/${config.owner}/${config.repo}`,
	};
}

export async function expandRepoGlob(
	owner: string,
	pattern: string,
	token?: string,
	maxRepos = 500,
): Promise<RepoGlobExpansion> {
	if (!pattern.includes("*")) return { repos: [`${owner}/${pattern}`], truncated: false };
	const regex = new RegExp(`^${globToRegexSource(pattern)}$`);
	for (const prefix of [`/orgs/${owner}/repos`, `/users/${owner}/repos`]) {
		const repos: Array<{ full_name: string; name: string }> = [];
		let page = 1;
		let truncated = false;
		while (repos.length < maxRepos) {
			const remaining = Math.max(1, maxRepos - repos.length);
			const response = await githubRequest(
				`${GITHUB_API_BASE}${prefix}?per_page=${Math.min(PER_PAGE, remaining)}&page=${page}&type=all`,
				token,
			);
			if (response.status !== 200) break;
			const batch = response.body as Array<{ full_name: string; name: string }>;
			repos.push(...batch);
			if (repos.length >= maxRepos) truncated = batch.length === Math.min(PER_PAGE, remaining);
			if (batch.length < Math.min(PER_PAGE, remaining)) break;
			page++;
		}
		const matches = repos.filter((repo) => regex.test(repo.name)).map((repo) => repo.full_name);
		if (matches.length > 0 || truncated) return { repos: matches.slice(0, maxRepos), truncated };
	}
	return { repos: [], truncated: false };
}

export async function fetchIssues(
	config: GitHubFetchConfig,
	since?: string,
	state: GitHubSourceState = "all",
	maxItems = 500,
	labels?: readonly string[],
): Promise<GitHubFetchResult> {
	const resources: GitHubResource[] = [];
	const errors: GitHubFetchResult["errors"] = [];
	const scanLimit = Math.min(
		Math.max(maxItems * MAX_FILTERED_SCAN_MULTIPLIER, MAX_FILTERED_SCAN_FLOOR),
		MAX_FILTERED_SCAN_CEILING,
	);
	let scanned = 0;
	let page = 1;
	while (resources.length < maxItems && scanned < scanLimit) {
		const remainingScan = scanLimit - scanned;
		const url = new URL(`${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/issues`);
		url.searchParams.set("state", state === "all" ? "all" : state);
		url.searchParams.set("per_page", String(Math.min(PER_PAGE, remainingScan)));
		url.searchParams.set("page", String(page));
		url.searchParams.set("sort", "updated");
		url.searchParams.set("direction", "desc");
		if (since) url.searchParams.set("since", since);
		if (labels?.length) url.searchParams.set("labels", labels.join(","));
		const response = await githubRequest(url.toString(), config.token);
		if (response.status !== 200) {
			errors.push({ message: `Issues fetch failed: ${response.status}`, retryable: response.status >= 500 });
			break;
		}
		const batch = response.body as GitHubIssue[];
		scanned += batch.length;
		for (const issue of batch) {
			if (resources.length >= maxItems) break;
			if (issue.pull_request) continue;
			resources.push(issueResource(issue));
		}
		if (batch.length < Math.min(PER_PAGE, remainingScan)) break;
		page++;
	}
	return { resources, errors };
}

export async function fetchPullRequests(
	config: GitHubFetchConfig,
	_since?: string,
	state: GitHubSourceState = "all",
	maxItems = 500,
): Promise<GitHubFetchResult> {
	const resources: GitHubResource[] = [];
	const errors: GitHubFetchResult["errors"] = [];
	let page = 1;
	while (resources.length < maxItems) {
		const url = new URL(`${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/pulls`);
		url.searchParams.set("state", state === "all" ? "all" : state);
		url.searchParams.set("per_page", String(Math.min(PER_PAGE, maxItems - resources.length)));
		url.searchParams.set("page", String(page));
		const response = await githubRequest(url.toString(), config.token);
		if (response.status !== 200) {
			errors.push({ message: `Pull requests fetch failed: ${response.status}`, retryable: response.status >= 500 });
			break;
		}
		const batch = response.body as GitHubPullRequest[];
		resources.push(...batch.map(pullResource));
		if (batch.length < Math.min(PER_PAGE, maxItems - resources.length + batch.length)) break;
		page++;
	}
	return { resources: resources.slice(0, maxItems), errors };
}

export async function fetchPullRequestsBySearch(
	config: GitHubFetchConfig,
	labels: readonly string[],
	_since?: string,
	state: GitHubSourceState = "all",
	maxItems = 500,
): Promise<GitHubFetchResult> {
	const resources: GitHubResource[] = [];
	const errors: GitHubFetchResult["errors"] = [];
	const statePart = state === "all" ? "" : ` state:${state}`;
	const labelPart = labels.map((label) => ` label:${quoteSearchValue(label)}`).join("");
	const q = `repo:${config.owner}/${config.repo} is:pr${statePart}${labelPart}`;
	let page = 1;
	while (resources.length < maxItems) {
		const remaining = maxItems - resources.length;
		const response = await githubRequest(
			`${GITHUB_API_BASE}/search/issues?q=${encodeURIComponent(q)}&per_page=${Math.min(PER_PAGE, remaining)}&page=${page}`,
			config.token,
		);
		if (response.status !== 200) {
			errors.push({ message: `Pull request search failed: ${response.status}`, retryable: false });
			break;
		}
		const body = response.body as { items?: GitHubIssue[]; incomplete_results?: boolean };
		const batch = body.items ?? [];
		for (const issue of batch) {
			if (resources.length >= maxItems) break;
			const pull = await fetchPullRequestDetail(config, issue.number);
			if (pull) {
				resources.push(pullResource({ ...pull, labels: issue.labels }));
			} else {
				errors.push({
					message: `Pull request detail fetch failed for #${issue.number}`,
					retryable: true,
				});
				resources.push(searchPullResource(issue));
			}
		}
		if (body.incomplete_results) {
			errors.push({ message: "Pull request search returned incomplete GitHub results", retryable: true });
		}
		if (batch.length < Math.min(PER_PAGE, remaining)) break;
		page++;
	}
	return { resources: resources.slice(0, maxItems), errors };
}

async function fetchPullRequestDetail(
	config: GitHubFetchConfig,
	number: number,
): Promise<GitHubPullRequest | undefined> {
	const response = await githubRequest(
		`${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/pulls/${number}`,
		config.token,
	);
	if (response.status !== 200) return undefined;
	return response.body as GitHubPullRequest;
}

export async function fetchIssueComments(config: GitHubFetchConfig, number: number): Promise<GitHubComment[]> {
	return fetchComments(
		`${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/issues/${number}/comments`,
		config.token,
	);
}

export async function fetchPullRequestComments(config: GitHubFetchConfig, number: number): Promise<GitHubComment[]> {
	return fetchComments(
		`${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/pulls/${number}/comments`,
		config.token,
	);
}

async function fetchComments(baseUrl: string, token?: string): Promise<GitHubComment[]> {
	const comments: GitHubComment[] = [];
	let page = 1;
	while (comments.length < MAX_COMMENTS_PER_RESOURCE) {
		const response = await githubRequest(
			`${baseUrl}?per_page=${Math.min(PER_PAGE, MAX_COMMENTS_PER_RESOURCE - comments.length)}&page=${page}`,
			token,
		);
		if (response.status !== 200) throw new Error(`GitHub comments fetch failed: ${response.status}`);
		const batch = response.body as GitHubComment[];
		comments.push(...batch);
		if (batch.length < Math.min(PER_PAGE, MAX_COMMENTS_PER_RESOURCE - comments.length + batch.length)) break;
		page++;
	}
	return comments.slice(0, MAX_COMMENTS_PER_RESOURCE);
}

export async function fetchDiscussions(
	config: GitHubFetchConfig,
	_after?: string,
	state: GitHubSourceState = "all",
	maxItems = 500,
): Promise<GitHubFetchResult> {
	const resources: GitHubResource[] = [];
	const errors: GitHubFetchResult["errors"] = [];
	const scanLimit = Math.min(
		Math.max(maxItems * MAX_FILTERED_SCAN_MULTIPLIER, MAX_FILTERED_SCAN_FLOOR),
		MAX_FILTERED_SCAN_CEILING,
	);
	const query = `
		query($owner:String!, $name:String!, $first:Int!, $after:String) {
			repository(owner:$owner, name:$name) {
				discussions(first:$first, after:$after, orderBy:{field:UPDATED_AT, direction:DESC}) {
					nodes {
						number title body url closed createdAt updatedAt
						author { login }
						labels(first:20) { nodes { name } }
						comments { totalCount }
					}
					pageInfo { hasNextPage endCursor }
				}
			}
	}`;
	let cursor: string | null = null;
	let scanned = 0;
	while (resources.length < maxItems && scanned < scanLimit) {
		const remainingScan = scanLimit - scanned;
		const response = await githubRequest(GRAPHQL_URL, config.token, "POST", {
			query,
			variables: {
				owner: config.owner,
				name: config.repo,
				first: Math.min(remainingScan, PER_PAGE),
				after: cursor,
			},
		});
		if (response.status !== 200) {
			errors.push({ message: `Discussions fetch failed: ${response.status}`, retryable: false });
			break;
		}
		const data = response.body as {
			data?: {
				repository?: {
					discussions?: { nodes?: DiscussionNode[]; pageInfo?: DiscussionPageInfo };
				};
			};
			errors?: Array<{ message?: string }>;
		};
		if (data.errors?.length) {
			errors.push(...data.errors.map((error) => ({ message: error.message ?? "GraphQL error", retryable: false })));
			break;
		}
		const discussions = data.data?.repository?.discussions;
		const nodes = discussions?.nodes ?? [];
		scanned += nodes.length;
		for (const resource of nodes.map(discussionResource)) {
			if (resources.length >= maxItems) break;
			if (state === "all" || resource.state === state) resources.push(resource);
		}
		if (nodes.length === 0) break;
		if (!discussions?.pageInfo?.hasNextPage) break;
		cursor = discussions.pageInfo.endCursor ?? null;
		if (!cursor) break;
	}
	return { resources, errors };
}

export async function fetchDiscussionComments(config: GitHubFetchConfig, number: number): Promise<GitHubComment[]> {
	const query = `
		query($owner:String!, $name:String!, $number:Int!, $first:Int!, $after:String) {
			repository(owner:$owner, name:$name) {
				discussion(number:$number) {
					comments(first:$first, after:$after) {
						nodes { id body createdAt updatedAt author { login } }
						pageInfo { hasNextPage endCursor }
					}
				}
			}
	}`;
	const comments: GitHubComment[] = [];
	let cursor: string | null = null;
	while (comments.length < MAX_COMMENTS_PER_RESOURCE) {
		const response = await githubRequest(GRAPHQL_URL, config.token, "POST", {
			query,
			variables: {
				owner: config.owner,
				name: config.repo,
				number,
				first: Math.min(PER_PAGE, MAX_COMMENTS_PER_RESOURCE - comments.length),
				after: cursor,
			},
		});
		if (response.status !== 200) throw new Error(`Discussion comments fetch failed: ${response.status}`);
		const body = response.body as {
			data?: {
				repository?: { discussion?: { comments?: { nodes?: DiscussionCommentNode[]; pageInfo?: DiscussionPageInfo } } };
			};
			errors?: Array<{ message?: string }>;
		};
		if (body.errors?.length) {
			throw new Error(
				`Discussion comments GraphQL error: ${body.errors.map((error) => error.message ?? "GraphQL error").join("; ")}`,
			);
		}
		const discussionComments = body.data?.repository?.discussion?.comments;
		const nodes = discussionComments?.nodes ?? [];
		comments.push(
			...nodes.map((node) => ({
				id: node.id,
				body: node.body,
				author: node.author,
				user: node.author,
				created_at: node.createdAt,
				updated_at: node.updatedAt,
			})),
		);
		if (nodes.length === 0) break;
		if (!discussionComments?.pageInfo?.hasNextPage) break;
		cursor = discussionComments.pageInfo.endCursor ?? null;
		if (!cursor) break;
	}
	return comments.slice(0, MAX_COMMENTS_PER_RESOURCE);
}

export async function fetchRepoDocs(
	config: GitHubFetchConfig,
	paths: readonly string[],
	ref: string,
	maxItems = 500,
): Promise<GitHubFetchResult> {
	const resources: GitHubResource[] = [];
	const errors: GitHubFetchResult["errors"] = [];
	for (const path of paths) {
		if (resources.length >= maxItems) break;
		try {
			if (path.includes("*")) {
				const result = await fetchTreeDocs(config, path, ref, maxItems - resources.length);
				resources.push(...result.resources);
				errors.push(...result.errors);
			} else {
				const resource = await fetchDoc(config, path, ref);
				if (resource) resources.push(resource);
			}
		} catch (err) {
			errors.push({ message: err instanceof Error ? err.message : String(err), retryable: false });
		}
	}
	return { resources: resources.slice(0, maxItems), errors };
}

async function fetchDoc(config: GitHubFetchConfig, path: string, ref: string): Promise<GitHubResource | null> {
	const response = await githubRequest(
		`${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/contents/${encodeGitHubContentPath(path)}?ref=${encodeURIComponent(ref)}`,
		config.token,
	);
	if (response.status === 404) return null;
	if (response.status !== 200) throw new Error(`Doc fetch failed for ${path}: ${response.status}`);
	const body = response.body as { content?: string; encoding?: string; sha?: string; html_url?: string };
	if (body.encoding !== "base64" || !body.content) return null;
	return docResource(path, Buffer.from(body.content, "base64").toString("utf8"), body.sha ?? "", body.html_url);
}

async function fetchTreeDocs(
	config: GitHubFetchConfig,
	pattern: string,
	ref: string,
	maxItems: number,
): Promise<GitHubFetchResult> {
	const response = await githubRequest(
		`${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
		config.token,
	);
	if (response.status !== 200) {
		return {
			resources: [],
			errors: [{ message: `Tree fetch failed: ${response.status}`, retryable: response.status >= 500 }],
		};
	}
	const body = response.body as { tree?: Array<{ path?: string; type?: string }> };
	const regex = new RegExp(`^${globToRegexSource(pattern)}$`);
	const paths = (body.tree ?? [])
		.filter((entry) => entry.type === "blob" && typeof entry.path === "string" && regex.test(entry.path))
		.map((entry) => entry.path as string)
		.slice(0, maxItems);
	const resources: GitHubResource[] = [];
	for (const path of paths) {
		const resource = await fetchDoc(config, path, ref);
		if (resource) resources.push(resource);
	}
	return { resources, errors: [] };
}

function issueResource(issue: GitHubIssue): GitHubResource {
	return {
		type: "issue",
		number: issue.number,
		title: issue.title,
		body: issue.body ?? "",
		state: issue.state,
		url: issue.html_url,
		labels: issue.labels.map((label) => label.name),
		author: issue.user?.login ?? null,
		createdAt: issue.created_at,
		updatedAt: issue.updated_at,
		closedAt: issue.closed_at,
		mergedAt: null,
		commentsCount: issue.comments,
		extra: {},
	};
}

function pullResource(pull: GitHubPullRequest): GitHubResource {
	return {
		type: "pull",
		number: pull.number,
		title: pull.title,
		body: pull.body ?? "",
		state: pull.state,
		url: pull.html_url,
		labels: (pull.labels ?? []).map((label) => label.name),
		author: pull.user?.login ?? null,
		createdAt: pull.created_at,
		updatedAt: pull.updated_at,
		closedAt: pull.closed_at,
		mergedAt: pull.merged_at,
		commentsCount: (pull.comments ?? 0) + (pull.review_comments ?? 0),
		extra: { draft: pull.draft, base: pull.base.ref, head: pull.head.ref },
	};
}

function searchPullResource(issue: GitHubIssue): GitHubResource {
	return { ...issueResource(issue), type: "pull", mergedAt: null };
}

interface DiscussionNode {
	readonly number: number;
	readonly title: string;
	readonly body: string;
	readonly url: string;
	readonly closed?: boolean;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly author?: { readonly login?: string } | null;
	readonly labels?: { readonly nodes?: Array<{ readonly name?: string }> };
	readonly comments?: { readonly totalCount?: number };
}

interface DiscussionPageInfo {
	readonly hasNextPage?: boolean;
	readonly endCursor?: string | null;
}

interface DiscussionCommentNode {
	readonly id: string;
	readonly body: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly author?: { readonly login?: string } | null;
}

function discussionResource(node: DiscussionNode): GitHubResource {
	return {
		type: "discussion",
		number: node.number,
		title: node.title,
		body: node.body,
		state: node.closed ? "closed" : "open",
		url: node.url,
		labels: node.labels?.nodes?.map((label) => label.name).filter((name): name is string => !!name) ?? [],
		author: node.author?.login ?? null,
		createdAt: node.createdAt,
		updatedAt: node.updatedAt,
		closedAt: node.closed ? node.updatedAt : null,
		mergedAt: null,
		commentsCount: node.comments?.totalCount ?? 0,
		extra: {},
	};
}

function docResource(path: string, content: string, sha: string, url?: string): GitHubResource {
	return {
		type: "doc",
		path,
		title: path,
		body: content,
		state: "current",
		url: url ?? "",
		labels: [],
		author: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		closedAt: null,
		mergedAt: null,
		commentsCount: 0,
		extra: { sha },
	};
}

function quoteSearchValue(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function encodeGitHubContentPath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

function globToRegexSource(pattern: string): string {
	let source = "";
	let index = 0;
	while (index < pattern.length) {
		if (pattern.startsWith("**/", index)) {
			source += "(?:.*/)?";
			index += 3;
			continue;
		}
		if (pattern.startsWith("**", index)) {
			source += ".*";
			index += 2;
			continue;
		}
		const char = pattern[index] ?? "";
		if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += escapeRegex(char);
		index++;
	}
	return source;
}

function escapeRegex(char: string): string {
	return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

export function logGitHubFetchError(sourceId: string, repo: string, phase: string, err: unknown): void {
	logger.warn("github-source", "GitHub source fetch failed", {
		sourceId,
		repo,
		phase,
		error: err instanceof Error ? err.message : String(err),
	});
}
