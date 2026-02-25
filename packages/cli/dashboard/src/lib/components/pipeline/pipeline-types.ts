/**
 * Pipeline DAG topology — node definitions, edge connections, and layout.
 *
 * Mirrors the architecture in docs/memory-loop.mmd. The layout is
 * hand-positioned for a 1200x900 SVG viewBox.
 */

// ---------------------------------------------------------------------------
// Node health
// ---------------------------------------------------------------------------

export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

// ---------------------------------------------------------------------------
// Groups (visual subgraph boxes)
// ---------------------------------------------------------------------------

export type NodeGroup =
	| "harness"
	| "daemon"
	| "pipeline"
	| "db"
	| "search"
	| "files"
	| "configs"
	| "llm";

export const GROUP_COLORS: Record<NodeGroup, string> = {
	harness: "#4dabf7",
	daemon: "#ff922b",
	pipeline: "#da77f2",
	db: "#ffd43b",
	search: "#da77f2",
	files: "#20c997",
	configs: "#4dabf7",
	llm: "#fcc419",
};

export const GROUP_LABELS: Record<NodeGroup, string> = {
	harness: "AI Harness",
	daemon: "Signet Daemon",
	pipeline: "Pipeline Workers",
	db: "memories.db",
	search: "Hybrid Recall",
	files: "~/.agents/",
	configs: "Harness Configs",
	llm: "LLM Provider",
};

// ---------------------------------------------------------------------------
// Group bounding boxes (x, y, w, h)
// ---------------------------------------------------------------------------

export interface GroupBox {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
	readonly label: string;
	readonly color: string;
}

export const GROUP_BOXES: Record<NodeGroup, GroupBox> = {
	harness: { x: 20, y: 20, w: 240, h: 120, label: GROUP_LABELS.harness, color: GROUP_COLORS.harness },
	daemon: { x: 300, y: 20, w: 340, h: 280, label: GROUP_LABELS.daemon, color: GROUP_COLORS.daemon },
	pipeline: { x: 20, y: 360, w: 620, h: 140, label: GROUP_LABELS.pipeline, color: GROUP_COLORS.pipeline },
	db: { x: 680, y: 160, w: 200, h: 200, label: GROUP_LABELS.db, color: GROUP_COLORS.db },
	search: { x: 920, y: 160, w: 200, h: 140, label: GROUP_LABELS.search, color: GROUP_COLORS.search },
	files: { x: 680, y: 400, w: 200, h: 100, label: GROUP_LABELS.files, color: GROUP_COLORS.files },
	configs: { x: 920, y: 400, w: 200, h: 100, label: GROUP_LABELS.configs, color: GROUP_COLORS.configs },
	llm: { x: 680, y: 540, w: 200, h: 80, label: GROUP_LABELS.llm, color: GROUP_COLORS.llm },
};

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export interface PipelineNodeDef {
	readonly id: string;
	readonly label: string;
	readonly group: NodeGroup;
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
	/** Log categories to watch from SSE stream */
	readonly logCategories: readonly string[];
	/** Diagnostic domain key (if applicable) */
	readonly diagnosticDomain?: string;
	/** Lucide icon name */
	readonly icon: string;
	/** Optional description for tooltip */
	readonly description?: string;
}

export const PIPELINE_NODES: readonly PipelineNodeDef[] = [
	// -- Harness (external AI client) --
	{
		id: "harness",
		label: "AI Client",
		group: "harness",
		x: 40, y: 55, w: 200, h: 50,
		logCategories: ["hooks", "session-tracker"],
		icon: "terminal",
		description: "Claude Code / OpenCode / OpenClaw — sends session hooks",
	},

	// -- Daemon --
	{
		id: "hooks",
		label: "Hook Handlers",
		group: "daemon",
		x: 320, y: 50, w: 140, h: 40,
		logCategories: ["hooks"],
		icon: "webhook",
		description: "Session lifecycle hooks (start, submit, remember, recall, end)",
	},
	{
		id: "mutex",
		label: "Session Mutex",
		group: "daemon",
		x: 320, y: 110, w: 140, h: 40,
		logCategories: ["session-tracker"],
		icon: "lock",
		description: "Plugin vs legacy runtime path enforcement",
	},
	{
		id: "queue",
		label: "Job Queues",
		group: "daemon",
		x: 320, y: 170, w: 140, h: 40,
		logCategories: ["pipeline"],
		diagnosticDomain: "queue",
		icon: "layers",
		description: "memory_jobs + summary_jobs durable queues",
	},
	{
		id: "watcher",
		label: "File Watcher",
		group: "daemon",
		x: 490, y: 110, w: 130, h: 40,
		logCategories: ["watcher"],
		icon: "eye",
		description: "Chokidar file change detection on ~/.agents/",
	},
	{
		id: "sync",
		label: "Harness Sync",
		group: "daemon",
		x: 490, y: 170, w: 130, h: 40,
		logCategories: ["sync"],
		diagnosticDomain: "connector",
		icon: "refresh-cw",
		description: "Generate CLAUDE.md, AGENTS.md from identity files",
	},

	// -- Pipeline workers --
	{
		id: "extraction",
		label: "Extraction",
		group: "pipeline",
		x: 40, y: 395, w: 110, h: 40,
		logCategories: ["pipeline"],
		diagnosticDomain: "queue",
		icon: "cpu",
		description: "LLM extracts facts + entities (2s poll)",
	},
	{
		id: "summary",
		label: "Summary",
		group: "pipeline",
		x: 165, y: 395, w: 100, h: 40,
		logCategories: ["summary-worker"],
		icon: "file-text",
		description: "Session-end transcript summarizer (5s poll)",
	},
	{
		id: "document",
		label: "Document",
		group: "pipeline",
		x: 280, y: 395, w: 100, h: 40,
		logCategories: ["document-worker"],
		icon: "file-plus",
		description: "Chunk + embed documents (10s poll)",
	},
	{
		id: "retention",
		label: "Retention",
		group: "pipeline",
		x: 395, y: 395, w: 100, h: 40,
		logCategories: ["retention"],
		diagnosticDomain: "mutation",
		icon: "trash-2",
		description: "Purge expired data (6h interval)",
	},
	{
		id: "maintenance",
		label: "Maintenance",
		group: "pipeline",
		x: 510, y: 395, w: 110, h: 40,
		logCategories: ["maintenance"],
		icon: "wrench",
		description: "Self-repair + diagnostics (30min interval)",
	},

	// -- Database --
	{
		id: "database",
		label: "SQLite",
		group: "db",
		x: 710, y: 220, w: 140, h: 80,
		logCategories: ["memory", "embedding"],
		diagnosticDomain: "storage",
		icon: "database",
		description: "memories, embeddings, entities, relations, history",
	},

	// -- Search --
	{
		id: "search",
		label: "Hybrid Recall",
		group: "search",
		x: 940, y: 200, w: 160, h: 60,
		logCategories: ["memory"],
		diagnosticDomain: "index",
		icon: "search",
		description: "BM25 + vector similarity + graph boost",
	},

	// -- Files --
	{
		id: "files",
		label: "Identity Files",
		group: "files",
		x: 710, y: 430, w: 140, h: 40,
		logCategories: ["sync"],
		icon: "folder",
		description: "AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md",
	},

	// -- Configs --
	{
		id: "configs",
		label: "CLAUDE.md",
		group: "configs",
		x: 950, y: 430, w: 140, h: 40,
		logCategories: ["harness"],
		icon: "file-code",
		description: "Generated harness config files",
	},

	// -- LLM --
	{
		id: "llm",
		label: "LLM Provider",
		group: "llm",
		x: 710, y: 560, w: 140, h: 40,
		logCategories: ["llm"],
		diagnosticDomain: "provider",
		icon: "brain",
		description: "Ollama qwen3:4b (or configured provider)",
	},
] as const;

// Convenience lookup
export const NODE_MAP = new Map(
	PIPELINE_NODES.map((n) => [n.id, n]),
);

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

export interface PipelineEdgeDef {
	readonly from: string;
	readonly to: string;
	readonly label?: string;
	readonly dashed?: boolean;
}

export const PIPELINE_EDGES: readonly PipelineEdgeDef[] = [
	// Harness -> hooks
	{ from: "harness", to: "hooks", label: "POST" },

	// Hooks -> daemon internals
	{ from: "hooks", to: "mutex" },
	{ from: "hooks", to: "queue", label: "enqueue" },

	// Queue -> workers
	{ from: "queue", to: "extraction" },
	{ from: "queue", to: "summary" },
	{ from: "queue", to: "document" },

	// Workers -> database
	{ from: "extraction", to: "database", label: "write" },
	{ from: "summary", to: "database" },
	{ from: "document", to: "database" },
	{ from: "retention", to: "database" },
	{ from: "maintenance", to: "database" },

	// Workers -> LLM
	{ from: "extraction", to: "llm" },
	{ from: "summary", to: "llm" },

	// Database -> search
	{ from: "database", to: "search" },

	// Search -> harness (recall response)
	{ from: "search", to: "harness", dashed: true, label: "recall" },

	// Watcher + sync chain
	{ from: "watcher", to: "sync" },
	{ from: "files", to: "watcher" },
	{ from: "sync", to: "configs" },
	{ from: "files", to: "sync" },

	// Summary -> files
	{ from: "summary", to: "files", label: ".md" },

	// Configs -> harness (feedback)
	{ from: "configs", to: "harness", dashed: true, label: "next session" },
] as const;

// ---------------------------------------------------------------------------
// Per-node runtime state
// ---------------------------------------------------------------------------

export interface PipelineNodeState {
	health: HealthStatus;
	score: number;
	lastActivity: string | null;
	pulseCount: number;
	queueDepth: number;
	processingRate: number;
	errorCount: number;
	recentLogs: readonly LogEntry[];
	metrics: Record<string, unknown>;
}

export interface LogEntry {
	timestamp: string;
	level: "debug" | "info" | "warn" | "error";
	category: string;
	message: string;
	data?: Record<string, unknown>;
	duration?: number;
	error?: { name: string; message: string };
}

export function createDefaultNodeState(): PipelineNodeState {
	return {
		health: "unknown",
		score: 0,
		lastActivity: null,
		pulseCount: 0,
		queueDepth: 0,
		processingRate: 0,
		errorCount: 0,
		recentLogs: [],
		metrics: {},
	};
}

// ---------------------------------------------------------------------------
// Pipeline status response (from daemon API)
// ---------------------------------------------------------------------------

export interface WorkerStatus {
	readonly running: boolean;
}

export interface QueueCounts {
	readonly pending: number;
	readonly leased: number;
	readonly completed: number;
	readonly failed: number;
	readonly dead: number;
}

export interface PipelineStatusResponse {
	readonly workers: Record<string, WorkerStatus>;
	readonly queues: {
		readonly memory: QueueCounts;
		readonly summary: QueueCounts;
	};
	readonly diagnostics: Record<string, unknown>;
	readonly latency: Record<string, unknown>;
	readonly errorSummary: Record<string, number>;
	readonly mode: string;
}
