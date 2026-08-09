/**
 * Demo-mode fixtures + installer for the dashboard.
 *
 * The marketing site embeds the REAL dashboard build (not screenshots) with
 * `VITE_DEMO=1`; this module swaps the live fetchers in `./api` for
 * fixture-backed implementations so the SPA renders fully without a daemon.
 *
 * Contracts:
 * - Compile-time only. `VITE_DEMO=1` is replaced with a literal by vite, so
 *   the `installDemoApi(api)` call is dead code — and this whole module is
 *   tree-shaken — from every non-demo build (daemon + Electron included).
 *   The dashboard can never serve fixtures at runtime.
 * - Synthetic data only. Nothing here is captured from a real workspace; the
 *   embedded demo is public on the marketing site, so every name, summary,
 *   and stat below is invented (and internally consistent: the KPI cards
 *   derive from the same timeline/stats the heatmap and graph render).
 * - Mutations are honest no-ops: demo builds report success for UI calmness
 *   only where a fake accept can't mislead (pin/unpin, reindex). Real work
 *   (dream triggers, source connects) fails with a friendly error instead.
 */

import type {
	DaemonStatus,
	DailyReflection,
	DreamStatus,
	EmbeddingHealthReport,
	KnowledgeConstellation,
	KnowledgeStats,
	LogEntry,
	Memory,
	MemoryStats,
	MemoryTimeline,
	OnePasswordStatus,
	SourcesResponse,
	TelemetryHealth,
	TodayReflectionResponse,
} from "./api";

// Demo builds render inside the dark-only marketing site. The dashboard's
// ThemeProvider defaults to `system`, which would flip the embedded demo to
// light on light-preference visitors; pin dark before React mounts
// (next-themes reads localStorage.theme at init). Runs at module-eval time,
// before createRoot().render(), and only in VITE_DEMO=1 builds — this module
// is tree-shaken from every non-demo build.
if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
	localStorage.setItem("theme", "dark");
	document.documentElement.classList.add("dark");
	// The embed is a fixed 1920x1080 stage scaled to the marketing frame; the
	// app is designed to fit 1080p, but hide any residual document scrollbar
	// so the frame never shows one. Internal view scroll areas are unaffected.
	const demoStyle = document.createElement("style");
	demoStyle.textContent =
		"html, body { scrollbar-width: none; } html::-webkit-scrollbar, body::-webkit-scrollbar { display: none; }";
	document.head.appendChild(demoStyle);
}

// ── Seeded RNG (deterministic builds; mulberry32) ──────────────────────────

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ── Home / status ───────────────────────────────────────────────────────────

const DEMO_AGENT = "default";

const demoStatus: DaemonStatus = {
	status: "running",
	version: "0.173.0",
	uptime: 6_412_815,
	port: 3850,
	host: "127.0.0.1",
	bindHost: "0.0.0.0",
	networkMode: "local",
	agentId: DEMO_AGENT,
	agentsDir: "/home/demo/.agents",
	pipelineV2: {
		enabled: true,
		paused: false,
		shadowMode: false,
		extraction: { provider: "openai", model: "gpt-4o-mini" },
	},
};

/** Internally consistent graph stats: entityCount drives the sidebar badge. */
const demoStats: KnowledgeStats = {
	entityCount: 1247,
	aspectCount: 1893,
	attributeCount: 4201,
	dependencyCount: 9862,
	coveragePercent: 61.4,
};

// ── Timeline (heatmap + Memories KPI share these numbers) ──────────────────

const TOTAL_MEMORIES = 2419;

function demoDailyBuckets(): MemoryTimeline["dailyBuckets"] {
	const rng = mulberry32(20260807);
	const days: NonNullable<MemoryTimeline["dailyBuckets"]> = [];
	const now = new Date();
	for (let i = 251; i >= 0; i--) {
		const d = new Date(now);
		d.setUTCDate(now.getUTCDate() - i);
		const dow = d.getUTCDay();
		const weekend = dow === 0 || dow === 6;
		let n = Math.round(4 + rng() * 14);
		if (weekend) n = Math.round(n * 0.35);
		if (i % 23 === 0) n = 0; // sparse weeks keep it believable
		days.push({ date: d.toISOString().slice(0, 10), memoriesAdded: n });
	}
	const sum = days.reduce((acc, d) => acc + d.memoriesAdded, 0);
	const scale = TOTAL_MEMORIES / Math.max(1, sum);
	for (const d of days) d.memoriesAdded = Math.max(0, Math.round(d.memoriesAdded * scale));
	return days;
}

const demoTimeline: MemoryTimeline = {
	totalMemories: TOTAL_MEMORIES,
	buckets: [
		{ label: "Today", start: new Date().toISOString(), memoriesAdded: 19 },
		{ label: "Last week", start: new Date(Date.now() - 7 * 86_400_000).toISOString(), memoriesAdded: 148 },
		{ label: "Last month", start: new Date(Date.now() - 30 * 86_400_000).toISOString(), memoriesAdded: 621 },
	],
	dailyBuckets: demoDailyBuckets(),
};

// ── Sources ─────────────────────────────────────────────────────────────────

const demoSources: SourcesResponse = {
	version: 1,
	sources: [
		{
			id: "demo-obsidian",
			kind: "obsidian",
			name: "Obsidian",
			root: "vault://main",
			enabled: true,
			mode: "read-only",
			createdAt: "2026-01-12T09:00:00.000Z",
			updatedAt: "2026-08-07T08:00:00.000Z",
			lastIndexedAt: "2026-08-07T08:00:00.000Z",
			excludeGlobs: ["**/.trash/**"],
			stats: { artifacts: 412, chunks: 12980, indexed: 12980 },
			health: {
				status: "healthy",
				latestArtifactAt: "2026-08-07T08:00:00.000Z",
				failures: { total: 0, recoverable: 0 },
			},
		},
		{
			id: "demo-github",
			kind: "github",
			name: "GitHub",
			root: "github://repos/demo/memory-core",
			enabled: true,
			mode: "read-only",
			createdAt: "2026-02-03T14:30:00.000Z",
			updatedAt: "2026-08-06T22:10:00.000Z",
			lastIndexedAt: "2026-08-06T22:10:00.000Z",
			providerSettings: {
				repos: ["demo/memory-core"],
				resourceTypes: ["issues", "pulls", "docs"],
				state: "all",
				includeComments: true,
			},
			stats: { artifacts: 96, chunks: 3420, indexed: 3420 },
			health: {
				status: "healthy",
				latestArtifactAt: "2026-08-06T22:10:00.000Z",
				failures: { total: 0, recoverable: 0 },
			},
		},
		{
			id: "demo-discord",
			kind: "discord",
			name: "Discord",
			root: "discord://guilds/team",
			enabled: true,
			mode: "read-only",
			createdAt: "2026-04-19T11:00:00.000Z",
			updatedAt: "2026-08-07T01:45:00.000Z",
			lastIndexedAt: "2026-08-07T01:45:00.000Z",
			providerSettings: { guildIds: ["demo-guild"], tokenRef: "discord-demo-token" },
			stats: { artifacts: 388, chunks: 6114, indexed: 6114 },
			health: {
				status: "healthy",
				latestArtifactAt: "2026-08-07T01:45:00.000Z",
				failures: { total: 0, recoverable: 0 },
			},
		},
	],
};

// ── Knowledge constellation (graph view) ───────────────────────────────────

const ENTITY_NAMES = [
	"Signet",
	"Local-first",
	"Provenance",
	"Agent Sessions",
	"Knowledge Graph",
	"Memory Stream",
	"Source Artifacts",
	"Embedding Index",
	"Ontology",
	"Claim Values",
	"Evidence Trail",
	"Recall",
	"Fusion Search",
	"Daily Brief",
	"Dreaming",
	"Hygiene",
	"Content Passes",
	"Watermark",
	"Lineage",
	"Transcripts",
	"Session Manifest",
	"Skill Library",
	"Connectors",
	"Harness Hooks",
	"Obsidian",
	"GitHub",
	"Discord",
	"CLI",
	"HTTP API",
	"MCP",
	"Vector Store",
	"SQLite",
	"Secrets Vault",
	"Config Files",
	"Agent Identity",
	"Reflections",
	"Attention",
	"Entity Clusters",
	"Dependencies",
	"Semantic Index",
] as const;

const ASPECT_NAMES = ["facts", "preferences", "workflow", "constraints", "rules", "learnings"] as const;
const ATTR_KINDS = ["fact", "rule", "learning", "constraint", "semantic"] as const;
const DEP_TYPES = ["generates", "depends_on", "references", "strengthens"] as const;

function demoConstellation(): KnowledgeConstellation {
	const rng = mulberry32(20260807);
	let attrN = 0;
	let aspectN = 0;
	const entities = ENTITY_NAMES.map((name, i) => {
		const aspects = [];
		const aspectCount = 2 + Math.floor(rng() * 2); // 2-3
		for (let a = 0; a < aspectCount; a++) {
			aspectN += 1;
			const attributes = [];
			const attrCount = 1 + Math.floor(rng() * 2); // 1-2
			for (let b = 0; b < attrCount; b++) {
				attrN += 1;
				const kind = ATTR_KINDS[Math.floor(rng() * ATTR_KINDS.length)];
				attributes.push({
					id: `demo-attr-${attrN}`,
					content: `${name} ${kind === "constraint" ? "constrains" : kind === "rule" ? "governs" : "informs"} ${ASPECT_NAMES[Math.floor(rng() * ASPECT_NAMES.length)]} handling in the demo workspace`,
					kind,
					importance: Math.round((0.55 + rng() * 0.4) * 100) / 100,
					version: 1,
				});
			}
			aspects.push({
				id: `demo-aspect-${aspectN}`,
				name: ASPECT_NAMES[Math.floor(rng() * ASPECT_NAMES.length)],
				weight: Math.round((0.6 + rng() * 0.4) * 100) / 100,
				attributes,
			});
		}
		return {
			id: `demo-entity-${i + 1}`,
			name,
			entityType: i < 8 ? "concept" : i % 4 === 0 ? "tool" : "project",
			mentions: 12 + Math.floor(rng() * 890),
			pinned: i % 9 === 0,
			aspects,
		};
	});

	const dependencies = [];
	for (let d = 0; d < 90; d++) {
		const from = Math.floor(rng() * entities.length);
		let to = Math.floor(rng() * entities.length);
		if (to === from) to = (to + 1) % entities.length;
		dependencies.push({
			sourceEntityId: entities[from].id,
			targetEntityId: entities[to].id,
			dependencyType: DEP_TYPES[Math.floor(rng() * DEP_TYPES.length)],
			strength: Math.round((0.5 + rng() * 0.5) * 100) / 100,
		});
	}

	return {
		entities,
		dependencies,
		proposals: [{ id: "demo-proposal-1" }],
		metadata: { proposals: { pending: 1 } },
	};
}

// ── Daily brief + memories ──────────────────────────────────────────────────

const demoReflection: DailyReflection = {
	id: "demo-reflection-1",
	date: new Date().toISOString().slice(0, 10),
	summary:
		"Today's brief: the memory graph grew with new source-backed claims from the GitHub connector and an Obsidian vault sync. Two hygiene passes ran overnight, merging duplicate entities and tightening evidence links. Recall quality held at 97% across 1,240 queries this week.",
	patterns: ["sources land in the evening", "hygiene merges ~14 entities per pass"],
	question: null,
	answer: null,
	answerMemoryId: null,
	createdAt: new Date().toISOString(),
	answeredAt: null,
};

const demoReflectionsResponse: TodayReflectionResponse = {
	reflection: demoReflection,
	reflections: [demoReflection],
	generated: 1,
};

const demoMemories: Memory[] = [
	{
		id: "demo-memory-1",
		content:
			"Source-backed claims keep provenance chains intact: derived memories may change, but their source evidence is never rewritten.",
		created_at: new Date(Date.now() - 3_600_000).toISOString(),
		who: "hermes-agent",
		importance: 0.85,
		tags: "provenance,source-backed",
		source_type: "manual",
		pinned: 1,
		type: "rule",
	},
	{
		id: "demo-memory-2",
		content:
			"Recall fuses FTS, vector, and graph traversal, then dampens results by source freshness before returning.",
		created_at: new Date(Date.now() - 7_200_000).toISOString(),
		who: "hermes-agent",
		importance: 0.7,
		tags: "recall,fusion",
		source_type: "manual",
		pinned: 0,
		type: "fact",
	},
	{
		id: "demo-memory-3",
		content: "A daily dreaming pass runs at 02:00; hygiene and content passes alternate so neither starves the other.",
		created_at: new Date(Date.now() - 86_400_000).toISOString(),
		who: "dreaming",
		importance: 0.75,
		tags: "dreaming,hygiene",
		source_type: "manual",
		pinned: 0,
		type: "rule",
	},
	{
		id: "demo-memory-4",
		content:
			"The dashboard scopes every query to the active agent id; cross-agent reads are rejected at the API layer.",
		created_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
		who: "hermes-agent",
		importance: 0.9,
		tags: "scoping,agents",
		source_type: "manual",
		pinned: 0,
		type: "learning",
	},
	{
		id: "demo-memory-5",
		content: "Workspace resolution order: SIGNET_PATH, then SIGNET_WORKSPACE, then $HOME/.agents.",
		created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
		who: "hermes-agent",
		importance: 0.6,
		tags: "workspace,config",
		source_type: "manual",
		pinned: 0,
		type: "rule",
	},
	{
		id: "demo-memory-6",
		content:
			"Embedding index health degrades when the staging drain falls behind; watch the queue depth before triggering a pass.",
		created_at: new Date(Date.now() - 4 * 86_400_000).toISOString(),
		who: "dreaming",
		importance: 0.8,
		tags: "embeddings,health",
		source_type: "manual",
		pinned: 0,
		type: "learning",
	},
	{
		id: "demo-memory-7",
		content: "Obsidian vault notes are ingested as source artifacts with line-level provenance.",
		created_at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
		who: "hermes-agent",
		importance: 0.65,
		tags: "sources,obsidian",
		source_type: "manual",
		pinned: 0,
		type: "semantic",
	},
	{
		id: "demo-memory-8",
		content: "The fusion search endpoint dampens vector results when the graph traversal disagrees with them.",
		created_at: new Date(Date.now() - 6 * 86_400_000).toISOString(),
		who: "hermes-agent",
		importance: 0.7,
		tags: "recall,fusion",
		source_type: "manual",
		pinned: 0,
		type: "fact",
	},
];

const demoMemoryStats: MemoryStats = {
	total: TOTAL_MEMORIES,
	withEmbeddings: 2388,
	critical: 12,
};

const demoEmbeddingHealth: EmbeddingHealthReport = {
	status: "healthy",
	checks: [
		{ name: "queue depth", status: "ok" },
		{ name: "drain lag", status: "ok" },
		{ name: "staging", status: "ok" },
		{ name: "production index", status: "ok" },
		{ name: "dimension drift", status: "ok" },
		{ name: "model reachability", status: "ok" },
		{ name: "coverage", status: "ok" },
	],
};

// ── Secrets, dreams, logs ───────────────────────────────────────────────────

const demoSecrets: { secrets: string[]; provider: string } = {
	secrets: [
		"OPENAI_API_KEY",
		"ANTHROPIC_API_KEY",
		"GITHUB_TOKEN",
		"DISCORD_TOKEN",
		"RESEND_API_KEY",
		"POSTHOG_API_KEY",
		"TAILSCALE_API_KEY",
		"CLOUDFLARE_API_TOKEN",
	],
	provider: "local",
};

const demoDreamStatus: DreamStatus = {
	worker: { running: false, active: false, activeAgentId: null },
	state: {
		consecutiveFailures: 0,
		lastFailureAt: null,
		lastPassAt: new Date(Date.now() - 3_600_000).toISOString(),
		evidenceCursor: "demo-cursor",
		lastPassId: "demo-pass-2",
		lastPassMode: "incremental-hygiene",
	},
	episodicTokensPending: 0,
	config: {
		tokenThreshold: 10000,
		backfillOnFirstRun: false,
		maxInputTokens: 60000,
		maxOutputTokens: 16000,
		timeout: 540,
	},
	passes: [
		{
			id: "demo-pass-2",
			mode: "incremental-hygiene",
			status: "completed",
			startedAt: new Date(Date.now() - 3_900_000).toISOString(),
			completedAt: new Date(Date.now() - 3_600_000).toISOString(),
			tokensConsumed: 41280,
			tokensInput: 38200,
			tokensOutput: 3080,
			tokensCacheRead: 12400,
			tokensCacheWrite: 0,
			tokensCost: 0.018,
			mutationsApplied: 37,
			mutationsSkipped: 2,
			mutationsFailed: 0,
			summary: "Merged 12 duplicate entities, tightened 25 evidence links.",
			error: null,
		},
		{
			id: "demo-pass-1",
			mode: "incremental-content",
			status: "completed",
			startedAt: new Date(Date.now() - 86_400_000).toISOString(),
			completedAt: new Date(Date.now() - 86_300_000).toISOString(),
			tokensConsumed: 61000,
			tokensInput: 54000,
			tokensOutput: 7000,
			tokensCacheRead: 9000,
			tokensCacheWrite: 0,
			tokensCost: 0.031,
			mutationsApplied: 84,
			mutationsSkipped: 0,
			mutationsFailed: 0,
			summary: "Promoted 84 new claims from source evidence.",
			error: null,
		},
	],
	attention: [
		{
			id: "demo-attn-1",
			kind: "stale_entity",
			subjectRef: "demo-entity-12",
			priority: 0.8,
			createdAt: new Date().toISOString(),
			details: null,
		},
		{
			id: "demo-attn-2",
			kind: "orphan_claim",
			subjectRef: "demo-entity-27",
			priority: 0.6,
			createdAt: new Date().toISOString(),
			details: null,
		},
		{
			id: "demo-attn-3",
			kind: "unresolved_evidence",
			subjectRef: "demo-entity-4",
			priority: 0.4,
			createdAt: new Date().toISOString(),
			details: null,
		},
	],
	exclusions: [],
};

const demoLogs: { logs: LogEntry[]; count: number } = {
	count: 3,
	logs: [
		{
			timestamp: new Date(Date.now() - 60_000).toISOString(),
			level: "info",
			category: "daemon",
			message: "health check ok — 3 sources indexed, embeddings healthy",
		},
		{
			timestamp: new Date(Date.now() - 3_600_000).toISOString(),
			level: "info",
			category: "dreaming",
			message: "pass demo-pass-2 completed (37 mutations applied)",
		},
		{
			timestamp: new Date(Date.now() - 86_400_000).toISOString(),
			level: "info",
			category: "sources",
			message: "obsidian index refreshed — 12,980 chunks up to date",
		},
	],
};

const demoTelemetryHealth: { enabled: true } & TelemetryHealth = {
	enabled: true,
	status: "healthy",
	deliveryConfigured: true,
	bufferedEventCount: 0,
	queuedUnsentEventCount: 0,
	oldestUnsentEventAgeSec: null,
	lastDaemonEventAgeSec: 21,
	lastAttemptAgeSec: 21,
	lastSuccessfulDeliveryAgeSec: 21,
	recentDeliverySuccessCount: 84,
	recentDeliveryFailureCount: 0,
	consecutiveFailures: 0,
	backoffActive: false,
	droppedEventCount: 0,
	flushIntervalMs: 60_000,
};

const demoOnePassword: OnePasswordStatus = {
	configured: false,
	connected: false,
	vaultCount: 0,
	vaults: [],
};

// ── Installer ───────────────────────────────────────────────────────────────

type ApiClient = typeof import("./api").api;

/** Replace live fetchers with fixture-backed implementations (VITE_DEMO=1 builds only). */
export function installDemoApi(target: ApiClient): void {
	target.getHealth = async () => true;
	target.getStatus = async () => demoStatus;
	target.getKnowledgeStats = async () => demoStats;
	target.getSources = async () => demoSources;
	target.getMemoryTimeline = async () => demoTimeline;
	target.getKnowledgeConstellation = async () => demoConstellation();
	target.getTodayReflections = async () => demoReflectionsResponse;
	target.generateReflections = async () => demoReflectionsResponse;
	target.answerReflection = async () => ({ success: true, memoryId: "demo-memory-answer" });
	target.getSecrets = async () => demoSecrets;
	target.getDreamStatus = async () => demoDreamStatus;
	target.getMemories = async () => ({ memories: demoMemories, stats: demoMemoryStats });
	target.searchMemories = async (q, limit = 20) => {
		const needle = q.trim().toLowerCase();
		const hits = demoMemories.filter(
			(m) =>
				needle.length === 0 ||
				m.content.toLowerCase().includes(needle) ||
				m.type.toLowerCase().includes(needle) ||
				String(m.tags ?? "")
					.toLowerCase()
					.includes(needle),
		);
		return { memories: hits.slice(0, limit) };
	};
	target.getEmbeddingHealth = async () => demoEmbeddingHealth;
	target.updateMemory = async () => ({ ok: true });
	target.deleteMemory = async () => ({ ok: true });
	target.reindexSource = async () => ({ ok: true });
	target.removeSource = async () => ({ ok: true });
	target.addSource = async () => ({ ok: true });
	target.pickDirectory = async () => ({ ok: false, unavailable: true });
	target.getSourceSnapshot = async () => null;
	target.getLogs = async () => demoLogs;
	target.getTelemetryHealth = async () => demoTelemetryHealth;
	target.getConfigFiles = async () => [];
	target.getOnePasswordStatus = async () => demoOnePassword;
}
