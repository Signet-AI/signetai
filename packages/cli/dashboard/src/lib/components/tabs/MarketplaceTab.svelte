<script lang="ts">
import McpServersTab from "$lib/components/marketplace/McpServersTab.svelte";
import SkillsTab from "$lib/components/tabs/SkillsTab.svelte";
import * as Select from "$lib/components/ui/select/index.js";
import * as Tabs from "$lib/components/ui/tabs/index.js";
import { getFilteredMarketplaceMcpCatalog, mcpMarket } from "$lib/stores/marketplace-mcp.svelte";
import { getFilteredCatalog, setQuery, sk } from "$lib/stores/skills.svelte";

let section = $state<"skills" | "mcp">("skills");

type SpotlightItem = {
	readonly title: string;
	readonly subtitle: string;
};

const activeQuery = $derived(section === "skills" ? sk.query : mcpMarket.query);
const activeSectionLabel = $derived(section === "skills" ? "Agent Skills" : "Tool Servers");

const sectionCatalogCount = $derived(section === "skills" ? sk.catalogTotal : mcpMarket.catalogTotal);

const spotlight = $derived.by((): SpotlightItem[] => {
	if (section === "skills") {
		return getFilteredCatalog()
			.slice(0, 8)
			.map((item) => ({
				title: item.name,
				subtitle: item.provider ?? "skills.sh",
			}));
	}

	return getFilteredMarketplaceMcpCatalog()
		.slice(0, 8)
		.map((item) => ({
			title: item.name,
			subtitle: item.source === "modelcontextprotocol/servers" ? "MCP GitHub" : "MCP Registry",
		}));
});

const totalInstalled = $derived(sk.installed.length + mcpMarket.installed.length);

function handleSectionChange(value: string): void {
	section = value === "mcp" ? "mcp" : "skills";
}

function updateActiveQuery(value: string): void {
	if (section === "skills") {
		setQuery(value);
		return;
	}
	mcpMarket.query = value;
}

function applySpotlight(item: SpotlightItem): void {
	updateActiveQuery(item.title);
}
</script>

<div class="market-shell">
	<div class="market-utility">
		<div class="utility-left">
			<span class="utility-kicker">Signet Marketplace</span>
			<span class="utility-copy">Curated capabilities for agents that ship work.</span>
		</div>
		<div class="utility-stats">
			<span>{sk.catalogTotal.toLocaleString()} skills</span>
			<span>{mcpMarket.catalogTotal.toLocaleString()} tool servers</span>
			<span>{totalInstalled} installed</span>
		</div>
	</div>

	<div class="market-search-row">
		<input
			type="text"
			class="market-search"
			placeholder={section === "skills" ? "Search curated skills..." : "Search curated MCP servers..."}
			value={activeQuery}
			oninput={(e) => {
				updateActiveQuery(e.currentTarget.value);
			}}
		/>
		<Select.Root type="single" value={section} onValueChange={(v) => { section = v === "mcp" ? "mcp" : "skills"; }}>
			<Select.Trigger class="market-select">{activeSectionLabel}</Select.Trigger>
			<Select.Content class="market-select-content">
				<Select.Item value="skills" label="Agent Skills" class="market-select-item" />
				<Select.Item value="mcp" label="Tool Servers" class="market-select-item" />
			</Select.Content>
		</Select.Root>
	</div>

	<div class="hero-panel">
		<div class="hero-main">
			<p class="hero-label">Storefront</p>
			<h2>
				{section === "skills"
					? "Premium Skill Packs for serious operators"
					: "Production MCP Servers for live toolchains"}
			</h2>
			<p>
				{section === "skills"
					? "Discover trusted automations, compare options, and install in one click."
					: "Connect best-in-class tool servers, test configs, and route tools with confidence."}
			</p>
			<div class="hero-actions">
				<button type="button" class="hero-action" onclick={() => (section = "skills")}>Explore Skills</button>
				<button type="button" class="hero-action ghost" onclick={() => (section = "mcp")}>Explore Tool Servers</button>
			</div>
		</div>
		<div class="hero-side">
			<div class="hero-metric">
				<span class="metric-label">Current aisle</span>
				<span class="metric-value">{section === "skills" ? "Agent Skills" : "Tool Servers"}</span>
			</div>
			<div class="hero-metric">
				<span class="metric-label">Results</span>
				<span class="metric-value">{sectionCatalogCount.toLocaleString()}</span>
			</div>
			<div class="hero-metric">
				<span class="metric-label">Curation</span>
				<span class="metric-value">Verified sources only</span>
			</div>
		</div>
	</div>

	{#if spotlight.length > 0}
		<div class="spotlight-row">
			{#each spotlight as item (item.title)}
				<button
					type="button"
					class="spotlight-card"
					onclick={() => applySpotlight(item)}
				>
					<span class="spotlight-title">{item.title}</span>
					<span class="spotlight-subtitle">{item.subtitle}</span>
				</button>
			{/each}
		</div>
	{/if}

	<div class="content-shell">
		<Tabs.Root value={section} onValueChange={handleSectionChange}>
			<div class="section-bar">
				<Tabs.List class="bg-transparent h-auto gap-0 rounded-none border-none">
					<Tabs.Trigger value="skills" class="section-trigger">
						Agent Skills
					</Tabs.Trigger>
					<Tabs.Trigger value="mcp" class="section-trigger">
						Tool Servers (MCP)
					</Tabs.Trigger>
				</Tabs.List>
			</div>
		</Tabs.Root>

		<div class="content-body">
			{#if section === "skills"}
				<SkillsTab embedded={true} />
			{:else}
				<McpServersTab embedded={true} />
			{/if}
		</div>
	</div>
</div>

<style>
	.market-shell {
		height: 100%;
		display: flex;
		flex-direction: column;
		gap: 10px;
		overflow: hidden;
		padding: 10px;
	}

	.market-utility {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		border: 1px solid var(--sig-border);
		background: var(--sig-surface);
	}

	.utility-left {
		display: flex;
		align-items: baseline;
		gap: 10px;
		min-width: 0;
	}

	.utility-kicker {
		font-family: var(--font-display);
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--sig-text-bright);
	}

	.utility-copy {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.utility-stats {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.utility-stats span {
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		padding: 3px 6px;
		border: 1px solid var(--sig-border-strong);
		color: var(--sig-text-muted);
	}

	.market-search-row {
		display: grid;
		grid-template-columns: 1fr 190px;
		gap: 8px;
	}

	.market-search {
		height: 34px;
		padding: 0 10px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-bright);
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		outline: none;
		border-radius: 0;
	}

	:global(.market-select) {
		height: 34px;
		padding: 0 10px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-bright);
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		outline: none;
		border-radius: 0;
	}

	.market-search:focus,
	:global(.market-select:focus) {
		border-color: var(--sig-accent);
	}

	:global(.market-select-content) {
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		border-radius: 0;
	}

	:global(.market-select-item) {
		font-family: var(--font-mono);
		font-size: 10px;
	}

	.hero-panel {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 260px;
		gap: 10px;
		padding: 14px;
		border: 1px solid var(--sig-border);
		background:
			radial-gradient(circle at 85% -20%, color-mix(in srgb, var(--sig-accent) 18%, transparent), transparent 45%),
			linear-gradient(140deg, color-mix(in srgb, var(--sig-surface-raised) 85%, black) 0%, var(--sig-surface) 65%);
	}

	.hero-label {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: var(--sig-text-muted);
	}

	.hero-main h2 {
		margin: 8px 0 4px;
		font-family: var(--font-display);
		font-size: clamp(20px, 2vw, 28px);
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--sig-text-bright);
		line-height: 1.15;
	}

	.hero-main p {
		margin: 0;
		max-width: 70ch;
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.55;
		color: var(--sig-text);
	}

	.hero-actions {
		display: flex;
		gap: 8px;
		margin-top: 12px;
	}

	.hero-action {
		height: 30px;
		padding: 0 10px;
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		border: 1px solid var(--sig-accent);
		background: var(--sig-accent);
		color: var(--sig-bg);
		cursor: pointer;
	}

	.hero-action.ghost {
		border-color: var(--sig-border-strong);
		background: transparent;
		color: var(--sig-text-bright);
	}

	.hero-side {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.hero-metric {
		padding: 8px;
		border: 1px solid var(--sig-border);
		background: color-mix(in srgb, var(--sig-surface-raised) 80%, transparent);
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.metric-label {
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
	}

	.metric-value {
		font-family: var(--font-display);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--sig-text-bright);
	}

	.spotlight-row {
		display: flex;
		gap: 8px;
		overflow-x: auto;
		padding-bottom: 2px;
	}

	.spotlight-card {
		min-width: 170px;
		padding: 8px;
		border: 1px solid var(--sig-border);
		background: var(--sig-surface-raised);
		display: flex;
		flex-direction: column;
		gap: 3px;
		text-align: left;
		cursor: pointer;
	}

	.spotlight-card:hover {
		border-color: var(--sig-accent);
	}

	.spotlight-title {
		font-family: var(--font-display);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--sig-text-bright);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.spotlight-subtitle {
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
	}

	.content-shell {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		border: 1px solid var(--sig-border);
		background: var(--sig-surface);
	}

	.section-bar {
		border-bottom: 1px solid var(--sig-border);
		padding: 0 6px;
	}

	.content-body {
		flex: 1;
		min-height: 0;
	}

	:global(.section-trigger) {
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.09em;
		color: var(--sig-text-muted);
		background: transparent;
		border-radius: 0;
		border-bottom: 2px solid transparent;
		padding: 8px 12px;
	}

	:global(.section-trigger[data-state="active"]) {
		color: var(--sig-text-bright);
		border-bottom-color: var(--sig-accent);
		box-shadow: none;
	}

	@media (max-width: 980px) {
		.market-search-row {
			grid-template-columns: 1fr;
		}

		.hero-panel {
			grid-template-columns: 1fr;
		}

		.utility-copy {
			display: none;
		}
	}
</style>
