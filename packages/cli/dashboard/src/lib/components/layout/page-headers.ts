export interface PageHeaderDefinition {
	readonly title: string;
	readonly eyebrow: string;
}

export const PAGE_HEADERS = {
	config: {
		title: "Character Sheet",
		eyebrow: "agent identity & lore files",
	},
	settings: {
		title: "The Sanctum",
		eyebrow: "agent configuration matrix",
	},
	memory: {
		title: "Adventure Log",
		eyebrow: "persistent memory index",
	},
	timeline: {
		title: "Chronicles",
		eyebrow: "memory evolution timeline",
	},
	embeddings: {
		title: "Memory Map",
		eyebrow: "UMAP constellation",
	},
	pipeline: {
		title: "The Forge",
		eyebrow: "memory processing pipeline",
	},
	logs: {
		title: "Activity Feed",
		eyebrow: "daemon event stream",
	},
	secrets: {
		title: "The Vault",
		eyebrow: "encrypted secret storage",
	},
	skills: {
		title: "The Armory",
		eyebrow: "skill packs & MCP tool servers",
	},
	tasks: {
		title: "Quest Board",
		eyebrow: "scheduled agent quests",
	},
	connectors: {
		title: "Relays",
		eyebrow: "platform harnesses & data sources",
	},
} as const satisfies Record<string, PageHeaderDefinition>;
