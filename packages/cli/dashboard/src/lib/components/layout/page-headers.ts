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
		title: "Settings",
		eyebrow: "Runtime and harness controls",
	},
	memory: {
		title: "Memory",
		eyebrow: "Persistent memory index",
	},
	embeddings: {
		title: "Constellation",
		eyebrow: "Semantic projection workspace",
	},
	pipeline: {
		title: "Pipeline",
		eyebrow: "Live memory loop telemetry",
	},
	logs: {
		title: "Logs",
		eyebrow: "Daemon event stream",
	},
	secrets: {
		title: "Secrets",
		eyebrow: "Secure secret vault",
	},
	skills: {
		title: "Skills",
		eyebrow: "Open agent skill ecosystem",
	},
	tasks: {
		title: "Tasks",
		eyebrow: "Scheduled agent prompts",
	},
} as const satisfies Record<string, PageHeaderDefinition>;
