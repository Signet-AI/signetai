import type { TabId } from "$lib/stores/navigation.svelte";

export interface PageHeaderDefinition {
	readonly title: string;
	readonly eyebrow: string;
}

export const PAGE_HEADERS = {
	home: {
		title: "Overview",
		eyebrow: "Agent overview",
	},
	settings: {
		title: "Settings",
		eyebrow: "Configuration and identity",
	},
	memory: {
		title: "Ontology",
		eyebrow: "Persistent cortex index",
	},
	timeline: {
		title: "Ontology",
		eyebrow: "Era evolution timeline",
	},
	knowledge: {
		title: "Ontology",
		eyebrow: "Knowledge graph and traversal view",
	},
	embeddings: {
		title: "Ontology",
		eyebrow: "Semantic projection workspace",
	},
	audit: {
		title: "Audit",
		eyebrow: "Diagnostics, repair, and daemon logs",
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
		title: "Skills",
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
	predictor: {
		title: "Engine",
		eyebrow: "Predictive memory scorer",
	},
	changelog: {
		title: "Project",
		eyebrow: "Repository overview and release history",
	},
	os: {
		title: "Apps",
		eyebrow: "Signet OS — MCP app dashboard",
	},
	"cortex-memory": {
		title: "Ontology",
		eyebrow: "Cortex index and constellation",
	},
	"cortex-apps": {
		title: "Cortex",
		eyebrow: "Installed apps and tool servers",
	},
	"cortex-tasks": {
		title: "Cortex",
		eyebrow: "Scheduled agent prompts",
	},
	"cortex-troubleshooter": {
		title: "Cortex",
		eyebrow: "Diagnostics and repair terminal",
	},
} as const satisfies Record<TabId, PageHeaderDefinition>;

// --- Tab group item arrays (drives TabGroupBar rendering) ---

export const MEMORY_TAB_ITEMS = [
	{ id: "memory", label: "Cortex" },
	{ id: "timeline", label: "Timeline" },
	{ id: "knowledge", label: "Knowledge" },
	{ id: "embeddings", label: "Constellation" },
] as const satisfies ReadonlyArray<{ id: TabId; label: string }>;

export const ENGINE_TAB_ITEMS = [
	{ id: "settings", label: "Settings" },
] as const satisfies ReadonlyArray<{ id: TabId; label: string }>;

export const CORTEX_TAB_ITEMS = [
	{ id: "cortex-memory", label: "Ontology" },
] as const satisfies ReadonlyArray<{ id: TabId; label: string }>;

// --- Footer definitions ---

export interface PageFooterStatic {
	readonly left: string;
	readonly right: string;
}

/**
 * Static footer content per tab. Tabs with dynamic footers (memory,
 * timeline, tasks) are handled by PageFooter.svelte via props.
 * Skills returns null (no footer).
 */
export const PAGE_FOOTERS: Partial<Record<TabId, PageFooterStatic>> = {
	home: { left: "Agent overview", right: "overview" },
	audit: { left: "Audit", right: "troubleshooter + logs" },
	pipeline: { left: "Pipeline", right: "memory loop v2" },
	embeddings: { left: "Constellation", right: "UMAP" },
	knowledge: { left: "structural graph browser", right: "entities, traversal, predictor slices" },
	logs: { left: "Log viewer", right: "daemon logs" },
	secrets: { left: "Secrets", right: "libsodium" },
	predictor: { left: "Predictor Model", right: "predictive memory scorer" },
	connectors: { left: "platform harnesses + data sources", right: "connector health" },
	changelog: { left: "project docs + release history", right: "github.com/Signet-AI/signetai" },
	os: { left: "MCP app dashboard", right: "drag apps from tray to grid" },
	"cortex-memory": { left: "Ontology", right: "cortex index + constellation" },
	"cortex-apps": { left: "Apps", right: "installed tool servers" },
	"cortex-tasks": { left: "Tasks", right: "scheduled agent prompts" },
	"cortex-troubleshooter": { left: "Troubleshooter", right: "diagnostics and repair" },
};
