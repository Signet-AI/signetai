export interface PageHeaderDefinition {
	readonly title: string;
	readonly eyebrow: string;
}

export const PAGE_HEADERS = {
	config: {
		title: "Config",
		eyebrow: "Identity markdown workspace",
	},
	settings: {
		title: "Engine",
		eyebrow: "Runtime and harness controls",
	},
	memory: {
		title: "Memory",
		eyebrow: "Persistent memory index",
	},
	timeline: {
		title: "Memory",
		eyebrow: "Era evolution timeline",
	},
	knowledge: {
		title: "Memory",
		eyebrow: "Knowledge graph and traversal view",
	},
	embeddings: {
		title: "Memory",
		eyebrow: "Semantic projection workspace",
	},
	pipeline: {
		title: "Engine",
		eyebrow: "Live memory loop telemetry",
	},
	logs: {
		title: "Engine",
		eyebrow: "Daemon event stream",
	},
	secrets: {
		title: "Secrets",
		eyebrow: "Secure secret vault",
	},
	skills: {
		title: "Marketplace",
		eyebrow: "Skills and Tool Servers",
	},
	tasks: {
		title: "Tasks",
		eyebrow: "Scheduled agent prompts",
	},
	connectors: {
		title: "Engine",
		eyebrow: "Harness and data source health",
	},
} as const satisfies Record<string, PageHeaderDefinition>;
