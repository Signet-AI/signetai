import type { TraversalPath } from "./pipeline/graph-traversal";

export function formatMemoryDate(isoDate: string): string {
	const d = new Date(isoDate);
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function formatLastSeenShort(isoDate: string): string {
	const seenAt = Date.parse(isoDate);
	if (!Number.isFinite(seenAt)) return "unknown";
	const deltaMs = Date.now() - seenAt;
	if (deltaMs < 60_000) return "just now";
	const minutes = Math.floor(deltaMs / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

export function harnessSupportsNamedCrossAgentTools(harness: string): boolean {
	return harness.trim().toLowerCase() === "codex";
}

export function isPiHarness(harness: string): boolean {
	return harness.trim().toLowerCase() === "pi";
}

export function sanitizePeerPromptField(value: string | undefined): string {
	if (!value) return "";
	return value
		.replace(/[\r\n`*#[\]<>]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function buildSignetSystemPrompt(options: { readonly includeIdentityStewardship?: boolean } = {}): string {
	const identityStewardship = options.includeIdentityStewardship
		? `
Identity files in your Signet workspace:
- AGENTS.md: how you operate (maintain this)
- SOUL.md: personality and values (maintain this)
- IDENTITY.md: who you are (maintain this)
- USER.md: who the user is (maintain this)
- MEMORY.md: auto-generated working memory summary (system-managed)
`
		: "";
	return `[signet active]
You have persistent memory managed by Signet.

Memory Check Loop:
- when to use: before commands, file edits, architectural choices, bug fixes, continuation work, user-preference-sensitive answers, or anything that may depend on prior decisions
- procedure: check injected context first, then run 1-3 targeted recalls with mcp__signet__memory_search; shape recall queries as natural questions with an entity, event, and timeframe when possible; expand session lineage with mcp__signet__lcm_expand or known entities with mcp__signet__knowledge_expand and mcp__signet__knowledge_expand_session when needed
- pitfalls: avoid bag-of-keywords queries; do not treat a missing automatic memory match as proof no prior context exists; do not trust memory blindly when repo, files, or live system state can verify it; do not spam broad recalls for trivial self-contained prompts; treat graph expansion as supporting context, not proof
- verification: before acting, know what context you found, what remains unknown, and whether it is safe to proceed

Memory tools:
- mcp__signet__memory_search: search stored memories by keyword or meaning
- mcp__signet__lcm_expand: expand a session summary into its full lineage and linked memories
- mcp__signet__knowledge_expand: expand a known entity into its aspects, attributes, and dependencies
- mcp__signet__knowledge_expand_session: find sessions linked to a known entity
- mcp__signet__memory_store: save something to memory explicitly

Cross-session history:
- linked summary and transcript artifacts in your Signet workspace are inspectable across sessions
- use transcript and summary artifacts when you need deeper history than MEMORY.md or recall snippets provide
${identityStewardship}
Secrets:
- mcp__signet__secret_list
- mcp__signet__secret_exec
Secrets are injected into subprocesses as environment variables and are not exposed as raw values.
`;
}

function toUnique(values: ReadonlyArray<string>): string[] {
	return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

export function serializeTraversalPath(path: TraversalPath): string {
	return JSON.stringify({
		entity_ids: toUnique(path.entityIds),
		aspect_ids: toUnique(path.aspectIds),
		dependency_ids: toUnique(path.dependencyIds),
	});
}
