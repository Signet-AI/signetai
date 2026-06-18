<script lang="ts">
import {
	type GitHubSourceResourceType,
	type SignetSourceEntry,
	addDiscordSource,
	addGitHubSource,
	addObsidianSource,
	getSourceSnapshot,
	getSources,
	importSourceSnapshot,
	pickSourceDirectory,
	removeSource,
} from "$lib/api";
import { getDesktopShell } from "$lib/desktop-shell";
import {
	Check,
	CheckCircle2,
	CirclePlus,
	Database,
	Download,
	Folder,
	FolderOpen,
	Info,
	Link2,
	Plus,
	RefreshCw,
	Search,
	Upload,
	X,
} from "$lib/icons";
import { sourceHasChunkCoverageWarning } from "$lib/issue-848-format";
import { onDestroy, onMount } from "svelte";

type SourceKind =
	| "obsidian"
	| "github"
	| "clickup"
	| "csv"
	| "postgres"
	| "supabase"
	| "web-docs"
	| "notion"
	| "google-drive"
	| "gmail"
	| "nextcloud"
	| "x-bookmarks"
	| "discord"
	| "telegram"
	| "quickbooks"
	| "polymarket"
	| "airtable"
	| "go-high-level"
	| "stripe"
	| "imap-email"
	| "proton-mail"
	| "browser-history"
	| "linear";
type SourceCategory = "local" | "cloud" | "code" | "docs" | "data" | "social";
type SourceStatus = "available" | "planned" | "connected";
type SourceIcon =
	| "obsidian"
	| "github"
	| "folder"
	| "clickup"
	| "csv"
	| "postgres"
	| "supabase"
	| "globe"
	| "notion"
	| "drive"
	| "gmail"
	| "nextcloud"
	| "x-bookmarks"
	| "discord"
	| "telegram"
	| "quickbooks"
	| "polymarket"
	| "airtable"
	| "go-high-level"
	| "stripe"
	| "imap-email"
	| "proton-mail"
	| "history"
	| "linear";
type ActiveFilter = "all" | SourceCategory;
type DesktopShellWithPicker = ReturnType<typeof getDesktopShell> & {
	pickDirectory?: (options?: { title?: string }) => Promise<string | null>;
};

type SourceConnector = {
	kind: SourceKind;
	name: string;
	detail: string;
	description: string;
	icon: SourceIcon;
	category: SourceCategory;
	tags: string[];
	status: SourceStatus;
	indexes: string[];
	never: string[];
	learnMore: Array<{ label: string; href: string }>;
};

let sources = $state<SignetSourceEntry[]>([]);
let loading = $state(true);
let adding = $state(false);
let removingSourceId = $state<string | null>(null);
let snapshotBusySourceId = $state<string | null>(null);
let snapshotIncludeLocalDiscordIds = $state<Set<string>>(new Set());
let pickingFolder = $state(false);
// biome-ignore lint/style/useConst: Svelte bind:value mutates this rune from markup.
let searchTerm = $state("");
// biome-ignore lint/style/useConst: Svelte event handlers mutate this rune from markup.
let activeFilter = $state<ActiveFilter>("all");
let selectedKind = $state<SourceKind>("obsidian");
let connectMode = $state(false);
let vaultPath = $state("");
// biome-ignore lint/style/useConst: Svelte bind:value mutates this rune from markup.
let vaultName = $state("Obsidian Vault");
// biome-ignore lint/style/useConst: Svelte bind:value mutates this rune from markup.
let excludeGlobsText = $state("**/.obsidian/**\n**/.trash/**\n**/.hermes/**\n**/.*/**\n**/.*");
// biome-ignore lint/style/useConst: Svelte bind:value mutates this rune from markup.
let discordName = $state("Discord");
// biome-ignore lint/style/useConst: Svelte bind:value mutates this rune from markup.
let discordSyncMode = $state<"rest" | "gateway-tail" | "desktop-cache">("rest");
let discordGuildIdsText = $state("");
let discordTokenRef = $state("");
let discordDesktopCachePath = $state("");
// biome-ignore lint/style/useConst: Svelte bind:checked mutates this rune from markup.
let discordDesktopCacheFullScan = $state(false);
let discordChannelFilterText = $state("");
let discordSince = $state("");
// biome-ignore lint/style/useConst: Svelte bind:value mutates this rune from markup.
let discordMaxMessages = $state(1000);
// biome-ignore lint/style/useConst: Svelte bind:checked mutates this rune from markup.
let discordIncludeMembers = $state(true);
// biome-ignore lint/style/useConst: Svelte bind:checked mutates this rune from markup.
let discordIncludeThreads = $state(true);
// biome-ignore lint/style/useConst: Svelte bind:checked mutates this rune from markup.
let discordIncludeArchivedThreads = $state(true);
// biome-ignore lint/style/useConst: Svelte bind:checked mutates this rune from markup.
let discordIncludePrivateArchivedThreads = $state(false);
// biome-ignore lint/style/useConst: Svelte bind:checked mutates this rune from markup.
let discordIncludeAttachments = $state(true);
// biome-ignore lint/style/useConst: Svelte bind:checked mutates this rune from markup.
let discordIncludeAttachmentText = $state(false);
// biome-ignore lint/style/useConst: Svelte bind:value mutates this rune from markup.
let discordMaxAttachmentTextBytes = $state(262144);
// biome-ignore lint/style/useConst: Svelte bind:checked mutates this rune from markup.
let discordIncludeEmbeds = $state(true);
// biome-ignore lint/style/useConst: Svelte bind:checked mutates this rune from markup.
let discordIncludePolls = $state(true);
// biome-ignore lint/style/useConst: Svelte bind:checked mutates this rune from markup.
let discordIncludeThreadMembers = $state(true);
// biome-ignore lint/style/useConst: Svelte bind:value mutates this rune from markup.
let githubName = $state("GitHub");
let githubReposText = $state("");
let githubTokenRef = $state("");
// biome-ignore lint/style/useConst: Svelte bind:value mutates this rune from markup.
let githubState = $state<"open" | "closed" | "all">("all");
// biome-ignore lint/style/useConst: Svelte bind:checked mutates this rune from markup.
let githubIncludeIssues = $state(true);
// biome-ignore lint/style/useConst: Svelte bind:checked mutates this rune from markup.
let githubIncludePulls = $state(true);
// biome-ignore lint/style/useConst: Svelte bind:checked mutates this rune from markup.
let githubIncludeDiscussions = $state(false);
// biome-ignore lint/style/useConst: Svelte bind:checked mutates this rune from markup.
let githubIncludeDocs = $state(true);
// biome-ignore lint/style/useConst: Svelte bind:checked mutates this rune from markup.
let githubIncludeComments = $state(true);
let githubLabelsText = $state("");
// biome-ignore lint/style/useConst: Svelte bind:value mutates this rune from markup.
let githubDocPathsText = $state("README.md\nCHANGELOG.md");
// biome-ignore lint/style/useConst: Svelte bind:value mutates this rune from markup.
let githubMaxItems = $state(500);
let status = $state<string | null>(null);
let error = $state<string | null>(null);
let touchedPath = $state(false);
let touchedDiscord = $state(false);
let touchedGithub = $state(false);
let expandedKind = $state<SourceKind | null>(null);
// biome-ignore lint/style/useConst: Svelte event handlers mutate this rune from markup.
let selectedDiscordSourceId = $state<string | null>(null);
let sourceRefreshTimer: ReturnType<typeof setInterval> | null = null;

const connectors: SourceConnector[] = [
	{
		kind: "obsidian",
		name: "Obsidian Vault",
		detail: "Markdown vaults, folders, links",
		description:
			"Index Markdown files, folder structure, and links from your Obsidian vault. Signet reads locally and never writes back to your vault.",
		icon: "obsidian",
		category: "local",
		tags: ["local", "markdown", "read-only"],
		status: "available",
		indexes: ["Markdown files (*.md)", "Links and wikilinks", "Folder paths and structure"],
		never: ["Write back to your vault"],
		learnMore: [
			{ label: "Obsidian integration guide", href: "https://github.com/Signet-AI/signetai" },
			{ label: "Supported features", href: "https://github.com/Signet-AI/signetai" },
		],
	},
	{
		kind: "github",
		name: "GitHub Repositories",
		detail: "Issues, PRs, discussions, docs",
		description:
			"Connect public or private repositories so issues, pull requests, discussions, comments, and docs stay available as source-backed recall.",
		icon: "github",
		category: "code",
		tags: ["github", "cloud", "issues", "pull-requests", "discussions", "docs"],
		status: "available",
		indexes: ["Issues and pull requests", "Discussion and issue comments", "README and docs paths"],
		never: ["Push changes without an explicit action"],
		learnMore: [],
	},
	{
		kind: "clickup",
		name: "ClickUp",
		detail: "Tasks, docs, spaces",
		description:
			"Connect ClickUp spaces, lists, tasks, docs, and comments as project context with workspace/list provenance attached.",
		icon: "clickup",
		category: "code",
		tags: ["code", "project-management", "tasks", "clickup", "planned"],
		status: "planned",
		indexes: ["Tasks and subtasks", "Docs", "Spaces and lists"],
		never: ["Change task status or assign owners from indexing"],
		learnMore: [],
	},
	{
		kind: "csv",
		name: "CSV Imports",
		detail: "Tables, exports, structured rows",
		description:
			"Index CSV exports and structured tables as provenance-labeled source context without turning every row into ordinary memory.",
		icon: "csv",
		category: "data",
		tags: ["data", "csv", "tables", "planned"],
		status: "planned",
		indexes: ["CSV rows", "Column names", "Original file path"],
		never: ["Overwrite the source spreadsheet or export"],
		learnMore: [],
	},
	{
		kind: "postgres",
		name: "PostgreSQL",
		detail: "Read-only tables and views",
		description:
			"Connect selected PostgreSQL tables or views for read-only recall with query/source provenance kept intact.",
		icon: "postgres",
		category: "data",
		tags: ["data", "postgres", "database", "planned"],
		status: "planned",
		indexes: ["Selected tables", "Views", "Schema metadata"],
		never: ["Run mutating SQL during indexing"],
		learnMore: [],
	},
	{
		kind: "supabase",
		name: "Supabase",
		detail: "Projects, tables, edge data",
		description:
			"Connect Supabase projects as a managed Postgres source with read-only indexing and table-level provenance.",
		icon: "supabase",
		category: "data",
		tags: ["data", "supabase", "postgres", "planned"],
		status: "planned",
		indexes: ["Selected tables", "Project metadata", "Row provenance"],
		never: ["Write records back from recall"],
		learnMore: [],
	},
	{
		kind: "web-docs",
		name: "Web Docs",
		detail: "Crawl documentation sites",
		description: "Crawl public documentation pages and keep their provenance attached to recall hits.",
		icon: "globe",
		category: "docs",
		tags: ["docs", "web"],
		status: "planned",
		indexes: ["Documentation pages", "Page titles", "Source URLs"],
		never: ["Bypass private access controls"],
		learnMore: [],
	},
	{
		kind: "notion",
		name: "Notion",
		detail: "Pages and databases",
		description: "Index selected Notion pages and databases as source context.",
		icon: "notion",
		category: "docs",
		tags: ["docs", "cloud"],
		status: "planned",
		indexes: ["Pages", "Databases", "Linked blocks"],
		never: ["Edit workspace content from recall"],
		learnMore: [],
	},
	{
		kind: "google-drive",
		name: "Google Drive",
		detail: "Docs, sheets, shared folders",
		description: "Connect selected Drive folders and Google Workspace documents.",
		icon: "drive",
		category: "cloud",
		tags: ["cloud", "docs"],
		status: "planned",
		indexes: ["Docs and sheets", "Shared folders", "File metadata"],
		never: ["Modify Drive files during indexing"],
		learnMore: [],
	},
	{
		kind: "gmail",
		name: "Gmail",
		detail: "Mail threads and attachments",
		description: "Bring searchable mail-thread context into Signet recall with clear mail provenance.",
		icon: "gmail",
		category: "cloud",
		tags: ["cloud", "mail"],
		status: "planned",
		indexes: ["Mail threads", "Participants", "Attachment metadata"],
		never: ["Send mail without a separate action"],
		learnMore: [],
	},
	{
		kind: "nextcloud",
		name: "Nextcloud",
		detail: "Self-hosted files and notes",
		description: "Index files and notes from a self-hosted Nextcloud instance.",
		icon: "nextcloud",
		category: "cloud",
		tags: ["cloud", "self-hosted"],
		status: "planned",
		indexes: ["Files", "Notes", "Folder metadata"],
		never: ["Write changes back by default"],
		learnMore: [],
	},
	{
		kind: "x-bookmarks",
		name: "X Bookmarks",
		detail: "Saved posts and research trails",
		description:
			"Index opted-in X bookmarks so saved posts, threads, and source URLs can be recalled later with clear X provenance.",
		icon: "x-bookmarks",
		category: "social",
		tags: ["social", "x", "bookmarks", "twitter", "planned"],
		status: "planned",
		indexes: ["Bookmarked posts", "Thread URLs", "Author handles"],
		never: ["Post, like, or follow accounts"],
		learnMore: [],
	},
	{
		kind: "discord",
		name: "Discord",
		detail: "Servers, channels, threads",
		description:
			"Index bot-visible Discord guilds, channels, threads, members, messages, mentions, attachments, embeds, polls, and checkpoints as source-labeled conversation context.",
		icon: "discord",
		category: "social",
		tags: ["social", "discord", "chat", "read-only"],
		status: "available",
		indexes: ["Guild channels and threads", "Members and message windows", "Attachments, mentions, embeds, polls"],
		never: ["Send messages or use a raw Discord token"],
		learnMore: [],
	},
	{
		kind: "telegram",
		name: "Telegram",
		detail: "Chats, groups, channels",
		description: "Bring opted-in Telegram chats and channels into recall while preserving chat/source boundaries.",
		icon: "telegram",
		category: "social",
		tags: ["social", "telegram", "chat", "planned"],
		status: "planned",
		indexes: ["Selected chats", "Groups and channels", "Message metadata"],
		never: ["Reply or forward messages from indexing"],
		learnMore: [],
	},
	{
		kind: "quickbooks",
		name: "QuickBooks",
		detail: "Invoices, customers, accounting",
		description:
			"Connect QuickBooks as a read-only business source for invoice, customer, vendor, and transaction context.",
		icon: "quickbooks",
		category: "data",
		tags: ["data", "accounting", "finance", "quickbooks", "planned"],
		status: "planned",
		indexes: ["Invoices and estimates", "Customers and vendors", "Account metadata"],
		never: ["Create transactions or mutate books"],
		learnMore: [],
	},
	{
		kind: "polymarket",
		name: "Polymarket",
		detail: "Markets, odds, research signals",
		description: "Index watched Polymarket markets, prices, and market metadata as provenance-backed research context.",
		icon: "polymarket",
		category: "data",
		tags: ["data", "markets", "prediction", "polymarket", "planned"],
		status: "planned",
		indexes: ["Watched markets", "Prices and outcomes", "Market metadata"],
		never: ["Place trades or manage funds"],
		learnMore: [],
	},
	{
		kind: "airtable",
		name: "Airtable",
		detail: "Bases, tables, records",
		description:
			"Connect selected Airtable bases and tables for structured recall with base/table provenance attached.",
		icon: "airtable",
		category: "data",
		tags: ["data", "airtable", "tables", "planned"],
		status: "planned",
		indexes: ["Selected bases", "Tables and records", "Field metadata"],
		never: ["Edit records during indexing"],
		learnMore: [],
	},
	{
		kind: "go-high-level",
		name: "Go High Level",
		detail: "CRM, contacts, pipelines",
		description:
			"Connect Go High Level CRM data as read-only source context for contacts, opportunities, and client workflows.",
		icon: "go-high-level",
		category: "cloud",
		tags: ["cloud", "crm", "marketing", "go high level", "ghl", "planned"],
		status: "planned",
		indexes: ["Contacts", "Opportunities", "Pipeline metadata"],
		never: ["Trigger automations or message contacts"],
		learnMore: [],
	},
	{
		kind: "stripe",
		name: "Stripe",
		detail: "Payments, customers, invoices",
		description:
			"Index Stripe customers, payments, subscriptions, invoices, and dispute metadata as read-only business context.",
		icon: "stripe",
		category: "data",
		tags: ["data", "payments", "finance", "stripe", "planned"],
		status: "planned",
		indexes: ["Customers", "Invoices and subscriptions", "Payment and dispute metadata"],
		never: ["Create charges, refunds, or payouts"],
		learnMore: [],
	},
	{
		kind: "imap-email",
		name: "IMAP Email",
		detail: "Generic mailboxes and folders",
		description:
			"Connect a standards-based IMAP mailbox for read-only thread, sender, folder, and attachment-metadata recall.",
		icon: "imap-email",
		category: "cloud",
		tags: ["cloud", "mail", "email", "imap", "planned"],
		status: "planned",
		indexes: ["Mail folders", "Threads and senders", "Attachment metadata"],
		never: ["Send, delete, or move mail during indexing"],
		learnMore: [],
	},
	{
		kind: "proton-mail",
		name: "Proton Mail",
		detail: "Encrypted mail via Bridge",
		description:
			"Connect Proton Mail through Bridge/IMAP so mailbox context can be recalled without Signet becoming the source of truth.",
		icon: "proton-mail",
		category: "cloud",
		tags: ["cloud", "mail", "email", "proton", "protonmail", "planned"],
		status: "planned",
		indexes: ["Mail folders", "Threads", "Sender and timestamp metadata"],
		never: ["Bypass Proton encryption or send mail from indexing"],
		learnMore: [],
	},
	{
		kind: "browser-history",
		name: "Browser History",
		detail: "Research trails and pages",
		description: "Index opted-in browsing trails so research context can be recalled later.",
		icon: "history",
		category: "local",
		tags: ["local", "research"],
		status: "planned",
		indexes: ["Visited pages", "Titles", "Research trails"],
		never: ["Index private history without opt-in"],
		learnMore: [],
	},
	{
		kind: "linear",
		name: "Linear",
		detail: "Issues and project context",
		description: "Connect project issues, teams, and status context from Linear.",
		icon: "linear",
		category: "code",
		tags: ["code", "cloud"],
		status: "planned",
		indexes: ["Issues", "Projects", "Teams"],
		never: ["Change issue state from recall"],
		learnMore: [],
	},
];

const filters: Array<{ id: ActiveFilter; label: string }> = [
	{ id: "all", label: "All" },
	{ id: "local", label: "Local" },
	{ id: "cloud", label: "Cloud" },
	{ id: "data", label: "Data" },
	{ id: "social", label: "Social" },
	{ id: "code", label: "Code" },
	{ id: "docs", label: "Docs" },
];

const selectedConnector = $derived(connectors.find((connector) => connector.kind === selectedKind) ?? connectors[0]);
const obsidianSources = $derived(sources.filter((source) => source.kind === "obsidian"));
const discordSources = $derived(sources.filter((source) => source.kind === "discord"));
const githubSources = $derived(sources.filter((source) => source.kind === "github"));
const connectedSourceList = $derived([...obsidianSources, ...discordSources, ...githubSources]);
const selectedDiscordSource = $derived(
	discordSources.find((source) => source.id === selectedDiscordSourceId) ?? discordSources[0] ?? null,
);
const connectedCount = $derived(connectedSourceList.length);
const indexedCount = $derived(
	connectedSourceList.filter((source) => source.lastIndexedAt || (source.stats?.indexed ?? 0) > 0).length,
);
const hasActiveIndexJob = $derived(
	connectedSourceList.some((source) => source.indexJob?.status === "queued" || source.indexJob?.status === "running"),
);
const pathIsMissing = $derived(vaultPath.trim().length === 0);
const discordGuildIds = $derived(parseListInput(discordGuildIdsText));
const discordChannelFilter = $derived(parseListInput(discordChannelFilterText));
const discordUsesDesktopCache = $derived(discordSyncMode === "desktop-cache");
const discordTokenMissing = $derived(discordTokenRef.trim().length === 0);
const discordGuildsMissing = $derived(discordGuildIds.length === 0);
const githubRepos = $derived(parseListInput(githubReposText));
const githubLabels = $derived(parseListInput(githubLabelsText));
const githubDocPaths = $derived(parseListInput(githubDocPathsText));
const githubResourceTypes = $derived.by(() => {
	const types: GitHubSourceResourceType[] = [];
	if (githubIncludeIssues) types.push("issues");
	if (githubIncludePulls) types.push("pulls");
	if (githubIncludeDiscussions) types.push("discussions");
	if (githubIncludeDocs) types.push("docs");
	return types;
});
const githubReposMissing = $derived(githubRepos.length === 0);
const githubResourceTypesMissing = $derived(githubResourceTypes.length === 0);
const githubTokenMissingForDiscussions = $derived(githubIncludeDiscussions && githubTokenRef.trim().length === 0);
const githubMaxItemsInvalid = $derived(!Number.isInteger(Number(githubMaxItems)) || Number(githubMaxItems) < 1);
const canSubmit = $derived.by(() => {
	if (adding) return false;
	if (selectedKind === "obsidian") return !pathIsMissing;
	if (selectedKind === "discord") return discordUsesDesktopCache || (!discordGuildsMissing && !discordTokenMissing);
	if (selectedKind === "github") {
		return (
			!githubReposMissing && !githubResourceTypesMissing && !githubTokenMissingForDiscussions && !githubMaxItemsInvalid
		);
	}
	return false;
});
const filteredConnectors = $derived.by(() => {
	const q = searchTerm.trim().toLowerCase();
	return connectors.filter((connector) => {
		const matchesFilter = activeFilter === "all" || connector.category === activeFilter;
		const matchesSearch =
			q.length === 0 ||
			connector.name.toLowerCase().includes(q) ||
			connector.detail.toLowerCase().includes(q) ||
			connector.tags.some((tag) => tag.includes(q));
		return matchesFilter && matchesSearch;
	});
});

onMount(() => {
	void refreshSources();
	sourceRefreshTimer = setInterval(() => {
		if (hasActiveIndexJob) void refreshSources({ quiet: true });
	}, 1000);
});

onDestroy(() => {
	if (sourceRefreshTimer) clearInterval(sourceRefreshTimer);
});

async function refreshSources(options: { quiet?: boolean } = {}): Promise<void> {
	if (!options.quiet) loading = true;
	error = null;
	try {
		sources = await getSources();
	} finally {
		if (!options.quiet) loading = false;
	}
}

function selectConnector(kind: SourceKind): void {
	const closing = expandedKind === kind;
	selectedKind = kind;
	expandedKind = closing ? null : kind;
	connectMode = false;
	status = null;
	error = null;
	touchedPath = false;
	touchedDiscord = false;
	touchedGithub = false;
}

async function chooseFolder(): Promise<void> {
	const shell = getDesktopShell() as DesktopShellWithPicker;
	pickingFolder = true;
	error = null;
	status = null;
	try {
		if (shell?.pickDirectory) {
			const picked = await shell.pickDirectory({ title: "Choose Obsidian vault" });
			if (picked) {
				vaultPath = picked;
				touchedPath = true;
			}
			return;
		}

		const result = await pickSourceDirectory("Choose Obsidian vault");
		if (result.path) {
			vaultPath = result.path;
			touchedPath = true;
			return;
		}
		if (result.error) error = result.error;
	} catch (err) {
		error = err instanceof Error ? err.message : "Could not open folder picker.";
	} finally {
		pickingFolder = false;
	}
}

async function chooseDiscordCacheFolder(): Promise<void> {
	const shell = getDesktopShell() as DesktopShellWithPicker;
	pickingFolder = true;
	error = null;
	status = null;
	try {
		if (shell?.pickDirectory) {
			const picked = await shell.pickDirectory({ title: "Choose Discord Desktop data folder" });
			if (picked) discordDesktopCachePath = picked;
			return;
		}

		const result = await pickSourceDirectory("Choose Discord Desktop data folder");
		if (result.path) {
			discordDesktopCachePath = result.path;
			return;
		}
		if (result.error) error = result.error;
	} catch (err) {
		error = err instanceof Error ? err.message : "Could not open folder picker.";
	} finally {
		pickingFolder = false;
	}
}

async function submitSource(): Promise<void> {
	touchedPath = true;
	if (!canSubmit) return;
	adding = true;
	status = null;
	error = null;
	try {
		const excludeGlobs = parseExcludeGlobs(excludeGlobsText);
		const result = await addObsidianSource(vaultPath.trim(), vaultName.trim() || undefined, excludeGlobs);
		if (result.error) {
			error = result.error;
			return;
		}
		status = result.queued
			? `${result.created ? "Connected" : "Updated"} ${result.source.name}. Indexing is running in the background.`
			: `${result.created ? "Connected" : "Updated"} ${result.source.name}. Indexed ${result.indexed} changed notes.`;
		vaultPath = "";
		touchedPath = false;
		connectMode = false;
		await refreshSources();
	} finally {
		adding = false;
	}
}

async function submitDiscordSource(): Promise<void> {
	touchedDiscord = true;
	if (!canSubmit) return;
	adding = true;
	status = null;
	error = null;
	try {
		const result = await addDiscordSource({
			guildIds: discordUsesDesktopCache ? [] : discordGuildIds,
			tokenRef: discordUsesDesktopCache ? undefined : discordTokenRef.trim(),
			name: discordName.trim() || undefined,
			desktopCachePath: discordUsesDesktopCache ? discordDesktopCachePath.trim() || undefined : undefined,
			desktopCacheFullScan: discordUsesDesktopCache ? discordDesktopCacheFullScan : undefined,
			channelFilter: !discordUsesDesktopCache && discordChannelFilter.length > 0 ? discordChannelFilter : undefined,
			maxMessagesPerChannel: discordUsesDesktopCache ? undefined : discordMaxMessages,
			includeMembers: discordUsesDesktopCache ? undefined : discordIncludeMembers,
			includeThreads: discordUsesDesktopCache ? undefined : discordIncludeThreads,
			includeArchivedThreads: discordUsesDesktopCache ? undefined : discordIncludeArchivedThreads,
			includePrivateArchivedThreads: discordUsesDesktopCache ? undefined : discordIncludePrivateArchivedThreads,
			includeAttachments: discordUsesDesktopCache ? undefined : discordIncludeAttachments,
			includeAttachmentText: discordUsesDesktopCache
				? undefined
				: discordIncludeAttachments && discordIncludeAttachmentText,
			maxAttachmentTextBytes: discordUsesDesktopCache ? undefined : discordMaxAttachmentTextBytes,
			includeEmbeds: discordUsesDesktopCache ? undefined : discordIncludeEmbeds,
			includePolls: discordUsesDesktopCache ? undefined : discordIncludePolls,
			includeThreadMembers: discordUsesDesktopCache ? undefined : discordIncludeThreadMembers,
			since: discordUsesDesktopCache ? undefined : discordSince.trim() || undefined,
			syncMode: discordSyncMode,
		});
		if (result.error) {
			error = result.error;
			return;
		}
		status = `${result.created ? "Connected" : "Updated"} ${result.source.name}. Discord indexing is running in the background.`;
		discordGuildIdsText = "";
		discordTokenRef = "";
		discordChannelFilterText = "";
		discordSince = "";
		touchedDiscord = false;
		connectMode = false;
		await refreshSources();
	} finally {
		adding = false;
	}
}

async function submitGitHubSource(): Promise<void> {
	touchedGithub = true;
	if (!canSubmit) return;
	adding = true;
	status = null;
	error = null;
	try {
		const result = await addGitHubSource({
			repos: githubRepos,
			tokenRef: githubTokenRef.trim() || undefined,
			name: githubName.trim() || undefined,
			resourceTypes: githubResourceTypes,
			state: githubState,
			includeComments: githubIncludeComments,
			labels: githubLabels.length > 0 ? githubLabels : undefined,
			docPaths: githubDocPaths,
			maxItemsPerRepo: Number(githubMaxItems),
		});
		if (result.error) {
			error = result.error;
			return;
		}
		status = `${result.created ? "Connected" : "Updated"} ${result.source.name}. GitHub indexing is running in the background.`;
		githubReposText = "";
		githubTokenRef = "";
		githubLabelsText = "";
		touchedGithub = false;
		connectMode = false;
		await refreshSources();
	} finally {
		adding = false;
	}
}

async function disconnectSource(source: SignetSourceEntry): Promise<void> {
	const originalLabel =
		source.kind === "discord" ? "Discord data" : source.kind === "github" ? "GitHub data" : "vault files";
	const confirmed = window.confirm(
		`Remove ${source.name} from Signet?\n\nThis purges Signet's indexed source rows and chunks, but leaves the original ${originalLabel} untouched.`,
	);
	if (!confirmed) return;
	removingSourceId = source.id;
	status = null;
	error = null;
	try {
		const result = await removeSource(source.id);
		if (result.error) {
			error = result.error;
			return;
		}
		status = `Removed ${source.name}. Purged ${result.purged ?? 0} Signet-owned source rows; ${originalLabel} was not touched.`;
		await refreshSources();
	} finally {
		removingSourceId = null;
	}
}

function snapshotIncludesLocalDiscord(sourceId: string): boolean {
	return snapshotIncludeLocalDiscordIds.has(sourceId);
}

function setSnapshotIncludesLocalDiscord(sourceId: string, checked: boolean): void {
	const next = new Set(snapshotIncludeLocalDiscordIds);
	if (checked) next.add(sourceId);
	else next.delete(sourceId);
	snapshotIncludeLocalDiscordIds = next;
}

function snapshotFilename(source: SignetSourceEntry): string {
	const safeName = source.name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `${safeName || source.kind}-source-snapshot.json`;
}

async function exportSnapshot(source: SignetSourceEntry): Promise<void> {
	snapshotBusySourceId = source.id;
	status = null;
	error = null;
	try {
		const result = await getSourceSnapshot(source.id, snapshotIncludesLocalDiscord(source.id));
		if (result.error) {
			error = result.error;
			return;
		}
		const blob = new Blob([JSON.stringify(result.snapshot, null, 2)], { type: "application/json" });
		const href = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = href;
		link.download = snapshotFilename(source);
		document.body.appendChild(link);
		link.click();
		link.remove();
		URL.revokeObjectURL(href);
		status = `Exported ${source.name} snapshot.`;
	} finally {
		snapshotBusySourceId = null;
	}
}

async function importSnapshotFile(source: SignetSourceEntry, event: Event): Promise<void> {
	const input = event.currentTarget as HTMLInputElement;
	const file = input.files?.[0];
	if (!file) return;
	const confirmed = window.confirm(
		`Import snapshot into ${source.name}?\n\nThis replaces Signet's indexed rows for this source. The original ${source.kind === "discord" ? "Discord data" : source.kind === "github" ? "GitHub data" : "source files"} will not be touched.`,
	);
	if (!confirmed) {
		input.value = "";
		return;
	}
	snapshotBusySourceId = source.id;
	status = null;
	error = null;
	try {
		const snapshot = JSON.parse(await file.text()) as unknown;
		const result = await importSourceSnapshot(source.id, snapshot, snapshotIncludesLocalDiscord(source.id));
		if (result.error) {
			error = result.error;
			return;
		}
		const skipped = result.skipped?.localDiscordArtifacts ?? 0;
		status = `Imported ${result.imported ?? 0} ${source.name} snapshot artifacts${skipped > 0 ? `; skipped ${skipped} local Discord cache artifacts` : ""}.`;
		await refreshSources();
	} catch (err) {
		error =
			err instanceof SyntaxError
				? "Snapshot file is not valid JSON."
				: err instanceof Error
					? err.message
					: String(err);
	} finally {
		input.value = "";
		snapshotBusySourceId = null;
	}
}

function formatDate(value: string | undefined): string {
	if (!value) return "Not completed yet";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatOptionalDate(value: string | null | undefined): string {
	return value ? formatDate(value) : "No rows yet";
}

function formatDateOnly(value: string | null | undefined, empty: string): string {
	if (!value) return empty;
	const isoDate = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
	const date = isoDate ? new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3])) : new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function parseExcludeGlobs(value: string): string[] {
	return parseListInput(value);
}

function parseListInput(value: string): string[] {
	return Array.from(
		new Set(
			value
				.split(/[\n,]/)
				.map((entry) => entry.trim())
				.filter(Boolean),
		),
	);
}

function sourceScanLabel(source: SignetSourceEntry): string {
	if (source.indexJob?.status === "queued") return "Index queued";
	if (source.indexJob?.status === "running") {
		const scanned = source.indexJob.scanned ?? 0;
		const indexed = source.indexJob.indexed ?? 0;
		const total = source.indexJob.total ?? 0;
		if (scanned > 0 && total > 0) return `Indexing · ${scanned}/${total} scanned · ${indexed} changed`;
		return scanned > 0 ? `Indexing · ${scanned} scanned · ${indexed} changed` : "Indexing in background";
	}
	if (source.indexJob?.status === "error") return `Index failed: ${source.indexJob.error ?? "unknown error"}`;
	const itemLabel = source.kind === "obsidian" ? "notes" : source.kind === "github" ? "items" : "artifacts";
	const indexed = source.stats?.indexed ?? 0;
	const chunks = source.stats?.chunks ?? 0;
	if (indexed > 0 && chunks === 0) {
		return `${indexed} ${itemLabel} · 0 chunks · extraction pending`;
	}
	if (indexed > 0) return `${indexed} ${itemLabel} · ${chunks} chunks${source.lastIndexedAt ? "" : " · syncing"}`;
	return source.lastIndexedAt
		? `Scan completed with no indexed ${itemLabel}`
		: `Connected; waiting for first indexed ${itemLabel.slice(0, -1)}`;
}

function sourceHealthLabel(source: SignetSourceEntry): string {
	const health = source.health;
	if (!health) return "Health pending";
	if (health.status === "empty") return "No indexed source rows yet";
	if (health.status === "unhealthy") return health.error ?? "Health diagnostics failed";
	if (health.status === "healthy") {
		if (sourceHasChunkCoverageWarning(source.stats)) return "Needs attention · indexed rows have no chunks";
		const checkpointLabel =
			source.kind === "discord" && (health.checkpoints?.total ?? 0) > 0
				? ` · ${health.checkpoints?.total ?? 0} checkpoints`
				: "";
		const semanticLabel = (health.semantic?.total ?? 0) > 0 ? ` · ${health.semantic?.total ?? 0} graph rows` : "";
		return `Healthy${checkpointLabel}${semanticLabel}`;
	}
	const issues: string[] = [];
	if ((health.failures?.total ?? 0) > 0) issues.push(`${health.failures?.total ?? 0} fetch failures`);
	if ((health.checkpoints?.partial ?? 0) > 0) issues.push(`${health.checkpoints?.partial ?? 0} partial checkpoints`);
	if ((health.checkpoints?.stale ?? 0) > 0) issues.push(`${health.checkpoints?.stale ?? 0} stale checkpoints`);
	if ((health.purge?.deletedArtifacts ?? 0) > 0)
		issues.push(`${health.purge?.deletedArtifacts ?? 0} deleted rows retained`);
	if ((health.purge?.orphanChunks ?? 0) > 0) issues.push(`${health.purge?.orphanChunks ?? 0} orphan chunks`);
	return issues.length > 0 ? issues.join(" · ") : "Needs attention";
}

function sourceHealthTone(source: SignetSourceEntry): string {
	if (!source.health) return "unknown";
	if (source.health.status === "healthy" && sourceHasChunkCoverageWarning(source.stats)) return "degraded";
	return source.health.status;
}

function sourceIndexPercent(source: SignetSourceEntry): number {
	const scanned = source.indexJob?.scanned ?? 0;
	const total = source.indexJob?.total ?? 0;
	if (total <= 0) return source.indexJob?.status === "complete" ? 100 : 0;
	return Math.min(100, Math.max(0, Math.round((scanned / total) * 100)));
}

function sourceIndexCurrentPath(source: SignetSourceEntry): string {
	const currentPath = source.indexJob?.currentPath;
	if (!currentPath) return "";
	return currentPath.startsWith(`${source.root}/`) ? currentPath.slice(source.root.length + 1) : currentPath;
}

function sourceSettingString(source: SignetSourceEntry, key: string): string | null {
	const value = source.providerSettings?.[key];
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function sourceSettingNumber(source: SignetSourceEntry, key: string): number | null {
	const value = source.providerSettings?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sourceSettingBoolean(source: SignetSourceEntry, key: string): boolean | null {
	const value = source.providerSettings?.[key];
	return typeof value === "boolean" ? value : null;
}

function sourceSettingStringList(source: SignetSourceEntry, key: string): string[] {
	const value = source.providerSettings?.[key];
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function discordModeLabel(source: SignetSourceEntry): string {
	const mode = sourceSettingString(source, "syncMode") ?? "rest";
	if (mode === "gateway-tail") return "Gateway tail";
	if (mode === "desktop-cache") return "Desktop cache";
	return "Bot REST";
}

function compactSettingValue(value: string): string {
	if (/^\d{17,20}$/.test(value)) return `${value.slice(0, 6)}...${value.slice(-4)}`;
	return value;
}

function compactListLabel(items: readonly string[], empty: string): string {
	if (items.length === 0) return empty;
	const labels = items.map(compactSettingValue);
	if (labels.length <= 2) return labels.join(", ");
	return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}

function discordGuildLabel(source: SignetSourceEntry): string {
	if (sourceSettingString(source, "syncMode") === "desktop-cache") return "Local desktop cache";
	const guildIds = sourceSettingStringList(source, "guildIds");
	if (guildIds.length === 0) return "No guilds configured";
	if (guildIds.length === 1) return compactSettingValue(guildIds[0] ?? "");
	return `${guildIds.length} guilds`;
}

function discordAttachmentTextLabel(source: SignetSourceEntry): string {
	if (sourceSettingBoolean(source, "includeAttachmentText") !== true) return "Off";
	const maxBytes = sourceSettingNumber(source, "maxAttachmentTextBytes");
	return maxBytes ? `On · ${maxBytes.toLocaleString()} bytes` : "On";
}

function discordYesNo(source: SignetSourceEntry, key: string, defaultValue = true): string {
	return (sourceSettingBoolean(source, key) ?? defaultValue) ? "On" : "Off";
}
</script>

{#snippet sourceLogo(icon: SourceIcon)}
	{#if icon === "obsidian"}
		<!-- Official Simple Icons glyph: https://simpleicons.org/?q=obsidian -->
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo obsidian-logo">
			<path
				fill="#7C3AED"
				d="M19.355 18.538a68.967 68.959 0 0 0 1.858-2.954.81.81 0 0 0-.062-.9c-.516-.685-1.504-2.075-2.042-3.362-.553-1.321-.636-3.375-.64-4.377a1.707 1.707 0 0 0-.358-1.05l-3.198-4.064a3.744 3.744 0 0 1-.076.543c-.106.503-.307 1.004-.536 1.5-.134.29-.29.6-.446.914l-.31.626c-.516 1.068-.997 2.227-1.132 3.59-.124 1.26.046 2.73.815 4.481.128.011.257.025.386.044a6.363 6.363 0 0 1 3.326 1.505c.916.79 1.744 1.922 2.415 3.5zM8.199 22.569c.073.012.146.02.22.02.78.024 2.095.092 3.16.29.87.16 2.593.64 4.01 1.055 1.083.316 2.198-.548 2.355-1.664.114-.814.33-1.735.725-2.58l-.01.005c-.67-1.87-1.522-3.078-2.416-3.849a5.295 5.295 0 0 0-2.778-1.257c-1.54-.216-2.952.19-3.84.45.532 2.218.368 4.829-1.425 7.531zM5.533 9.938c-.023.1-.056.197-.098.29L2.82 16.059a1.602 1.602 0 0 0 .313 1.772l4.116 4.24c2.103-3.101 1.796-6.02.836-8.3-.728-1.73-1.832-3.081-2.55-3.831zM9.32 14.01c.615-.183 1.606-.465 2.74-.546-.705-1.79-.844-3.322-.71-4.565.157-1.46.686-2.69 1.214-3.756l.32-.633c.153-.303.3-.592.428-.867.266-.57.448-1.077.468-1.556.014-.343-.053-.69-.25-1.075L6.561 8.982c.713.753 1.901 2.196 2.757 4.044.145.313.279.642.4.985z"
			/>
		</svg>
	{:else if icon === "github"}
		<!-- Official Simple Icons glyph: https://simpleicons.org/?q=github -->
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo github-logo">
			<path
				fill="currentColor"
				d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
			/>
		</svg>
	{:else if icon === "folder"}
		<Folder />
	{:else if icon === "csv"}
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo csv-logo">
			<path fill="currentColor" d="M4 2h12l4 4v16H4z" opacity="0.18" />
			<path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="miter" d="M4 2h12l4 4v16H4zM16 2v5h4M7 11h10M7 15h10M10 9v10M14 9v10" />
		</svg>
	{:else if icon === "postgres"}
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo postgres-logo">
			<path fill="#4169E1" d="M12 2C8.2 2 5.1 3.3 5.1 5v10.2c0 1.7 3.1 3 6.9 3s6.9-1.3 6.9-3V5c0-1.7-3.1-3-6.9-3Zm0 1.9c3 0 4.9.8 4.9 1.1S15 6.1 12 6.1 7.1 5.3 7.1 5 9 3.9 12 3.9Zm4.9 11.1c0 .4-1.9 1.2-4.9 1.2s-4.9-.8-4.9-1.2v-2.1c1.2.7 2.9 1.1 4.9 1.1s3.7-.4 4.9-1.1Zm0-4c0 .4-1.9 1.2-4.9 1.2S7.1 11.4 7.1 11V8.9C8.3 9.6 10 10 12 10s3.7-.4 4.9-1.1Z" />
		</svg>
	{:else if icon === "supabase"}
		<!-- Official Simple Icons glyph: https://simpleicons.org/?q=supabase -->
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo supabase-logo">
			<path fill="#3FCF8E" d="M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z" />
		</svg>
	{:else if icon === "globe"}
		<!-- Official Simple Icons glyph: https://simpleicons.org/?q=mdn -->
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo mdn-logo">
			<path
				fill="#000000"
				d="m21.538 1.1-6.745 21.8h-2.77L18.77 1.1ZM24 1.1v21.8h-2.462V1.1Zm-12 0v21.8H9.538V1.1Zm-2.462 0L2.77 22.9H0L6.746 1.1Z"
			/>
		</svg>
	{:else if icon === "drive"}
		<!-- Official Simple Icons glyph: https://simpleicons.org/?q=google%20drive -->
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo drive-logo">
			<path
				fill="#4285F4"
				d="M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z"
			/>
		</svg>
	{:else if icon === "gmail"}
		<!-- Official Simple Icons glyph: https://simpleicons.org/?q=gmail -->
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo gmail-logo">
			<path
				fill="#EA4335"
				d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"
			/>
		</svg>
	{:else if icon === "nextcloud"}
		<!-- Official Simple Icons glyph: https://simpleicons.org/?q=nextcloud -->
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo nextcloud-logo">
			<path
				fill="#0082C9"
				d="M12.018 6.537c-2.5 0-4.6 1.712-5.241 4.015-.56-1.232-1.793-2.105-3.225-2.105A3.569 3.569 0 0 0 0 12a3.569 3.569 0 0 0 3.552 3.553c1.432 0 2.664-.874 3.224-2.106.641 2.304 2.742 4.016 5.242 4.016 2.487 0 4.576-1.693 5.231-3.977.569 1.21 1.783 2.067 3.198 2.067A3.568 3.568 0 0 0 24 12a3.569 3.569 0 0 0-3.553-3.553c-1.416 0-2.63.858-3.199 2.067-.654-2.284-2.743-3.978-5.23-3.977zm0 2.085c1.878 0 3.378 1.5 3.378 3.378 0 1.878-1.5 3.378-3.378 3.378A3.362 3.362 0 0 1 8.641 12c0-1.878 1.5-3.378 3.377-3.378zm-8.466 1.91c.822 0 1.467.645 1.467 1.468s-.644 1.467-1.467 1.468A1.452 1.452 0 0 1 2.085 12c0-.823.644-1.467 1.467-1.467zm16.895 0c.823 0 1.468.645 1.468 1.468s-.645 1.468-1.468 1.468A1.452 1.452 0 0 1 18.98 12c0-.823.644-1.467 1.467-1.467z"
			/>
		</svg>
	{:else if icon === "notion"}
		<!-- Official Simple Icons glyph: https://simpleicons.org/?q=notion -->
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo notion-logo">
			<path
				fill="#000000"
				d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"
			/>
		</svg>
	{:else if icon === "x-bookmarks"}
		<!-- Official Simple Icons glyph: https://simpleicons.org/?q=x -->
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo x-logo">
			<path fill="currentColor" d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" />
		</svg>
	{:else if icon === "discord"}
		<!-- Official Simple Icons glyph: https://simpleicons.org/?q=discord -->
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo discord-logo">
			<path fill="#5865F2" d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
		</svg>
	{:else if icon === "telegram"}
		<!-- Official Simple Icons glyph: https://simpleicons.org/?q=telegram -->
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo telegram-logo">
			<path fill="#26A5E4" d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
		</svg>
	{:else if icon === "quickbooks"}
		<!-- Official Simple Icons glyph: https://simpleicons.org/?q=quickbooks -->
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo quickbooks-logo">
			<path fill="#2CA01C" d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm.642 4.1335c.9554 0 1.7296.776 1.7296 1.7332v9.0667h1.6c1.614 0 2.9275-1.3156 2.9275-2.933 0-1.6173-1.3136-2.9333-2.9276-2.9333h-.6654V7.3334h.6654c2.5722 0 4.6577 2.0897 4.6577 4.667 0 2.5774-2.0855 4.6666-4.6577 4.6666H12.642zM7.9837 7.333h3.3291v12.533c-.9555 0-1.73-.7759-1.73-1.7332V9.0662H7.9837c-1.6146 0-2.9277 1.316-2.9277 2.9334 0 1.6175 1.3131 2.9333 2.9277 2.9333h.6654v1.7332h-.6654c-2.5725 0-4.6577-2.0892-4.6577-4.6665 0-2.5771 2.0852-4.6666 4.6577-4.6666Z" />
		</svg>
	{:else if icon === "polymarket"}
		<!-- Official Polymarket pinned-tab mark from polymarket.com/icons/safari-pinned-tab.svg -->
		<svg viewBox="0 0 2184 2184" role="img" aria-hidden="true" class="brand-logo polymarket-logo">
			<g transform="translate(0 2184) scale(0.1 -0.1)">
				<path fill="currentColor" d="M10445 15709 c-2667 -764 -4860 -1391 -4872 -1394 l-23 -5 0 -3345 0 -3344 23 -7 c79 -25 9722 -2782 9724 -2780 2 1 2 2761 1 6133 l-3 6129 -4850 -1387z m3915 -1910 c0 -1939 -1 -2041 -17 -2037 -160 43 -7100 2032 -7105 2037 -7 6 7068 2037 7105 2040 16 1 17 -102 17 -2040z m-4263 -1806 c1976 -565 3591 -1028 3590 -1029 -4 -4 -7141 -2045 -7169 -2051 l-28 -5 0 2056 c0 1131 3 2056 8 2056 4 0 1623 -462 3599 -1027z m4263 -3864 l0 -2041 -27 5 c-16 3 -1617 460 -3560 1016 -1942 556 -3535 1011 -3539 1011 -4 0 -4 3 0 7 5 6 7095 2040 7119 2042 4 1 7 -918 7 -2040z" />
			</g>
		</svg>
	{:else if icon === "airtable"}
		<!-- Official Simple Icons glyph: https://simpleicons.org/?q=airtable -->
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo airtable-logo">
			<path fill="#18BFFF" d="M11.992 1.966c-.434 0-.87.086-1.28.257L1.779 5.917c-.503.208-.49.908.012 1.116l8.982 3.558a3.266 3.266 0 0 0 2.454 0l8.982-3.558c.503-.196.503-.908.012-1.116l-8.957-3.694a3.255 3.255 0 0 0-1.272-.257zM23.4 8.056a.589.589 0 0 0-.222.045l-10.012 3.877a.612.612 0 0 0-.38.564v8.896a.6.6 0 0 0 .821.552L23.62 18.1a.583.583 0 0 0 .38-.551V8.653a.6.6 0 0 0-.6-.596zM.676 8.095a.644.644 0 0 0-.48.19C.086 8.396 0 8.53 0 8.69v8.355c0 .442.515.737.908.54l6.27-3.006.307-.147 2.969-1.436c.466-.22.43-.908-.061-1.092L.883 8.138a.57.57 0 0 0-.207-.044z" />
		</svg>
	{:else if icon === "go-high-level"}
		<!-- Official HighLevel mark from HighLevel's brand guide help article. -->
		<img src="/source-logos/highlevel-official-help-logo.png" alt="" aria-hidden="true" class="brand-logo ghl-logo" />
	{:else if icon === "clickup"}
		<!-- Official Simple Icons glyph: https://simpleicons.org/?q=clickup -->
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo clickup-logo">
			<path fill="#7B68EE" d="M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z" />
		</svg>
	{:else if icon === "stripe"}
		<!-- Official Simple Icons glyph: https://simpleicons.org/?q=stripe -->
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo stripe-logo">
			<path fill="#635BFF" d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z" />
		</svg>
	{:else if icon === "imap-email"}
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo imap-logo">
			<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="miter" d="M3 6h18v12H3zM3 7l9 6 9-6" />
			<path fill="currentColor" d="M6 15h2v1.5H6zm3.5 0h2v1.5h-2zm3.5 0h2v1.5h-2zm3.5 0h2v1.5h-2z" />
		</svg>
	{:else if icon === "proton-mail"}
		<!-- Official Simple Icons glyph: https://simpleicons.org/?q=protonmail -->
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo proton-logo">
			<path fill="#6D4AFF" d="m15.24 8.998 3.656-3.073v15.81H2.482C1.11 21.735 0 20.609 0 19.223V6.944l7.58 6.38a2.186 2.186 0 0 0 2.871-.042l4.792-4.284h-.003zm-5.456 3.538 1.809-1.616a2.438 2.438 0 0 1-1.178-.533L.905 2.395A.552.552 0 0 0 0 2.826v2.811l8.226 6.923a1.186 1.186 0 0 0 1.558-.024zM23.871 2.463a.551.551 0 0 0-.776-.068l-3.199 2.688v16.653h1.623c1.371 0 2.481-1.127 2.481-2.513V2.824a.551.551 0 0 0-.129-.36z" />
		</svg>
	{:else if icon === "history"}
		<!-- Official Simple Icons glyph: https://simpleicons.org/?q=chrome -->
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo chrome-logo">
			<path
				fill="#4285F4"
				d="M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0zM1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29zm13.342 2.166a5.446 5.446 0 0 1 1.45 7.09l.002.001h-.002l-5.344 9.257c.206.01.413.016.621.016 6.627 0 12-5.373 12-12 0-1.54-.29-3.011-.818-4.364zM12 16.364a4.364 4.364 0 1 1 0-8.728 4.364 4.364 0 0 1 0 8.728Z"
			/>
		</svg>
	{:else}
		<!-- Official Simple Icons glyph: https://simpleicons.org/?q=linear -->
		<svg viewBox="0 0 24 24" role="img" aria-hidden="true" class="brand-logo linear-logo">
			<path
				fill="#5E6AD2"
				d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"
			/>
		</svg>
	{/if}
{/snippet}

<div class="sources-tab">
	<div class="sources-shell">
		<main class="sources-main">
			<header class="sources-masthead">
				<span class="eyebrow">Sources</span>
				<h1>Connect knowledge bases</h1>
				<p>Bring external context into Signet while preserving the original source of truth.</p>
			</header>

			<section class="source-toolbar" aria-label="Source filters">
				<label class="search-box" for="source-search">
					<span><Search /></span>
					<input id="source-search" bind:value={searchTerm} placeholder="Search sources" />
				</label>
				<div class="filter-tabs" role="group" aria-label="Source type filters">
					{#each filters as filter (filter.id)}
						<button class:active={activeFilter === filter.id} type="button" onclick={() => (activeFilter = filter.id)}>
							{filter.label}
						</button>
					{/each}
				</div>
				<div class="read-first">
					<span>Read-only first</span>
					<span class="switch" aria-hidden="true"><span></span></span>
					<Info />
				</div>
			</section>

			<section class="recall-map" aria-label="Source recall diagram">
				<div class="map-grid" aria-hidden="true"></div>
				<div class="map-left map-stack">
					<div class="map-node node-obsidian">{@render sourceLogo("obsidian")}</div>
					<div class="map-node node-github">{@render sourceLogo("github")}</div>
					<div class="map-node node-folder">{@render sourceLogo("folder")}</div>
					<div class="map-node node-csv">{@render sourceLogo("csv")}</div>
					<div class="map-node node-web">{@render sourceLogo("globe")}</div>
				</div>
				<svg class="map-connections" viewBox="0 0 620 240" preserveAspectRatio="none" aria-hidden="true">
					<defs>
						<filter id="wire-glow" x="-20%" y="-20%" width="140%" height="140%">
							<feGaussianBlur stdDeviation="1.5" result="blur" />
							<feMerge>
								<feMergeNode in="blur" />
								<feMergeNode in="SourceGraphic" />
							</feMerge>
						</filter>
					</defs>
					<!-- Base wires -->
					<path d="M 76 38  C 160 38,  250 120, 310 120" class="map-wire" />
					<path d="M 76 84  C 160 84, 250 120, 310 120" class="map-wire" />
					<path d="M 76 130 C 160 130, 250 120, 310 120" class="map-wire" />
					<path d="M 76 176 C 160 176, 250 120, 310 120" class="map-wire" />
					<path d="M 544 38  C 460 38,  370 120, 310 120" class="map-wire" />
					<path d="M 544 84  C 460 84, 370 120, 310 120" class="map-wire" />
					<path d="M 544 130 C 460 130, 370 120, 310 120" class="map-wire" />
					<path d="M 544 176 C 460 176, 370 120, 310 120" class="map-wire" />
					<path d="M 544 222 C 460 222, 370 120, 310 120" class="map-wire" />
					<!-- Animated packets -->
					<path d="M 76 38  C 160 38,  250 120, 310 120" class="map-packet" style="animation-delay: 0s;" />
					<path d="M 76 84  C 160 84, 250 120, 310 120" class="map-packet" style="animation-delay: -0.6s;" />
					<path d="M 76 130 C 160 130, 250 120, 310 120" class="map-packet" style="animation-delay: -1.2s;" />
					<path d="M 76 176 C 160 176, 250 120, 310 120" class="map-packet" style="animation-delay: -1.8s;" />
					<path d="M 544 38  C 460 38,  370 120, 310 120" class="map-packet" style="animation-delay: -0.3s;" />
					<path d="M 544 84  C 460 84, 370 120, 310 120" class="map-packet" style="animation-delay: -0.9s;" />
					<path d="M 544 130 C 460 130, 370 120, 310 120" class="map-packet" style="animation-delay: -1.5s;" />
					<path d="M 544 176 C 460 176, 370 120, 310 120" class="map-packet" style="animation-delay: -2.1s;" />
					<path d="M 544 222 C 460 222, 370 120, 310 120" class="map-packet" style="animation-delay: -2.7s;" />
				</svg>
				<div class="map-center">
					<img src="/logo-dark.png" alt="Signet" class="map-logo" />
					<span class="map-tagline">Bring context to your agent</span>
				</div>
				<div class="map-right map-stack">
					<div class="map-node node-drive">{@render sourceLogo("drive")}</div>
					<div class="map-node node-notion">{@render sourceLogo("notion")}</div>
					<div class="map-node node-nextcloud">{@render sourceLogo("nextcloud")}</div>
					<div class="map-node node-postgres">{@render sourceLogo("postgres")}</div>
					<div class="map-node node-supabase">{@render sourceLogo("supabase")}</div>
					<div class="map-node node-x-bookmarks">{@render sourceLogo("x-bookmarks")}</div>
				</div>
				<div class="map-counts"><span>{connectedCount} connected</span><span>{indexedCount} indexed</span></div>
			</section>

			{#if discordSources.length > 0 && selectedDiscordSource}
				{@const source = selectedDiscordSource}
				<section class="discord-operations" aria-label="Discord source operations">
					<header class="discord-operations__header">
						<div>
							<span class="section-label">Discord operations</span>
							<p>Monitor bot REST, gateway tailing, and desktop-cache Discord sources without leaving source management.</p>
						</div>
						<button class="discord-operations__refresh" type="button" disabled={loading} onclick={() => void refreshSources()}>
							<RefreshCw />
							Refresh
						</button>
					</header>

					{#if discordSources.length > 1}
						<div class="discord-source-switcher" role="tablist" aria-label="Discord sources">
							{#each discordSources as option (option.id)}
								<button
									type="button"
									role="tab"
									aria-selected={option.id === source.id}
									class:active={option.id === source.id}
									onclick={() => (selectedDiscordSourceId = option.id)}
								>
									<span>{option.name}</span>
									<small>{discordModeLabel(option)}</small>
								</button>
							{/each}
						</div>
					{/if}

					<div class="discord-detail">
						<div class="discord-panel">
							<div class="discord-panel__head">
								<div>
									<strong>{source.name}</strong>
									<code>{source.root}</code>
								</div>
								<span class={`source-health-pill source-health-pill--${sourceHealthTone(source)}`}>
									{sourceHealthLabel(source)}
								</span>
							</div>

							<div class="discord-metrics" aria-label="Discord indexed coverage">
								<div class="discord-metric">
									<span>Artifacts</span>
									<strong>{(source.stats?.artifacts ?? 0).toLocaleString()}</strong>
								</div>
								<div class="discord-metric">
									<span>Chunks</span>
									<strong>{(source.stats?.chunks ?? 0).toLocaleString()}</strong>
								</div>
								<div class="discord-metric">
									<span>Indexed</span>
									<strong>{(source.stats?.indexed ?? 0).toLocaleString()}</strong>
								</div>
								<div class="discord-metric">
									<span>Graph rows</span>
									<strong>{(source.health?.semantic?.total ?? 0).toLocaleString()}</strong>
								</div>
							</div>

							{#if source.indexJob?.status === "queued" || source.indexJob?.status === "running"}
								<div class="source-index-progress">
									<div class="source-index-progress__head">
										<span>{source.indexJob.status === "queued" ? "Queued" : "Indexing"}</span>
										<strong>{sourceIndexPercent(source)}%</strong>
									</div>
									<div
										class="source-index-progress__bar"
										role="progressbar"
										aria-valuemin="0"
										aria-valuemax="100"
										aria-valuenow={sourceIndexPercent(source)}
										aria-label={`Indexing ${source.name}`}
									>
										<span style={`width: ${sourceIndexPercent(source)}%`}></span>
									</div>
									{#if sourceIndexCurrentPath(source)}
										<code class="source-index-progress__path">{sourceIndexCurrentPath(source)}</code>
									{/if}
								</div>
							{/if}

							<div class="discord-settings-grid" aria-label="Discord source settings">
								<div class="discord-setting">
									<span>Mode</span>
									<strong>{discordModeLabel(source)}</strong>
								</div>
								<div class="discord-setting">
									<span>Guilds</span>
									<strong>{discordGuildLabel(source)}</strong>
								</div>
								<div class="discord-setting">
									<span>Channels</span>
									<strong>{compactListLabel(sourceSettingStringList(source, "channelFilter"), "All visible channels")}</strong>
								</div>
								<div class="discord-setting">
									<span>Message cap</span>
									<strong>{sourceSettingNumber(source, "maxMessagesPerChannel")?.toLocaleString() ?? "Default"}</strong>
								</div>
								<div class="discord-setting">
									<span>Since</span>
									<strong>{formatDateOnly(sourceSettingString(source, "since"), "No lower bound")}</strong>
								</div>
								<div class="discord-setting">
									<span>Members</span>
									<strong>{discordYesNo(source, "includeMembers")}</strong>
								</div>
								<div class="discord-setting">
									<span>Threads</span>
									<strong>{discordYesNo(source, "includeThreads")}</strong>
								</div>
								<div class="discord-setting">
									<span>Archived</span>
									<strong>{discordYesNo(source, "includeArchivedThreads")}</strong>
								</div>
								<div class="discord-setting">
									<span>Private archived</span>
									<strong>{discordYesNo(source, "includePrivateArchivedThreads", false)}</strong>
								</div>
								<div class="discord-setting">
									<span>Thread members</span>
									<strong>{discordYesNo(source, "includeThreadMembers")}</strong>
								</div>
								<div class="discord-setting">
									<span>Attachments</span>
									<strong>{discordYesNo(source, "includeAttachments")}</strong>
								</div>
								<div class="discord-setting">
									<span>Attachment text</span>
									<strong>{discordAttachmentTextLabel(source)}</strong>
								</div>
								<div class="discord-setting">
									<span>Embeds</span>
									<strong>{discordYesNo(source, "includeEmbeds")}</strong>
								</div>
								<div class="discord-setting">
									<span>Polls</span>
									<strong>{discordYesNo(source, "includePolls")}</strong>
								</div>
							</div>
						</div>

						<div class="discord-panel discord-panel--status">
							<div class="discord-health-grid" aria-label="Discord source health">
								<div>
									<span>Latest artifact</span>
									<strong>{formatOptionalDate(source.health?.latestArtifactAt)}</strong>
								</div>
								<div>
									<span>Latest checkpoint</span>
									<strong>{formatOptionalDate(source.health?.latestCheckpointAt)}</strong>
								</div>
								<div>
									<span>Checkpoints</span>
									<strong>{(source.health?.checkpoints?.total ?? 0).toLocaleString()}</strong>
								</div>
								<div>
									<span>Partial / stale</span>
									<strong>{source.health?.checkpoints?.partial ?? 0} / {source.health?.checkpoints?.stale ?? 0}</strong>
								</div>
								<div>
									<span>Fetch failures</span>
									<strong>{source.health?.failures?.recoverable ?? 0} recoverable / {source.health?.failures?.total ?? 0} total</strong>
								</div>
								<div>
									<span>Chunk coverage</span>
									<strong>{Math.round((source.health?.chunkCoverage ?? 0) * 100)}%</strong>
								</div>
								<div>
									<span>Purge residue</span>
									<strong>{source.health?.purge?.deletedArtifacts ?? 0} deleted / {source.health?.purge?.orphanChunks ?? 0} orphan chunks</strong>
								</div>
								<div>
									<span>Enabled</span>
									<strong>{source.enabled ? "Yes" : "No"}</strong>
								</div>
							</div>

							<div class="discord-actions">
								<div class="source-ops">
									<div class="source-ops__buttons">
										<button
											class="source-action-button"
											type="button"
											disabled={snapshotBusySourceId === source.id}
											onclick={() => void exportSnapshot(source)}
										>
											{#if snapshotBusySourceId === source.id}<span class="spin"><RefreshCw /></span>{:else}<Download />{/if}
											Export snapshot
										</button>
										<label class="source-action-button" class:source-action-button--disabled={snapshotBusySourceId === source.id}>
											{#if snapshotBusySourceId === source.id}<span class="spin"><RefreshCw /></span>{:else}<Upload />{/if}
											Import snapshot
											<input
												class="snapshot-file-input"
												type="file"
												accept="application/json,.json"
												disabled={snapshotBusySourceId === source.id}
												onchange={(event) => void importSnapshotFile(source, event)}
											/>
										</label>
									</div>
									<label class="source-option-row source-option-row--compact">
										<input
											checked={snapshotIncludesLocalDiscord(source.id)}
											type="checkbox"
											onchange={(event) => setSnapshotIncludesLocalDiscord(source.id, event.currentTarget.checked)}
										/>
										<span>Include local Discord cache</span>
									</label>
								</div>
								<button
									class="disconnect-button"
									type="button"
									disabled={removingSourceId === source.id}
									onclick={() => void disconnectSource(source)}
								>
									{#if removingSourceId === source.id}<span class="spin"><RefreshCw /></span>{:else}<X />{/if}
									{removingSourceId === source.id ? "Removing" : "Disconnect Discord"}
								</button>
							</div>
						</div>
					</div>
				</section>
			{/if}

			<section id="featured-sources" class="featured-panel" aria-label="Featured sources">
				<header class="section-label">Featured sources</header>
				<div class="connector-grid" class:has-expanded={expandedKind !== null}>
					{#each filteredConnectors as connector (connector.kind)}
						{@const expanded = expandedKind === connector.kind}
						{@const connectedSources = connector.kind === "obsidian" ? obsidianSources : connector.kind === "discord" ? discordSources : connector.kind === "github" ? githubSources : []}
						{@const isConnected = connectedSources.length > 0}
						<article class="connector-card" class:expanded class:connected={isConnected} class:compressed={expandedKind !== null && !expanded}>
							<button
								class="connector-row"
								class:selected={expanded}
								type="button"
								aria-expanded={expanded}
								onclick={() => selectConnector(connector.kind)}
							>
								<span class={`connector-icon icon-${connector.icon}`}>
									{@render sourceLogo(connector.icon)}
								</span>
								<span class="connector-copy">
									<strong>{isConnected && connectedSources[0] ? connectedSources[0].name : connector.name}</strong>
									<small>{isConnected && connectedSources[0] ? sourceScanLabel(connectedSources[0]) : connector.detail}</small>
								</span>
								<span class="connector-action" class:available={connector.status === "available"} class:connected={isConnected}>
									{#if isConnected}
										<CheckCircle2 />
									{:else if expanded}
										<X />
									{:else if connector.status === "available"}
										<Check />
									{:else if connector.status === "planned"}
										<em>Planned</em>
									{:else}
										<Plus />
									{/if}
								</span>
							</button>

							<div class="connector-expand" class:open={expanded} aria-hidden={!expanded}>
								<p class="connector-description">{connector.description}</p>

								{#if loading && connector.status === "available"}
									<p class="connected-loading">Checking source registry...</p>
								{:else if isConnected}
									<div class="connected-list connected-list--inline">
										{#each connectedSources as source (source.id)}
											<article class="connected-row connected-row--inline">
												<div class="connected-main">
													<div class="connected-title-row">
														<strong>{source.name}</strong>
														<span class="status-badge status-badge--connected">Connected</span>
													</div>
													<code>{source.root}</code>
												</div>
												<ul>
													<li><CheckCircle2 /> {source.enabled ? "Enabled" : "Disabled"}</li>
													<li><Database /> {sourceScanLabel(source)}</li>
													<li class={`source-health source-health--${sourceHealthTone(source)}`}>
														<Info /> {sourceHealthLabel(source)}
													</li>
													<li><Database /> Last complete scan: {formatDate(source.lastIndexedAt)}</li>
												</ul>
												{#if source.indexJob?.status === "queued" || source.indexJob?.status === "running"}
													<div class="source-index-progress">
														<div class="source-index-progress__head">
															<span>{source.indexJob.status === "queued" ? "Queued" : "Indexing"}</span>
															<strong>{sourceIndexPercent(source)}%</strong>
														</div>
														<div
															class="source-index-progress__bar"
															role="progressbar"
															aria-valuemin="0"
															aria-valuemax="100"
															aria-valuenow={sourceIndexPercent(source)}
															aria-label={`Indexing ${source.name}`}
														>
															<span style={`width: ${sourceIndexPercent(source)}%`}></span>
														</div>
														{#if sourceIndexCurrentPath(source)}
															<code class="source-index-progress__path">{sourceIndexCurrentPath(source)}</code>
														{/if}
													</div>
												{/if}
												{#if source.excludeGlobs?.length}
													<div class="exclude-summary">
														<span>Ignoring</span>
														<code>{source.excludeGlobs.join(", ")}</code>
													</div>
												{/if}
												<div class="source-ops">
													<div class="source-ops__buttons">
														<button
															class="source-action-button"
															type="button"
															disabled={snapshotBusySourceId === source.id}
															onclick={() => void exportSnapshot(source)}
														>
															{#if snapshotBusySourceId === source.id}<span class="spin"><RefreshCw /></span>{:else}<Download />{/if}
															Export snapshot
														</button>
														<label class="source-action-button" class:source-action-button--disabled={snapshotBusySourceId === source.id}>
															{#if snapshotBusySourceId === source.id}<span class="spin"><RefreshCw /></span>{:else}<Upload />{/if}
															Import snapshot
															<input
																class="snapshot-file-input"
																type="file"
																accept="application/json,.json"
																disabled={snapshotBusySourceId === source.id}
																onchange={(event) => void importSnapshotFile(source, event)}
															/>
														</label>
													</div>
													{#if source.kind === "discord"}
														<label class="source-option-row source-option-row--compact">
															<input
																checked={snapshotIncludesLocalDiscord(source.id)}
																type="checkbox"
																onchange={(event) =>
																	setSnapshotIncludesLocalDiscord(source.id, event.currentTarget.checked)}
															/>
															<span>Include local Discord cache</span>
														</label>
													{/if}
												</div>
												<button
													class="disconnect-button"
													type="button"
													disabled={removingSourceId === source.id}
													onclick={() => void disconnectSource(source)}
												>
													{#if removingSourceId === source.id}<span class="spin"><RefreshCw /></span>{:else}<X />{/if}
													{removingSourceId === source.id ? "Removing" : source.kind === "discord" ? "Disconnect Discord" : source.kind === "github" ? "Disconnect GitHub" : "Disconnect vault"}
												</button>
											</article>
										{/each}
									</div>
								{:else if connector.status === "available"}
									{#if !connectMode || !expanded}
										<button class="connect-button" type="button" disabled={!expanded} onclick={() => (connectMode = true)}>
											<Link2 /> Connect
										</button>
									{/if}

									{#if connectMode && expanded && connector.kind === "obsidian"}
										<form class="connect-form" onsubmit={(event) => { event.preventDefault(); void submitSource(); }}>
											<label>
												<span>Display name</span>
												<input bind:value={vaultName} placeholder="Obsidian Vault" />
											</label>
											<label>
												<span>Vault folder</span>
												<div class="path-row">
													<input bind:value={vaultPath} placeholder="Choose your vault folder..." onblur={() => (touchedPath = true)} />
													<button type="button" onclick={() => void chooseFolder()} disabled={pickingFolder}>
														<FolderOpen /> {pickingFolder ? "Opening" : "Browse"}
													</button>
												</div>
											</label>
											{#if touchedPath && pathIsMissing}<p class="field-error">Vault folder is required.</p>{/if}
											<label>
												<span>Ignore globs</span>
												<textarea bind:value={excludeGlobsText} rows="5" placeholder="**/.*/**&#10;**/node_modules/**"></textarea>
												<small class="field-hint">One glob per line or comma. Default ignores Obsidian internals, trash, Hermes metadata, hidden dot-folders, and hidden files.</small>
											</label>
											<button class="connect-button" type="submit" disabled={!canSubmit}>
												{#if adding}<span class="spin"><RefreshCw /></span>{:else}<CirclePlus />{/if}
												{adding ? "Indexing" : "Add source"}
											</button>
										</form>
									{/if}
									{#if connectMode && expanded && connector.kind === "discord"}
										<form class="connect-form" onsubmit={(event) => { event.preventDefault(); void submitDiscordSource(); }}>
											<label>
												<span>Display name</span>
												<input bind:value={discordName} placeholder="Team Discord" />
											</label>
											<label>
												<span>Mode</span>
												<select bind:value={discordSyncMode}>
													<option value="rest">Bot REST</option>
													<option value="gateway-tail">Gateway tail</option>
													<option value="desktop-cache">Desktop cache</option>
												</select>
											</label>
											{#if discordUsesDesktopCache}
												<label>
													<span>Desktop data folder</span>
													<div class="path-row">
														<input bind:value={discordDesktopCachePath} placeholder="Use detected Discord folder" />
														<button type="button" onclick={() => void chooseDiscordCacheFolder()} disabled={pickingFolder}>
															<FolderOpen /> {pickingFolder ? "Opening" : "Browse"}
														</button>
													</div>
													<small class="field-hint">Leave blank to use the platform default Discord Desktop data folder.</small>
												</label>
												<label class="source-option-row">
													<input bind:checked={discordDesktopCacheFullScan} type="checkbox" />
													<span>Full cache scan</span>
												</label>
											{:else}
												<label>
													<span>Guild IDs</span>
													<textarea
														bind:value={discordGuildIdsText}
														rows="3"
														placeholder="123456789012345678&#10;223456789012345678"
														onblur={() => (touchedDiscord = true)}
													></textarea>
													<small class="field-hint">One guild snowflake per line or comma. The bot token must already have access.</small>
												</label>
												{#if touchedDiscord && discordGuildsMissing}<p class="field-error">At least one Discord guild ID is required.</p>{/if}
												<label>
													<span>Token reference</span>
													<input
														bind:value={discordTokenRef}
														placeholder="DISCORD_BOT_TOKEN"
														onblur={() => (touchedDiscord = true)}
													/>
													<small class="field-hint">Use a Signet secret name or external secret reference. Raw Discord tokens are rejected.</small>
												</label>
												{#if touchedDiscord && discordTokenMissing}<p class="field-error">A Discord bot token reference is required.</p>{/if}
												<label>
													<span>Channel filter</span>
													<textarea bind:value={discordChannelFilterText} rows="3" placeholder="general&#10;123456789012345679"></textarea>
													<small class="field-hint">Optional channel names or IDs. Leave blank to index every bot-visible channel and thread.</small>
												</label>
												<div class="discord-options-grid">
												<label>
													<span>Message cap</span>
													<input bind:value={discordMaxMessages} type="number" min="1" max="10000" />
												</label>
												<label>
													<span>Since</span>
													<input bind:value={discordSince} placeholder="2026-01-01" />
												</label>
												</div>
												<div class="source-option-grid" aria-label="Discord source options">
													<label class="source-option-row">
														<input bind:checked={discordIncludeMembers} type="checkbox" />
														<span>Members</span>
													</label>
													<label class="source-option-row">
														<input bind:checked={discordIncludeThreads} type="checkbox" />
														<span>Threads</span>
													</label>
													<label class="source-option-row">
														<input bind:checked={discordIncludeArchivedThreads} type="checkbox" />
														<span>Archived threads</span>
													</label>
													<label class="source-option-row">
														<input bind:checked={discordIncludePrivateArchivedThreads} type="checkbox" />
														<span>Private archived threads</span>
													</label>
													<label class="source-option-row">
														<input bind:checked={discordIncludeThreadMembers} type="checkbox" />
														<span>Thread members</span>
													</label>
													<label class="source-option-row">
														<input bind:checked={discordIncludeAttachments} type="checkbox" />
														<span>Attachments</span>
													</label>
													<label class="source-option-row">
														<input bind:checked={discordIncludeAttachmentText} disabled={!discordIncludeAttachments} type="checkbox" />
														<span>Attachment text</span>
													</label>
													<label class="source-option-row">
														<input bind:checked={discordIncludeEmbeds} type="checkbox" />
														<span>Embeds</span>
													</label>
													<label class="source-option-row">
														<input bind:checked={discordIncludePolls} type="checkbox" />
														<span>Polls</span>
													</label>
												</div>
												{#if discordIncludeAttachmentText && discordIncludeAttachments}
													<label>
														<span>Attachment text bytes</span>
														<input bind:value={discordMaxAttachmentTextBytes} type="number" min="1" max="1048576" />
														<small class="field-hint">Only small text-like uploads are fetched. Binary media stays disabled.</small>
													</label>
												{/if}
											{/if}
											<button class="connect-button" type="submit" disabled={!canSubmit}>
												{#if adding}<span class="spin"><RefreshCw /></span>{:else}<CirclePlus />{/if}
												{adding ? "Queueing" : "Add source"}
											</button>
										</form>
									{/if}
									{#if connectMode && expanded && connector.kind === "github"}
										<form class="connect-form" onsubmit={(event) => { event.preventDefault(); void submitGitHubSource(); }}>
											<label>
												<span>Display name</span>
												<input bind:value={githubName} placeholder="GitHub" />
											</label>
											<label>
												<span>Repositories</span>
												<textarea
													bind:value={githubReposText}
													rows="3"
													placeholder="Signet-AI/signetai&#10;Signet-AI/*"
													onblur={() => (touchedGithub = true)}
												></textarea>
												<small class="field-hint">One owner/repo or owner/* pattern per line. Public repositories work without a token.</small>
											</label>
											{#if touchedGithub && githubReposMissing}<p class="field-error">At least one GitHub repository is required.</p>{/if}
											<label>
												<span>Secret reference</span>
												<input
													bind:value={githubTokenRef}
													placeholder="GITHUB_TOKEN"
													onblur={() => (touchedGithub = true)}
												/>
												<small class="field-hint">Optional Signet secret name for private repositories, higher rate limits, and discussions. Do not paste a raw token.</small>
											</label>
											<div class="github-options-grid">
												<label>
													<span>State</span>
													<select bind:value={githubState}>
														<option value="all">Open and closed</option>
														<option value="open">Open only</option>
														<option value="closed">Closed only</option>
													</select>
												</label>
												<label>
													<span>Item cap</span>
													<input
														bind:value={githubMaxItems}
														type="number"
														min="1"
														max="10000"
														onblur={() => (touchedGithub = true)}
													/>
												</label>
											</div>
											{#if touchedGithub && githubMaxItemsInvalid}<p class="field-error">Item cap must be a whole number of at least 1.</p>{/if}
											<div class="source-option-grid" aria-label="GitHub source resources">
												<label class="source-option-row">
													<input bind:checked={githubIncludeIssues} type="checkbox" />
													<span>Issues</span>
												</label>
												<label class="source-option-row">
													<input bind:checked={githubIncludePulls} type="checkbox" />
													<span>Pull requests</span>
												</label>
												<label class="source-option-row">
													<input bind:checked={githubIncludeDocs} type="checkbox" />
													<span>Docs</span>
												</label>
												<label class="source-option-row">
													<input bind:checked={githubIncludeDiscussions} type="checkbox" />
													<span>Discussions</span>
												</label>
											</div>
											{#if touchedGithub && githubResourceTypesMissing}<p class="field-error">Choose at least one GitHub resource type.</p>{/if}
											{#if touchedGithub && githubTokenMissingForDiscussions}<p class="field-error">Discussions require a GitHub secret reference.</p>{/if}
											<label class="source-option-row">
												<input bind:checked={githubIncludeComments} type="checkbox" />
												<span>Include comments</span>
											</label>
											<label>
												<span>Labels</span>
												<textarea bind:value={githubLabelsText} rows="3" placeholder="bug&#10;docs"></textarea>
												<small class="field-hint">Optional labels for issue and PR indexing. Leave blank to include all labels.</small>
											</label>
											<label>
												<span>Doc paths</span>
												<textarea bind:value={githubDocPathsText} rows="4" placeholder="README.md&#10;docs/**/*.md"></textarea>
												<small class="field-hint">Use exact files or globs. Defaults cover README and changelog without crawling the whole repository.</small>
											</label>
											<button class="connect-button" type="submit" disabled={!canSubmit}>
												{#if adding}<span class="spin"><RefreshCw /></span>{:else}<CirclePlus />{/if}
												{adding ? "Queueing" : "Add source"}
											</button>
										</form>
									{/if}
								{:else}
									<p class="form-status form-status--info">Planned source. Not connectable yet.</p>
								{/if}

								{#if selectedKind === connector.kind && status}<p class="form-status form-status--info">{status}</p>{/if}
								{#if selectedKind === connector.kind && error}<p class="form-status form-status--error">{error}</p>{/if}
							</div>
						</article>
					{/each}
				</div>
				<footer>{connectors.filter((connector) => connector.status === "available").length} live / {connectors.filter((connector) => connector.status === "planned").length} planned sources</footer>
			</section>

		</main>

	</div>
</div>

<style>
	.sources-tab {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		box-sizing: border-box;
		padding: 8px var(--space-md) 6px;
		color: var(--sig-text);
	}

	.sources-shell {
		display: grid;
		grid-template-columns: 1fr;
		grid-template-rows: minmax(0, 1fr);
		gap: var(--space-sm);
		height: 100%;
		min-height: 0;
		max-width: 780px;
		overflow: hidden;
		margin: 0 auto;
		transition: max-width 0.3s var(--ease);
	}


	.sources-main {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		max-width: 780px;
		height: 100%;
		max-height: 100%;
		overflow-x: hidden;
		overflow-y: auto;
		overflow-y: overlay;
		scrollbar-width: none;
		overscroll-behavior: contain;
		padding-bottom: 18px;
		margin: 0 auto;
		width: 100%;
	}

	.sources-main::-webkit-scrollbar,
	.connector-grid::-webkit-scrollbar {
		width: 0;
		height: 0;
	}


	.eyebrow,
	.section-label,
	.filter-tabs button,
	.read-first,
	.map-counts,
	.connector-copy small,
	.featured-panel footer,
	.tag-row,
	.connected-loading,
	.removal-note,
	.connected-row code,
	.connected-row li,
	.connect-form label span,
	.form-status,
	.field-error {
		font-family: var(--font-body);
	}

	.sources-masthead {
		padding: 6px 2px 7px;
	}

	.eyebrow {
		display: block;
		margin-bottom: 6px;
		font-size: 9px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--sig-accent);
	}

	h1,
	p {
		margin: 0;
	}

	h1 {
		font-family: var(--font-display);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--sig-text-bright);
	}

	h1 {
		font-size: clamp(17px, 2vw, 24px);
		line-height: 1;
	}

	.sources-masthead p {
		margin-top: 6px;
		font-size: 11px;
		line-height: 1.5;
		color: var(--sig-text-muted);
	}

	.source-toolbar {
		display: grid;
		grid-template-columns: minmax(160px, 210px) minmax(0, auto) max-content;
		gap: var(--space-sm);
		align-items: center;
		margin-bottom: 6px;
	}

	.search-box {
		display: grid;
		grid-template-columns: auto 1fr;
		align-items: center;
		gap: 8px;
		height: 30px;
		border: 1px solid var(--sig-border);
		border-radius: 0;
		background: var(--sig-surface-raised);
		padding: 0 10px;
	}

	.search-box span,
	.read-first :global(svg) {
		display: inline-flex;
		color: var(--sig-text-muted);
	}

	.search-box :global(svg),
	.read-first :global(svg) {
		width: 15px;
		height: 15px;
	}

	.search-box input {
		min-width: 0;
		border: 0;
		background: transparent;
		font: 12px var(--font-mono);
		color: var(--sig-text-bright);
		outline: none;
	}

	.filter-tabs {
		display: inline-grid;
		grid-template-columns: repeat(7, auto);
		border: 1px solid var(--sig-border);
		border-radius: 0;
		overflow: hidden;
	}

	.filter-tabs button {
		height: 30px;
		min-width: 46px;
		border: 0;
		border-right: 1px solid var(--sig-border);
		background: var(--sig-surface);
		color: var(--sig-text-muted);
		font-size: 10px;
		cursor: pointer;
		transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease);
	}

	.filter-tabs button:last-child {
		border-right: 0;
	}

	.filter-tabs button.active {
		background: var(--sig-surface-raised);
		color: var(--sig-text-bright);
		box-shadow: inset 0 0 0 1px var(--sig-border-strong);
	}

	.read-first {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 6px;
		font-size: 11px;
		color: var(--sig-text);
		white-space: nowrap;
	}

	.switch {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		width: 24px;
		height: 13px;
		border: 1px solid var(--sig-border-strong);
		border-radius: 0;
		background: var(--sig-surface-raised);
		padding: 1px;
	}

	.switch span {
		width: 9px;
		height: 9px;
		border-radius: 0;
		background: var(--sig-accent);
	}

	.recall-map {
		position: relative;
		min-height: 160px;
		border: 1px solid var(--sig-border-strong);
		border-radius: var(--radius);
		background:
			radial-gradient(ellipse at 50% 55%, rgba(10, 57, 255, 0.06) 0%, transparent 60%),
			var(--sig-surface);
		overflow: hidden;
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 2px 4px rgba(0, 0, 0, 0.3);
	}

	.map-grid {
		position: absolute;
		inset: 0;
		background-image:
			linear-gradient(var(--sig-grid-line) 1px, transparent 1px),
			linear-gradient(90deg, var(--sig-grid-line) 1px, transparent 1px),
			radial-gradient(circle, var(--sig-border-strong) 1.5px, transparent 2px);
		background-size: 40px 40px, 40px 40px, 40px 40px;
		background-position: 0 0, 0 0, -1px -1px;
		mask-image: radial-gradient(ellipse at 50% 50%, #000 30%, transparent 75%);
		opacity: 0.7;
	}

	.map-stack {
		position: absolute;
		display: grid;
		gap: 14px;
		z-index: 2;
	}

	.map-left {
		top: 14px;
		left: 50px;
		gap: 10px;
	}

	.map-right {
		top: 14px;
		right: 50px;
		gap: 10px;
	}

	.map-node,
	.connector-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--sig-text-bright);
	}

	.map-node {
		border: 1px solid var(--sig-border);
		background: var(--sig-surface-raised);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
	}

	.map-node {
		width: 28px;
		height: 28px;
		border-radius: 0;
		position: relative;
		animation: node-float 6s ease-in-out infinite;
	}

	.map-node::before {
		content: "";
		position: absolute;
		inset: -1px;
		border: 1px solid var(--sig-border-strong);
		opacity: 0.5;
		animation: node-pulse 4s ease-in-out infinite;
	}

	.map-node:nth-child(2) { animation-delay: -1.5s; }
	.map-node:nth-child(3) { animation-delay: -3s; }
	.map-node:nth-child(4) { animation-delay: -4.5s; }
	.map-node:nth-child(5) { animation-delay: -2s; }

	.map-right .map-node:nth-child(1) { animation-delay: -0.5s; }
	.map-right .map-node:nth-child(2) { animation-delay: -2.5s; }
	.map-right .map-node:nth-child(3) { animation-delay: -3.5s; }
	.map-right .map-node:nth-child(4) { animation-delay: -5s; }
	.map-right .map-node:nth-child(5) { animation-delay: -1s; }

	.map-node :global(svg),
	.connector-icon :global(svg), :global(svg) {
		width: 16px;
		height: 16px;
	}

	.brand-logo {
		display: block;
		width: 19px;
		height: 19px;
		filter: saturate(0.96);
	}

	.connector-icon .brand-logo,
	.map-node .brand-logo {
		width: 20px;
		height: 20px;
	}

	.notion-logo,
	.mdn-logo,
	.github-logo {
		border-radius: 0;
		background: #ffffff;
	}

	.github-logo {
		padding: 2px;
		color: #181717;
	}

	.notion-logo {
		filter: none;
		padding: 2px;
	}

	.mdn-logo {
		padding: 3px;
	}

	.gmail-logo {
		border-radius: 0;
	}

	.ghl-logo {
		width: 24px;
		height: 24px;
		object-fit: contain;
		filter: saturate(1.08) contrast(1.05);
	}

	.icon-obsidian {
		color: #a276ff;
	}

	.node-obsidian {
		color: #a276ff;
		background: var(--sig-surface-raised);
	}

	.icon-folder,
	.node-folder {
		color: #f4c963;
	}

	.icon-csv,
	.node-csv {
		color: #d7dce6;
	}

	.icon-postgres,
	.node-postgres {
		color: #6f8fff;
	}

	.icon-supabase,
	.node-supabase {
		color: #3fcf8e;
	}

	.icon-globe,
	.node-web {
		color: #2288ff;
	}

	.icon-github,
	.node-github {
		color: #f5f5f5;
	}

	.icon-drive,
	.node-drive {
		color: #36a852;
	}

	.icon-gmail,
	.node-gmail {
		color: #f15b47;
	}

	.icon-nextcloud,
	.node-nextcloud {
		color: #62a8ff;
	}

	.icon-x-bookmarks,
	.node-x-bookmarks {
		color: var(--sig-text-bright);
	}

	.icon-discord { color: #8ea0ff; }
	.icon-telegram { color: #5dc7ff; }
	.icon-quickbooks { color: #58d84a; }
	.icon-polymarket { color: #5f83ff; }
	.icon-airtable { color: #f6c04c; }
	.icon-go-high-level { color: #42e6bf; }
	.icon-clickup { color: #9b8cff; }
	.icon-stripe { color: #8d88ff; }
	.icon-imap-email { color: #d7dce6; }
	.icon-proton-mail { color: #9a83ff; }

	.icon-notion,
	.icon-history,
	.icon-linear,
	.node-notion,
	.node-linear,
	.node-history {
		color: var(--sig-text-bright);
	}

	.map-connections {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		z-index: 1;
		pointer-events: none;
	}

	.map-wire {
		fill: none;
		stroke: var(--sig-border-strong);
		stroke-width: 1;
	}

	.map-packet {
		fill: none;
		stroke: var(--sig-highlight-text);
		stroke-width: 2.5;
		stroke-linecap: round;
		stroke-dasharray: 4 140;
		animation: packet-flow 3s linear infinite;
		filter: url(#wire-glow);
	}

	.map-center {
		position: absolute;
		left: 50%;
		top: 50%;
		z-index: 4;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		transform: translate(-50%, -50%);
		text-align: center;
	}

	.map-logo {
		width: 36px;
		height: 36px;
		opacity: 0.9;
	}

	.map-tagline {
		font-family: var(--font-body);
		font-size: 10px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
		white-space: nowrap;
	}

	.map-counts {
		position: absolute;
		right: 14px;
		bottom: 12px;
		z-index: 4;
		display: flex;
		gap: 12px;
		font-size: 11px;
		color: var(--sig-text-muted);
	}

	.map-counts span + span::before {
		content: "|";
		margin-right: 12px;
		color: var(--sig-border-strong);
	}

	.featured-panel {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		min-height: 0;
		margin-top: 10px;
	}

	.connected-panel {
		margin-top: var(--space-sm);
		background: var(--sig-surface);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: var(--radius);
		overflow: hidden;
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 2px 4px rgba(0, 0, 0, 0.3);
	}

	.discord-operations {
		display: grid;
		gap: 10px;
		margin-top: 10px;
		border: 1px solid var(--sig-border-strong);
		border-radius: 0;
		background: var(--sig-surface);
		padding: 10px;
		box-shadow: inset 2px 0 0 rgba(88, 101, 242, 0.42), 0 2px 4px rgba(0, 0, 0, 0.3);
	}

	.discord-operations__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 14px;
	}

	.discord-operations__header .section-label {
		padding: 0 0 4px;
	}

	.discord-operations__header p {
		font-size: 11px;
		line-height: 1.45;
		color: var(--sig-text-muted);
	}

	.discord-operations__refresh {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		height: 28px;
		border: 1px solid var(--sig-border-strong);
		border-radius: 0;
		background: var(--sig-surface-raised);
		padding: 0 10px;
		color: var(--sig-text);
		font: 10px var(--font-mono);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		cursor: pointer;
	}

	.discord-operations__refresh:hover:not(:disabled) {
		border-color: var(--sig-accent);
		color: var(--sig-text-bright);
	}

	.discord-operations__refresh:disabled {
		cursor: wait;
		opacity: 0.62;
	}

	.discord-operations__refresh :global(svg) {
		width: 13px;
		height: 13px;
	}

	.discord-source-switcher {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
		border: 1px solid var(--sig-border);
	}

	.discord-source-switcher button {
		display: grid;
		gap: 2px;
		border: 0;
		border-right: 1px solid var(--sig-border);
		background: transparent;
		padding: 8px 10px;
		text-align: left;
		color: var(--sig-text);
		cursor: pointer;
	}

	.discord-source-switcher button:last-child {
		border-right: 0;
	}

	.discord-source-switcher button.active,
	.discord-source-switcher button:hover {
		background: var(--sig-surface-raised);
	}

	.discord-source-switcher span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
		color: var(--sig-text-bright);
	}

	.discord-source-switcher small {
		font: 9px var(--font-mono);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
	}

	.discord-detail {
		display: grid;
		grid-template-columns: minmax(0, 1.45fr) minmax(230px, 0.8fr);
		gap: 10px;
	}

	.discord-panel {
		display: grid;
		align-content: start;
		gap: 10px;
		border: 1px solid var(--sig-border);
		border-radius: 0;
		background: var(--sig-surface-raised);
		padding: 10px;
		min-width: 0;
	}

	.discord-panel--status {
		background: rgba(255, 255, 255, 0.02);
	}

	.discord-panel__head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
		min-width: 0;
	}

	.discord-panel__head strong {
		display: block;
		margin-bottom: 4px;
		font-size: 13px;
		color: var(--sig-text-bright);
	}

	.discord-panel__head code {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 10px;
		color: var(--sig-text-muted);
	}

	.source-health-pill {
		display: inline-flex;
		max-width: 220px;
		border: 1px solid var(--sig-border);
		padding: 3px 6px;
		font: 9px/1.35 var(--font-mono);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
	}

	.source-health-pill--healthy {
		border-color: rgba(34, 197, 94, 0.45);
		color: var(--sig-success);
		background: rgba(34, 197, 94, 0.08);
	}

	.source-health-pill--degraded {
		border-color: rgba(245, 158, 11, 0.42);
		color: #d9b862;
		background: rgba(245, 158, 11, 0.08);
	}

	.source-health-pill--unhealthy {
		border-color: rgba(239, 68, 68, 0.42);
		color: #fca5a5;
		background: rgba(239, 68, 68, 0.08);
	}

	.discord-metrics {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		border: 1px solid var(--sig-border);
	}

	.discord-metric {
		display: grid;
		gap: 5px;
		border-right: 1px solid var(--sig-border);
		padding: 8px;
	}

	.discord-metric:last-child {
		border-right: 0;
	}

	.discord-metric span,
	.discord-setting span,
	.discord-health-grid span {
		font: 9px var(--font-mono);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
	}

	.discord-metric strong {
		font: 16px/1 var(--font-display);
		color: var(--sig-text-bright);
	}

	.discord-settings-grid,
	.discord-health-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1px;
		background: var(--sig-border);
		border: 1px solid var(--sig-border);
	}

	.discord-setting,
	.discord-health-grid div {
		display: grid;
		gap: 5px;
		min-width: 0;
		background: var(--sig-surface);
		padding: 8px;
	}

	.discord-setting strong,
	.discord-health-grid strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: 11px/1.35 var(--font-body);
		font-weight: 600;
		color: var(--sig-text-bright);
	}

	.discord-health-grid strong {
		overflow: visible;
		text-overflow: clip;
		white-space: normal;
		word-break: break-word;
	}

	.discord-actions {
		display: grid;
		gap: 8px;
	}

	.section-label {
		display: block;
		padding: 7px 0 4px;
		font-size: 9px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
	}

	.featured-panel .section-label {
		padding-left: 2px;
	}

	.connector-grid {
		display: grid;
		flex: 1 1 auto;
		grid-auto-rows: min-content;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		min-height: 0;
		border: 1px solid var(--sig-border);
		border-radius: 0;
		overflow-x: hidden;
		overflow-y: auto;
		scrollbar-width: none;
	}

	.connector-card {
		position: relative;
		z-index: 1;
		min-width: 0;
		border-right: 1px solid var(--sig-border);
		border-bottom: 1px solid var(--sig-border);
		background: var(--sig-surface);
		transition:
			background-color 0.16s var(--ease),
			box-shadow 0.22s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.connector-card:nth-child(even) {
		border-right: 0;
	}

	.connector-card.expanded {
		z-index: 20;
		background: var(--sig-surface-raised);
		box-shadow:
			0 0 0 1px rgba(245, 158, 11, 0.26),
			0 18px 42px rgba(0, 0, 0, 0.35);
	}

	.connector-card.connected {
		border-color: rgba(34, 197, 94, 0.36);
	}

	.connector-row {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr) auto;
		gap: 8px;
		align-items: center;
		min-height: 46px;
		border: 0;
		background: transparent;
		width: 100%;
		padding: 6px 12px;
		text-align: left;
		color: inherit;
		cursor: pointer;
		transition: min-height 0.28s var(--ease), padding 0.28s var(--ease), background-color var(--dur) var(--ease);
	}

	.connector-card:hover,
	.connector-card.expanded,
	.connector-row:hover,
	.connector-row.selected {
		background: var(--sig-surface-raised);
	}

	.connector-card:hover .connector-row {
		background: var(--sig-surface-raised);
	}

	.connector-card.compressed .connector-row {
		min-height: 46px;
		padding-block: 6px;
	}

	.connector-expand {
		position: absolute;
		top: calc(100% - 1px);
		left: -1px;
		right: -1px;
		z-index: 30;
		display: grid;
		gap: 12px;
		border: 1px solid var(--sig-border-strong);
		border-top: 1px solid var(--sig-border);
		padding: 12px;
		background: var(--sig-surface-raised);
		box-shadow:
			0 18px 34px rgba(0, 0, 0, 0.52),
			0 0 0 1px rgba(255, 255, 255, 0.06),
			inset 2px 0 0 var(--sig-accent);
		clip-path: inset(0 0 100% 0);
		opacity: 0;
		pointer-events: none;
		transform: translateY(-4px);
		transform-origin: top center;
		transition:
			clip-path 0.24s cubic-bezier(0.16, 1, 0.3, 1),
			opacity 0.16s ease,
			transform 0.24s cubic-bezier(0.16, 1, 0.3, 1),
			visibility 0s linear 0.24s;
		visibility: hidden;
	}

	.connector-expand.open {
		clip-path: inset(0 0 0 0);
		opacity: 1;
		pointer-events: auto;
		transform: translateY(0);
		transition-delay: 0s;
		visibility: visible;
	}

	.connector-description {
		font-size: 11px;
		line-height: 1.55;
		color: var(--sig-text);
		filter: drop-shadow(0 8px 10px rgba(0, 0, 0, 0.32));
	}

	.connector-icon {
		width: 26px;
		height: 26px;
		border-radius: 0;
		font-family: var(--font-body);
		font-weight: 700;
	}

	.connector-copy {
		min-width: 0;
	}

	.connector-copy strong {
		display: block;
		font-size: 11px;
		font-weight: 600;
		color: var(--sig-text-bright);
	}

	.connector-copy small {
		display: block;
		margin-top: 2px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 9px;
		color: var(--sig-text-muted);
	}

	.connector-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 22px;
		height: 22px;
		border: 1px solid var(--sig-border);
		border-radius: 0;
		color: var(--sig-text-muted);
	}

	.connector-action.available {
		border-color: var(--sig-success);
		color: var(--sig-success);
	}

	.connector-action.connected {
		border-color: rgba(34, 197, 94, 0.62);
		background: rgba(34, 197, 94, 0.1);
		color: var(--sig-success);
	}

	.connector-action :global(svg) {
		width: 14px;
		height: 14px;
	}

	.connector-action em {
		padding: 0 8px;
		font: 9px var(--font-mono);
		font-style: normal;
		white-space: nowrap;
		color: var(--sig-text-muted);
	}

	.featured-panel footer {
		flex: 0 0 auto;
		border: 1px solid var(--sig-border);
		border-top: 0;
		border-radius: 0;
		padding: 7px 10px;
		text-align: center;
		font-size: 11px;
		color: var(--sig-text-muted);
	}

	.connect-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		width: 100%;
		height: 36px;
		border: 1px solid var(--sig-accent);
		border-radius: 0;
		background: var(--sig-accent);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.15), 0 10px 18px rgba(0, 0, 0, 0.34);
		font: 12px var(--font-mono);
		color: #fff;
		cursor: pointer;
		transition: background-color var(--dur) var(--ease), border-color var(--dur) var(--ease);
	}

	.connect-button:hover:not(:disabled) {
		background: var(--sig-accent-hover);
		border-color: var(--sig-accent-hover);
	}

	.connect-button:disabled {
		cursor: not-allowed;
		filter: grayscale(0.5);
		opacity: 0.62;
	}

	.connect-button :global(svg) {
		width: 13px;
		height: 13px;
	}

	.connect-form {
		display: grid;
		gap: 14px;
	}

	.connect-form label {
		display: grid;
		gap: 7px;
	}

	.connect-form label span {
		font-size: 10px;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
	}

	.connect-form input,
	.connect-form select,
	.connect-form textarea {
		width: 100%;
		border: 1px solid var(--sig-border-strong);
		border-radius: 0;
		background: var(--sig-surface-raised);
		padding: 0 10px;
		font: 11px var(--font-mono);
		color: var(--sig-text-bright);
		outline: none;
	}

	.connect-form input,
	.connect-form select {
		height: 32px;
	}

	.connect-form select {
		appearance: none;
	}

	.connect-form textarea {
		min-height: 86px;
		padding: 9px 10px;
		resize: vertical;
	}

	.field-hint {
		font: 10px/1.4 var(--font-body);
		color: var(--sig-text-muted);
	}

	.discord-options-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
	}

	.github-options-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 110px;
		gap: 10px;
	}

	.source-option-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
	}

	.connect-form .source-option-row {
		display: grid;
		grid-template-columns: 14px minmax(0, 1fr);
		align-items: center;
		gap: 8px;
		border: 1px solid var(--sig-border);
		background: rgba(255, 255, 255, 0.02);
		padding: 7px 8px;
	}

	.connect-form .source-option-row input {
		width: 14px;
		height: 14px;
		margin: 0;
		accent-color: var(--sig-accent);
	}

	.connect-form .source-option-row span {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		letter-spacing: 0;
		text-transform: none;
		color: var(--sig-text);
	}

	.path-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
	}

	.path-row button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border: 1px solid var(--sig-border-strong);
		border-radius: 0;
		background: var(--sig-surface);
		padding: 0 10px;
		font: 10px var(--font-mono);
		color: var(--sig-text-bright);
		cursor: pointer;
		transition: background-color var(--dur) var(--ease), border-color var(--dur) var(--ease);
	}

	.path-row button:hover:not(:disabled) {
		background: var(--sig-surface-raised);
		border-color: var(--sig-text-muted);
	}

	.path-row button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.path-row button :global(svg) {
		width: 12px;
		height: 12px;
	}

	.field-error,
	.form-status {
		font-size: 11px;
		line-height: 1.45;
	}

	.field-error,
	.form-status--error {
		color: var(--sig-danger);
	}

	.form-status {
		padding: 0 24px 14px;
	}

	.form-status--info {
		color: var(--sig-text-muted);
	}

	.spin {
		display: inline-flex;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes packet-flow {
		to {
			stroke-dashoffset: -288;
		}
	}

	@keyframes node-float {
		0%, 100% {
			transform: translateY(0);
		}
		50% {
			transform: translateY(-3px);
		}
	}

	@keyframes node-pulse {
		0%, 100% {
			opacity: 0.3;
			transform: scale(1);
		}
		50% {
			opacity: 0.6;
			transform: scale(1.08);
		}
	}

	.connected-list {
		display: grid;
		gap: 8px;
		border: 1px solid var(--sig-border);
		border-radius: 0;
		padding: 8px;
		background: var(--sig-surface);
	}

	.connected-list--inline {
		border-color: var(--sig-border-strong);
		background: rgba(0, 0, 0, 0.12);
	}

	.connected-loading {
		border: 1px solid var(--sig-border);
		border-radius: 0;
		padding: 14px;
		font-size: 12px;
		color: var(--sig-text-muted);
		background: var(--sig-surface);
	}

	.removal-note {
		margin: 0;
		border: 1px dashed rgba(239, 68, 68, 0.24);
		padding: 8px 10px;
		font-size: 11px;
		line-height: 1.45;
		color: var(--sig-text-muted);
		background: rgba(239, 68, 68, 0.04);
	}

	.connected-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		gap: 16px;
		border: 1px solid var(--sig-border);
		border-radius: 0;
		padding: 12px;
		background: var(--sig-surface-raised);
	}

	.connected-row--inline {
		grid-template-columns: minmax(0, 1fr);
		gap: 10px;
	}

	.connected-main {
		min-width: 0;
	}

	.connected-title-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.status-badge {
		border: 1px solid var(--sig-border);
		padding: 2px 6px;
		font: 9px var(--font-mono);
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.status-badge--connected {
		border-color: rgba(34, 197, 94, 0.45);
		color: var(--sig-success);
		background: rgba(34, 197, 94, 0.08);
	}

	.connected-row strong {
		display: block;
		margin-bottom: 4px;
		font-size: 13px;
		color: var(--sig-text-bright);
	}

	.connected-row code {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
		color: var(--sig-text-muted);
	}

	.connected-row ul {
		display: grid;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.connected-row li {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		gap: 6px;
		font-size: 10px;
		color: var(--sig-text-muted);
	}

		.connected-row li :global(svg) {
			width: 13px;
			height: 13px;
		}

		.connected-row li.source-health--healthy {
			color: #6fa97f;
		}

		.connected-row li.source-health--degraded {
			color: #c4a24a;
		}

		.connected-row li.source-health--unhealthy {
			color: #d06f62;
		}

		.connected-row li.source-health--empty,
		.connected-row li.source-health--unknown {
			color: var(--sig-text-muted);
		}

		.source-index-progress {
			display: grid;
			gap: 6px;
			border: 1px solid var(--sig-border);
			border-radius: 0;
			padding: 8px;
			background: var(--sig-surface);
		}

		.source-index-progress__head {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 10px;
			font: 9px var(--font-mono);
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: var(--sig-text-muted);
		}

		.source-index-progress__head strong {
			margin: 0;
			font: inherit;
			color: var(--sig-text-bright);
		}

		.source-index-progress__bar {
			position: relative;
			width: 100%;
			height: 7px;
			border: 1px solid var(--sig-border-strong);
			border-radius: 0;
			overflow: hidden;
			background: var(--sig-surface-raised);
		}

		.source-index-progress__bar span {
			position: absolute;
			inset: 0 auto 0 0;
			min-width: 2px;
			background: var(--sig-accent);
			box-shadow: inset 0 1px 0 var(--sig-highlight-dim);
			transition: width 0.2s var(--ease);
		}

		.source-index-progress__path {
			color: var(--sig-text-muted);
		}

		.exclude-summary {
			display: grid;
			gap: 4px;
		border: 1px dashed var(--sig-border);
		padding: 8px;
		background: rgba(255, 255, 255, 0.02);
	}

	.exclude-summary span {
		font: 9px var(--font-mono);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
	}

	.exclude-summary code {
		white-space: normal;
		word-break: break-word;
	}

	.source-ops {
		display: grid;
		gap: 8px;
		border: 1px solid var(--sig-border);
		padding: 8px;
		background: rgba(255, 255, 255, 0.02);
	}

	.source-ops__buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.source-action-button {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-height: 28px;
		border: 1px solid var(--sig-border-strong);
		border-radius: 0;
		padding: 0 10px;
		background: var(--sig-surface);
		color: var(--sig-text);
		font: 10px var(--font-mono);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		cursor: pointer;
		transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease), color var(--dur) var(--ease);
	}

	.source-action-button:hover:not(:disabled):not(.source-action-button--disabled) {
		border-color: var(--sig-accent);
		background: rgba(255, 255, 255, 0.04);
		color: var(--sig-text-bright);
	}

	.source-action-button:disabled,
	.source-action-button--disabled {
		cursor: wait;
		opacity: 0.6;
	}

	.source-action-button :global(svg) {
		width: 13px;
		height: 13px;
	}

	.snapshot-file-input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}

	.source-option-row--compact {
		display: inline-grid;
		grid-template-columns: 14px minmax(0, 1fr);
		align-items: center;
		gap: 8px;
		font-size: 10px;
		color: var(--sig-text-muted);
	}

	.source-option-row--compact input {
		width: 14px;
		height: 14px;
		margin: 0;
		accent-color: var(--sig-accent);
	}

	.disconnect-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		align-self: center;
		height: 28px;
		border: 1px solid rgba(239, 68, 68, 0.35);
		border-radius: 0;
		background: rgba(239, 68, 68, 0.08);
		color: #fca5a5;
		font: 10px var(--font-mono);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		cursor: pointer;
		transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease), color var(--dur) var(--ease);
	}

	.disconnect-button:hover:not(:disabled) {
		border-color: rgba(239, 68, 68, 0.65);
		background: rgba(239, 68, 68, 0.14);
		color: #fecaca;
	}

	.disconnect-button:disabled {
		cursor: wait;
		opacity: 0.6;
	}

	.disconnect-button :global(svg) {
		width: 13px;
		height: 13px;
	}

	/* Light theme overrides */
	:global([data-theme="light"]) .recall-map {
		background: var(--sig-surface);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7), 0 1px 3px rgba(0, 0, 0, 0.08);
	}

	:global([data-theme="light"]) .detail-panel,
	:global([data-theme="light"]) .featured-panel,
	:global([data-theme="light"]) .connected-panel,
	:global([data-theme="light"]) .discord-operations {
		background: var(--sig-surface);
		border-color: var(--sig-border);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7), 0 1px 3px rgba(0, 0, 0, 0.08);
	}

	:global([data-theme="light"]) .search-box,
	:global([data-theme="light"]) .connect-form input {
		background: var(--sig-surface-raised);
	}

	:global([data-theme="light"]) .connector-row,
	:global([data-theme="light"]) .connected-list,
	:global([data-theme="light"]) .connected-loading,
	:global([data-theme="light"]) .connected-row,
	:global([data-theme="light"]) .discord-panel,
	:global([data-theme="light"]) .discord-setting,
	:global([data-theme="light"]) .discord-health-grid div {
		background: var(--sig-surface);
	}

	:global([data-theme="light"]) .connector-row:hover,
	:global([data-theme="light"]) .connector-row.selected,
	:global([data-theme="light"]) .connected-row,
	:global([data-theme="light"]) .discord-source-switcher button.active,
	:global([data-theme="light"]) .discord-source-switcher button:hover {
		background: var(--sig-surface-raised);
	}

	:global([data-theme="light"]) .map-grid {
		opacity: 0.4;
	}

	:global([data-theme="light"]) .github-logo,
	:global([data-theme="light"]) .notion-logo,
	:global([data-theme="light"]) .mdn-logo {
		background: #ffffff;
	}

	@media (max-width: 760px) {
		.sources-tab {
			padding: var(--space-sm);
		}

		.source-toolbar,
		.connector-grid,
		.connected-row,
		.discord-detail,
		.discord-metrics,
		.discord-settings-grid,
		.discord-health-grid {
			grid-template-columns: 1fr;
		}

		.discord-operations__header,
		.discord-panel__head {
			display: grid;
		}

		.discord-operations__refresh,
		.source-health-pill {
			width: 100%;
			max-width: none;
		}

		.discord-source-switcher {
			grid-template-columns: 1fr;
		}

		.discord-source-switcher button,
		.discord-metric {
			border-right: 0;
			border-bottom: 1px solid var(--sig-border);
		}

		.discord-source-switcher button:last-child,
		.discord-metric:last-child {
			border-bottom: 0;
		}

		.filter-tabs {
			grid-template-columns: repeat(5, minmax(0, 1fr));
		}

		.filter-tabs button {
			min-width: 0;
		}

		.read-first {
			justify-content: flex-start;
		}

		.recall-map {
			min-height: 200px;
		}

		.map-left,
		.map-right {
			display: none;
		}

		.map-center {
			gap: 6px;
		}

		.map-logo {
			width: 32px;
			height: 32px;
		}

		.map-tagline {
			font-size: 9px;
		}

		.connector-row {
			border-right: 0;
		}

		.path-row {
			grid-template-columns: 1fr;
		}

		.discord-options-grid,
		.source-option-grid {
			grid-template-columns: 1fr;
		}

		.connected-row li {
			justify-content: flex-start;
		}
	}
</style>
