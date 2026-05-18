import { logger } from "./logger";

export interface GitHubFetchConfig {
	readonly token?: string;
	readonly owner: string;
	readonly repo: string;
}

export interface GitHubIssue {
	readonly number: number;
	readonly title: string;
	readonly body: string | null;
	readonly state: string;
	readonly html_url: string;
	readonly user: { readonly login: string } | null;
	readonly labels: readonly { readonly name: string; readonly color: string }[];
	readonly assignees: readonly { readonly login: string }[];
	readonly milestone: { readonly title: string } | null;
	readonly created_at: string;
	readonly updated_at: string;
	readonly closed_at: string | null;
	readonly pull_request?: { readonly url: string };
	readonly comments: number;
}

export interface GitHubComment {
	readonly id: number;
	readonly body: string;
	readonly user: { readonly login: string } | null;
	readonly created_at: string;
	readonly updated_at: string;
}

export interface GitHubPullRequest {
	readonly number: number;
	readonly title: string;
	readonly body: string | null;
	readonly state: string;
	readonly html_url: string;
	readonly user: { readonly login: string } | null;
	readonly labels: readonly { readonly name: string; readonly color: string }[];
	readonly assignees: readonly { readonly login: string }[];
	readonly milestone: { readonly title: string } | null;
	readonly created_at: string;
	readonly updated_at: string;
	readonly closed_at: string | null;
	readonly merged_at: string | null;
	readonly draft: boolean;
	readonly base: { readonly ref: string };
	readonly head: { readonly ref: string };
	readonly comments: number;
	readonly review_comments: number;
	readonly commits: number;
	readonly changed_files: number;
}

export interface GitHubSearchIssue {
	readonly number: number;
	readonly title: string;
	readonly body: string | null;
	readonly state: string;
	readonly html_url: string;
	readonly user: { readonly login: string } | null;
	readonly labels: readonly ({ readonly name: string } | string)[];
	readonly created_at: string;
	readonly updated_at: string;
	readonly comments: number;
}

export interface GitHubDiscussion {
	readonly number: number;
	readonly title: string;
	readonly body: string;
	readonly state: string;
	readonly url: string;
	readonly author: { readonly login: string } | null;
	readonly labels: readonly { readonly name: string }[];
	readonly created_at: string;
	readonly updated_at: string;
	readonly answer_id: number | null;
	readonly comments_count: number;
}

export interface GitHubDiscussionComment {
	readonly id: number;
	readonly body: string;
	readonly author: { readonly login: string } | null;
	readonly created_at: string;
	readonly updated_at: string;
	readonly is_answer: boolean;
}

export interface GitHubRepoDoc {
	readonly path: string;
	readonly content: string;
	readonly sha: string;
}

export interface GitHubResource {
	readonly type: "issue" | "pull" | "discussion" | "doc";
	readonly number?: number;
	readonly path?: string;
	readonly title: string;
	readonly body: string;
	readonly state: string;
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
	readonly rateLimitRemaining: number;
	readonly rateLimitReset: number;
	readonly errors: readonly { readonly message: string; readonly retryable: boolean }[];
}

export interface GitHubRepoInfo {
	readonly owner: string;
	readonly repo: string;
	readonly fullName: string;
	readonly description: string | null;
	readonly defaultBranch: string;
	readonly htmlUrl: string;
}

const GITHUB_API_BASE = "https://api.github.com";
const GRAPHQL_URL = "https://api.github.com/graphql";
const PER_PAGE = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

interface GitHubApiResponse {
	readonly status: number;
	readonly headers: Headers;
	readonly body: unknown;
}

interface RateLimitInfo {
	readonly remaining: number;
	readonly reset: number;
}

function parseRateLimit(headers: Headers): RateLimitInfo {
	return {
		remaining: Number(headers.get("x-ratelimit-remaining") ?? "5000"),
		reset: Number(headers.get("x-ratelimit-reset") ?? "0") * 1000,
	};
}

async function githubRequest(url: string, token?: string, method = "GET", body?: unknown): Promise<GitHubApiResponse> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github.v3+json",
		"User-Agent": "signet-daemon",
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	if (body) headers["Content-Type"] = "application/json";

	let lastError: Error | null = null;
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
			const response = await fetch(url, {
				method,
				headers,
				body: body ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});
			clearTimeout(timeout);
			const rateLimit = parseRateLimit(response.headers);
			if (rateLimit.remaining < 10 && rateLimit.reset > Date.now()) {
				const waitMs = rateLimit.reset - Date.now() + 1000;
				logger.warn("github-source", "Approaching rate limit, backing off", {
					remaining: rateLimit.remaining,
					waitMs,
				});
				await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 60_000)));
			}
			if (response.status === 403 && rateLimit.remaining === 0) {
				const waitMs = rateLimit.reset - Date.now() + 1000;
				logger.warn("github-source", "Rate limit exhausted, waiting", { waitMs });
				await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 60_000)));
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
		}
	}
	throw lastError ?? new Error("GitHub API request failed after retries");
}

async function githubRawFetch(url: string, token?: string): Promise<{ status: number; text: string }> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github.v3.raw",
		"User-Agent": "signet-daemon",
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, { headers, signal: controller.signal });
		return { status: response.status, text: await response.text() };
	} finally {
		clearTimeout(timeout);
	}
}

export async function fetchRepoInfo(config: GitHubFetchConfig): Promise<GitHubRepoInfo | null> {
	const url = `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}`;
	const response = await githubRequest(url, config.token);
	if (response.status === 404) return null;
	if (response.status !== 200) {
		throw new Error(`Failed to fetch repo info: ${response.status}`);
	}
	const data = response.body as Record<string, unknown>;
	return {
		owner: ((data.owner as Record<string, unknown> | undefined)?.login as string) ?? config.owner,
		repo: (data.name as string) ?? config.repo,
		fullName: (data.full_name as string) ?? `${config.owner}/${config.repo}`,
		description: (data.description as string) ?? null,
		defaultBranch: (data.default_branch as string) ?? "main",
		htmlUrl: (data.html_url as string) ?? `https://github.com/${config.owner}/${config.repo}`,
	};
}

export async function expandRepoGlob(owner: string, pattern: string, token?: string): Promise<string[]> {
	if (!pattern.includes("*")) return [`${owner}/${pattern}`];
	const url = `${GITHUB_API_BASE}/users/${owner}/repos?per_page=100&type=all`;
	const response = await githubRequest(url, token);
	if (response.status !== 200) {
		logger.warn("github-source", "Failed to expand repo glob", { owner, status: response.status });
		return [];
	}
	const repos = response.body as Array<{ full_name: string; name: string }>;
	const regex = new RegExp(`^${pattern.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
	return repos.filter((r) => regex.test(r.name)).map((r) => r.full_name);
}

export async function fetchIssues(
	config: GitHubFetchConfig,
	since?: string,
	state = "all",
	maxItems = 500,
	labels?: readonly string[],
): Promise<GitHubFetchResult> {
	const resources: GitHubResource[] = [];
	const errors: { message: string; retryable: boolean }[] = [];
	let rateLimitRemaining = 5000;
	let rateLimitReset = 0;
	let page = 1;
	let fetched = 0;

	while (fetched < maxItems) {
		const params = new URLSearchParams({
			state,
			per_page: String(Math.min(PER_PAGE, maxItems - fetched)),
			sort: "updated",
			direction: "desc",
			page: String(page),
		});
		if (since) params.set("since", since);
		if (labels && labels.length > 0) {
			params.set("labels", labels.join(","));
		}
		const url = `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/issues?${params}`;
		const response = await githubRequest(url, config.token);
		const rl = parseRateLimit(response.headers);
		rateLimitRemaining = rl.remaining;
		rateLimitReset = rl.reset;
		if (response.status !== 200) {
			errors.push({ message: `Issues fetch failed: ${response.status}`, retryable: response.status >= 500 });
			break;
		}
		const issues = response.body as GitHubIssue[];
		if (issues.length === 0) break;
		for (const issue of issues) {
			if (issue.pull_request) continue;
			resources.push({
				type: "issue",
				number: issue.number,
				title: issue.title,
				body: issue.body ?? "",
				state: issue.state,
				labels: issue.labels.map((l) => l.name),
				author: issue.user?.login ?? null,
				createdAt: issue.created_at,
				updatedAt: issue.updated_at,
				closedAt: issue.closed_at,
				mergedAt: null,
				commentsCount: issue.comments,
				extra: {
					milestone: issue.milestone?.title ?? null,
					assignees: issue.assignees.map((a) => a.login),
					html_url: issue.html_url,
				},
			});
			fetched++;
		}
		if (issues.length < PER_PAGE) break;
		page++;
	}
	return { resources, rateLimitRemaining, rateLimitReset, errors };
}

export async function fetchIssueComments(config: GitHubFetchConfig, issueNumber: number): Promise<GitHubComment[]> {
	const comments: GitHubComment[] = [];
	let page = 1;
	while (true) {
		const url = `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/issues/${issueNumber}/comments?per_page=${PER_PAGE}&page=${page}`;
		const response = await githubRequest(url, config.token);
		if (response.status !== 200) break;
		const batch = response.body as GitHubComment[];
		comments.push(...batch);
		if (batch.length < PER_PAGE) break;
		page++;
	}
	return comments;
}

export async function fetchPullRequestComments(config: GitHubFetchConfig, pullNumber: number): Promise<GitHubComment[]> {
	const comments: GitHubComment[] = [];
	let page = 1;
	while (true) {
		const url = `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/pulls/${pullNumber}/comments?per_page=${PER_PAGE}&page=${page}`;
		const response = await githubRequest(url, config.token);
		if (response.status !== 200) break;
		const batch = response.body as GitHubComment[];
		comments.push(...batch);
		if (batch.length < PER_PAGE) break;
		page++;
	}
	return comments;
}

export async function fetchPullRequests(
	config: GitHubFetchConfig,
	since?: string,
	state = "all",
	maxItems = 500,
): Promise<GitHubFetchResult> {
	const resources: GitHubResource[] = [];
	const errors: { message: string; retryable: boolean }[] = [];
	let rateLimitRemaining = 5000;
	let rateLimitReset = 0;
	let page = 1;
	let fetched = 0;

	while (fetched < maxItems) {
		const params = new URLSearchParams({
			state,
			per_page: String(Math.min(PER_PAGE, maxItems - fetched)),
			sort: "updated",
			direction: "desc",
			page: String(page),
		});
		if (since) params.set("since", since);
		const url = `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/pulls?${params}`;
		const response = await githubRequest(url, config.token);
		const rl = parseRateLimit(response.headers);
		rateLimitRemaining = rl.remaining;
		rateLimitReset = rl.reset;
		if (response.status !== 200) {
			errors.push({ message: `PRs fetch failed: ${response.status}`, retryable: response.status >= 500 });
			break;
		}
		const pulls = response.body as GitHubPullRequest[];
		if (pulls.length === 0) break;
		for (const pull of pulls) {
			if (since && pull.updated_at < since) {
				break;
			}
			resources.push({
				type: "pull",
				number: pull.number,
				title: pull.title,
				body: pull.body ?? "",
				state: pull.state,
				labels: pull.labels.map((l) => l.name),
				author: pull.user?.login ?? null,
				createdAt: pull.created_at,
				updatedAt: pull.updated_at,
				closedAt: pull.closed_at,
				mergedAt: pull.merged_at,
				commentsCount: pull.comments + pull.review_comments,
				extra: {
					draft: pull.draft,
					base: pull.base.ref,
					head: pull.head.ref,
					commits: pull.commits,
					changed_files: pull.changed_files,
					milestone: pull.milestone?.title ?? null,
					assignees: pull.assignees.map((a) => a.login),
					html_url: pull.html_url,
				},
			});
			fetched++;
		}
		if (pulls.length < PER_PAGE) break;
		if (since && pulls[pulls.length - 1]?.updated_at < since) break;
		page++;
	}
	return { resources, rateLimitRemaining, rateLimitReset, errors };
}

export async function fetchPullRequestsBySearch(
	config: GitHubFetchConfig,
	labels: string[],
	since?: string,
	state = "all",
	maxItems = 500,
): Promise<GitHubFetchResult> {
	const resources: GitHubResource[] = [];
	const errors: { message: string; retryable: boolean }[] = [];
	let rateLimitRemaining = 30;
	let rateLimitReset = 0;
	let page = 1;

	const labelQuery = labels.map((l) => `label:"${l}"`).join(" ");
	const stateQuery = state === "all" ? "" : ` is:${state}`;
	const q = `repo:${config.owner}/${config.repo} type:pr${stateQuery} ${labelQuery}`;

	while (resources.length < maxItems) {
		const params = new URLSearchParams({
			q: q.trim(),
			per_page: String(Math.min(PER_PAGE, maxItems - resources.length)),
			sort: "updated",
			order: "desc",
			page: String(page),
		});
		const url = `${GITHUB_API_BASE}/search/issues?${params}`;
		const response = await githubRequest(url, config.token);
		const rl = parseRateLimit(response.headers);
		rateLimitRemaining = rl.remaining;
		rateLimitReset = rl.reset;
		if (response.status !== 200) {
			errors.push({ message: `PR search fetch failed: ${response.status}`, retryable: response.status >= 500 });
			break;
		}
		const data = response.body as { items: GitHubSearchIssue[]; total_count: number };
		if (!data.items || data.items.length === 0) break;
		for (const item of data.items) {
			if (since && item.updated_at < since) break;
			resources.push({
				type: "pull",
				number: item.number,
				title: item.title,
				body: item.body ?? "",
				state: item.state === "open" ? "open" : "closed",
				labels: item.labels.map((l) => (typeof l === "string" ? l : l.name)),
				author: item.user?.login ?? null,
				createdAt: item.created_at,
				updatedAt: item.updated_at,
				commentsCount: item.comments,
				htmlUrl: item.html_url,
			});
		}
		if (data.items.length < PER_PAGE) break;
		if (data.total_count <= resources.length) break;
		page++;
	}
	return { resources, rateLimitRemaining, rateLimitReset, errors };
}

export async function fetchDiscussions(
	config: GitHubFetchConfig,
	since?: string,
	maxItems = 500,
): Promise<GitHubFetchResult> {
	const resources: GitHubResource[] = [];
	const errors: { message: string; retryable: boolean }[] = [];
	let rateLimitRemaining = 5000;
	let rateLimitReset = 0;

	const query = `
		query($owner: String!, $repo: String!, $first: Int!, $after: String) {
			repository(owner: $owner, name: $repo) {
				discussions(first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
					pageInfo { hasNextPage endCursor }
					nodes {
						number title body url
						author { login }
						labels(first: 20) { nodes { name } }
						createdAt updatedAt
						answerId: answer { id }
						comments { totalCount }
					}
				}
			}
		}`;
	let cursor: string | null = null;
	let fetched = 0;

	while (fetched < maxItems) {
		const variables = {
			owner: config.owner,
			repo: config.repo,
			first: Math.min(100, maxItems - fetched),
			after: cursor,
		};
		const response = await githubRequest(GRAPHQL_URL, config.token, "POST", { query, variables });
		const rl = parseRateLimit(response.headers);
		rateLimitRemaining = rl.remaining;
		rateLimitReset = rl.reset;
		if (response.status !== 200) {
			const body = response.body as { message?: string } | null;
			errors.push({
				message: `Discussions fetch failed: ${response.status} ${body?.message ?? ""}`,
				retryable: response.status >= 500,
			});
			break;
		}
		const data = response.body as {
			errors?: Array<{ message: string }>;
			data?: {
				repository?: {
					discussions?: {
						pageInfo: { hasNextPage: boolean; endCursor: string | null };
						nodes: Array<{
							number: number;
							title: string;
							body: string;
							state: string;
							url: string;
							author: { login: string } | null;
							labels: { nodes: Array<{ name: string }> };
							createdAt: string;
							updatedAt: string;
							answerId: { id: string } | null;
							comments: { totalCount: number };
						}>;
					};
				};
			};
		};
		if (data.errors && data.errors.length > 0) {
			for (const gqlErr of data.errors) {
				errors.push({ message: `GraphQL: ${gqlErr.message}`, retryable: false });
			}
			break;
		}
		const discussions = data.data?.repository?.discussions;
		if (!discussions?.nodes?.length) break;
		for (const d of discussions.nodes) {
			if (since && d.updatedAt < since) {
				cursor = null;
				break;
			}
			resources.push({
				type: "discussion",
				number: d.number,
				title: d.title,
				body: d.body ?? "",
				state: "open",
				labels: d.labels?.nodes?.map((l) => l.name) ?? [],
				author: d.author?.login ?? null,
				createdAt: d.createdAt,
				updatedAt: d.updatedAt,
				closedAt: null,
				mergedAt: null,
				commentsCount: d.comments?.totalCount ?? 0,
				extra: { url: d.url, answer_id: d.answerId?.id ?? null },
			});
			fetched++;
		}
		if (!discussions.pageInfo.hasNextPage) break;
		cursor = discussions.pageInfo.endCursor;
		if (!cursor) break;
	}
	return { resources, rateLimitRemaining, rateLimitReset, errors };
}

export async function fetchDiscussionComments(
	config: GitHubFetchConfig,
	discussionNumber: number,
): Promise<GitHubDiscussionComment[]> {
	const query = `
		query($owner: String!, $repo: String!, $number: Int!, $after: String) {
			repository(owner: $owner, name: $repo) {
				discussion(number: $number) {
					comments(first: 100, after: $after) {
						pageInfo { hasNextPage endCursor }
						nodes {
							id body isAnswer
							author { login }
							createdAt updatedAt
						}
					}
				}
			}
		}`;
	const comments: GitHubDiscussionComment[] = [];
	let cursor: string | null = null;
	while (true) {
		const variables = { owner: config.owner, repo: config.repo, number: discussionNumber, after: cursor };
		const response = await githubRequest(GRAPHQL_URL, config.token, "POST", { query, variables });
		if (response.status !== 200) break;
		const data = response.body as {
			data?: {
				repository?: {
					discussion?: {
						comments?: {
							pageInfo: { hasNextPage: boolean; endCursor: string | null };
							nodes: Array<{
								id: string;
								body: string;
								isAnswer: boolean;
								author: { login: string } | null;
								createdAt: string;
								updatedAt: string;
							}>;
						};
					};
				};
			};
		};
		const nodes = data.data?.repository?.discussion?.comments?.nodes ?? [];
		for (const c of nodes) {
			comments.push({
				id: Number.parseInt(c.id.replace(/^DIC_/, ""), 10) || 0,
				body: c.body,
				author: c.author,
				created_at: c.createdAt,
				updated_at: c.updatedAt,
				is_answer: c.isAnswer,
			});
		}
		const pageInfo = data.data?.repository?.discussion?.comments?.pageInfo;
		if (!pageInfo?.hasNextPage) break;
		cursor = pageInfo.endCursor;
	}
	return comments;
}

export async function fetchRepoDocs(
	config: GitHubFetchConfig,
	docPaths: readonly string[],
	branch?: string,
): Promise<GitHubFetchResult> {
	const resources: GitHubResource[] = [];
	const errors: { message: string; retryable: boolean }[] = [];
	let rateLimitRemaining = 5000;
	let rateLimitReset = 0;

	for (const docPath of docPaths) {
		if (docPath.includes("*")) {
			const treeResources = await fetchTreeDocs(config, docPath, branch);
			resources.push(...treeResources.resources);
			errors.push(...treeResources.errors);
			continue;
		}
		const ref = branch ? `?ref=${branch}` : "";
		const url = `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/contents/${docPath}${ref}`;
		const response = await githubRequest(url, config.token);
		const rl = parseRateLimit(response.headers);
		rateLimitRemaining = rl.remaining;
		rateLimitReset = rl.reset;
		if (response.status === 404) continue;
		if (response.status !== 200) {
			errors.push({
				message: `Doc fetch failed for ${docPath}: ${response.status}`,
				retryable: response.status >= 500,
			});
			continue;
		}
		const data = response.body as { content?: string; sha?: string; name?: string };
		if (!data.content) continue;
		const content = Buffer.from(data.content, "base64").toString("utf-8");
		resources.push({
			type: "doc",
			path: docPath,
			title: (data.name ?? docPath).replace(/\.[^.]+$/, ""),
			body: content,
			state: "open",
			labels: [],
			author: null,
			createdAt: "",
			updatedAt: "",
			closedAt: null,
			mergedAt: null,
			commentsCount: 0,
			extra: { sha: data.sha, path: docPath },
		});
	}
	return { resources, rateLimitRemaining, rateLimitReset, errors };
}

async function fetchTreeDocs(config: GitHubFetchConfig, globPath: string, branch?: string): Promise<GitHubFetchResult> {
	const resources: GitHubResource[] = [];
	const errors: { message: string; retryable: boolean }[] = [];
	const isRecursive = globPath.includes("**");
	const dir = globPath.replace(/\/\*\*\/.*$/, "").replace(/\/\*.*$/, "");
	const matcher = globPath.includes("**/*.md")
		? (p: string) => p.endsWith(".md")
		: globPath.includes("*.md")
			? (p: string) => p.endsWith(".md") && !p.includes("/")
			: () => false;

	const sha = branch || "HEAD";
	const treeUrl = `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/git/trees/${sha}${dir ? `:${dir}` : ""}?recursive=1`;
	const treeResponse = await githubRequest(treeUrl, config.token);
	if (treeResponse.status !== 200) {
		errors.push({ message: `Tree fetch failed for ${dir}: ${treeResponse.status}`, retryable: treeResponse.status >= 500 });
		return { resources, rateLimitRemaining: 5000, rateLimitReset: 0, errors };
	}
	const treeData = treeResponse.body as { tree?: Array<{ path: string; type: string }> };
	const entries = (treeData.tree ?? []).filter((e) => e.type === "blob" && matcher(e.path));
	const refParam = branch ? `?ref=${branch}` : "";

	for (const entry of entries.slice(0, 100)) {
		const fileUrl = `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/contents/${dir ? `${dir}/` : ""}${entry.path}${refParam}`;
		const fileResponse = await githubRequest(fileUrl, config.token);
		if (fileResponse.status !== 200) {
			errors.push({ message: `File fetch failed: ${entry.path}`, retryable: true });
			continue;
		}
		const data = fileResponse.body as { content?: string; sha?: string; name?: string };
		if (!data.content) continue;
		const content = Buffer.from(data.content, "base64").toString("utf-8");
		resources.push({
			type: "doc",
			path: dir ? `${dir}/${entry.path}` : entry.path,
			title: (data.name ?? entry.path).replace(/\.[^.]+$/, ""),
			body: content,
			state: "open",
			labels: [],
			author: null,
			createdAt: "",
			updatedAt: "",
			closedAt: null,
			mergedAt: null,
			commentsCount: 0,
			extra: { sha: data.sha, path: entry.path },
		});
	}
	return { resources, rateLimitRemaining: 5000, rateLimitReset: 0, errors };
}

export function resourceToMarkdown(
	resource: GitHubResource,
	comments?: readonly { author: string | null; body: string; createdAt: string }[],
): string {
	const parts: string[] = [];
	parts.push(`# ${resource.title}`);
	parts.push("");
	const meta: string[] = [
		`**Type:** ${resource.type}`,
		resource.number != null ? `**Number:** #${resource.number}` : null,
		`**State:** ${resource.state}`,
		resource.labels.length > 0 ? `**Labels:** ${resource.labels.join(", ")}` : null,
		resource.author ? `**Author:** @${resource.author}` : null,
		resource.createdAt ? `**Created:** ${resource.createdAt}` : null,
		resource.updatedAt ? `**Updated:** ${resource.updatedAt}` : null,
		resource.closedAt ? `**Closed:** ${resource.closedAt}` : null,
		resource.mergedAt ? `**Merged:** ${resource.mergedAt}` : null,
		resource.extra.draft != null ? `**Draft:** ${resource.extra.draft ? "yes" : "no"}` : null,
		resource.extra.base && resource.extra.head ? `**Branch:** ${resource.extra.head} → ${resource.extra.base}` : null,
	].filter(Boolean);
	parts.push(meta.join(" | "));
	parts.push("");
	if (resource.body.trim()) {
		parts.push(resource.body.trim());
		parts.push("");
	}
	if (comments && comments.length > 0) {
		parts.push("## Comments");
		parts.push("");
		for (const comment of comments) {
			const author = comment.author ? `**@${comment.author}**` : "*unknown*";
			parts.push(`${author} (${comment.createdAt}):`);
			parts.push(comment.body.trim());
			parts.push("");
		}
	}
	return parts.join("\n");
}
