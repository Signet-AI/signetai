export interface PageHeaderDefinition {
	readonly title: string;
	readonly wordmarkLines: readonly string[];
	readonly wordmarkMaxWidth?: string;
	readonly eyebrow: string;
	readonly description: string;
}

export const PAGE_HEADERS = {
	config: {
		title: "Config",
		wordmarkLines: ["CONFIG"],
		eyebrow: "Identity markdown workspace",
		description:
			"Edit AGENTS.md, MEMORY.md, USER.md, and related identity files that define agent behavior.",
	},
	settings: {
		title: "Settings",
		wordmarkLines: ["SETTINGS"],
		eyebrow: "Runtime and harness controls",
		description:
			"Tune pipeline behavior, harness integration, and runtime configuration with safe defaults.",
	},
	memory: {
		title: "Memory",
		wordmarkLines: ["MEMORY"],
		eyebrow: "Persistent memory index",
		description:
			"Search, filter, and inspect long-term memories with hybrid semantic and keyword retrieval.",
	},
	embeddings: {
		title: "Constellation",
		wordmarkLines: ["CONSTELLATION"],
		wordmarkMaxWidth: "420px",
		eyebrow: "Semantic projection workspace",
		description:
			"Explore memory embeddings, neighborhoods, and projection slices to understand memory structure.",
	},
	pipeline: {
		title: "Pipeline",
		wordmarkLines: ["PIPELINE"],
		eyebrow: "Live memory loop telemetry",
		description:
			"Monitor extraction, decisions, maintenance, and feed events across the full memory pipeline.",
	},
	logs: {
		title: "Logs",
		wordmarkLines: ["LOGS"],
		eyebrow: "Daemon event stream",
		description:
			"Filter and inspect structured daemon logs with live streaming and detailed payload views.",
	},
	secrets: {
		title: "Secrets",
		wordmarkLines: ["SECRETS"],
		eyebrow: "Secure secret vault",
		description:
			"Store and manage secret names safely for runtime injection without exposing raw values.",
	},
	skills: {
		title: "Skills",
		wordmarkLines: ["SKILLS"],
		eyebrow: "Open agent skill ecosystem",
		description:
			"Discover, install, and manage reusable agent skills from curated registries.",
	},
	tasks: {
		title: "Tasks",
		wordmarkLines: ["TASKS"],
		eyebrow: "Scheduled agent prompts",
		description:
			"Schedule recurring prompts to run automatically via Claude Code or OpenCode.",
	},
} as const satisfies Record<string, PageHeaderDefinition>;
