<script lang="ts">
import type { McpServer, McpTool } from "$lib/api";
import { Button } from "$lib/components/ui/button/index.js";
import {
	mcp,
	toggleExpand,
	doToggle,
	doRemove,
	doGenerateCli,
} from "$lib/stores/mcp-servers.svelte";

type Props = { server: McpServer };
let { server }: Props = $props();

const MONOGRAM_COLORS = [
	"#1e3448", "#341e48", "#48321e", "#1e4832", "#481e1e", "#1e2448",
];

function getMonogramBg(name: string): string {
	let hash = 0;
	for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffff;
	return MONOGRAM_COLORS[hash % MONOGRAM_COLORS.length];
}

function getMonogram(name: string): string {
	const parts = name.split(/[-_.\s]+/).filter(Boolean);
	if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
	return name.slice(0, 2).toUpperCase();
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function formatToolSig(tool: McpTool): string {
	const schema = tool.inputSchema;
	if (!isRecord(schema)) return `function ${tool.name}()`;

	const props = schema.properties;
	if (!isRecord(props) || Object.keys(props).length === 0) {
		return `function ${tool.name}()`;
	}

	const requiredArr = Array.isArray(schema.required)
		? schema.required.filter((x): x is string => typeof x === "string")
		: [];
	const required = new Set(requiredArr);

	const params = Object.entries(props).map(([k, v]) => {
		const t = isRecord(v) && typeof v.type === "string" ? v.type : "unknown";
		return required.has(k) ? `${k}: ${t}` : `${k}?: ${t}`;
	});
	return `function ${tool.name}(${params.join(", ")})`;
}

let monogram = $derived(getMonogram(server.name));
let monogramBg = $derived(getMonogramBg(server.name));
let isExpanded = $derived(mcp.expandedId === server.id);
let tools = $derived<McpTool[]>(mcp.toolsCache[server.id] ?? []);
let toolsLoading = $derived(mcp.toolsLoading.has(server.id));
let isGenerating = $derived(mcp.generatingCli.has(server.id));
let isRemoving = $derived(mcp.removing.has(server.id));
let isToggling = $derived(mcp.toggling.has(server.id));
</script>

<div class="server-card" class:expanded={isExpanded}>
	<!-- Header row -->
	<div class="card-header">
		<button
			type="button"
			class="expand-btn"
			onclick={() => toggleExpand(server.id)}
			title={isExpanded ? "Collapse" : "Expand tools"}
		>
			<div class="monogram" style="background: {monogramBg};">{monogram}</div>
			<span class="chevron" class:open={isExpanded}>›</span>
		</button>

		<div class="card-info">
			<span class="server-name">{server.name}</span>
			<span class="transport-badge" class:http={server.transport === "http"}>
				{server.transport}
			</span>
			{#if server.cli_path}
				<span class="cli-badge" title={server.cli_path}>CLI</span>
			{/if}
		</div>

		<div class="card-actions">
			<!-- Enabled toggle -->
			<button
				type="button"
				class="toggle-btn"
				class:enabled={server.enabled}
				disabled={isToggling}
				onclick={() => doToggle(server.id, !server.enabled)}
				title={server.enabled ? "Disable" : "Enable"}
			>
				{#if isToggling}
					<span class="toggle-dot spinning">·</span>
				{:else}
					<span class="toggle-dot"></span>
				{/if}
				{server.enabled ? "ON" : "OFF"}
			</button>

			<!-- Remove -->
			<button
				type="button"
				class="remove-btn"
				disabled={isRemoving}
				onclick={() => doRemove(server.id, server.name)}
				title="Remove"
			>
				{isRemoving ? "·" : "×"}
			</button>
		</div>
	</div>

	<!-- Expanded: tools + CLI generation -->
	{#if isExpanded}
		<div class="card-body">
			{#if toolsLoading}
				<div class="tools-loading">loading tools…</div>
			{:else if tools.length === 0}
				<div class="tools-empty">no tools found</div>
			{:else}
				<div class="tools-list">
					{#each tools as tool (tool.name)}
						<div class="tool-row">
							<code class="tool-sig">{formatToolSig(tool)}</code>
							{#if tool.description}
								<span class="tool-desc">{tool.description}</span>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			<div class="cli-row">
				<Button
					variant="outline"
					size="sm"
					class="cli-btn"
					disabled={isGenerating}
					onclick={() => doGenerateCli(server.id, server.name)}
				>
					{#if isGenerating}
						generating…
					{:else if server.cli_path}
						REGENERATE CLI
					{:else}
						GENERATE CLI
					{/if}
				</Button>
				{#if server.cli_path}
					<code class="cli-path">{server.cli_path}</code>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.server-card {
		border: 1px solid var(--sig-border);
		background: var(--sig-surface-raised);
		transition: border-color 0.15s;
	}
	.server-card:hover,
	.server-card.expanded {
		border-color: var(--sig-border-strong);
	}

	.card-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
	}

	.expand-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		background: transparent;
		border: none;
		cursor: pointer;
		padding: 0;
		flex-shrink: 0;
	}

	.monogram {
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: var(--font-display);
		font-size: 10px;
		font-weight: 700;
		color: var(--sig-text-bright);
		letter-spacing: 0.04em;
		user-select: none;
		flex-shrink: 0;
	}

	.chevron {
		font-family: var(--font-mono);
		font-size: 14px;
		color: var(--sig-text-muted);
		display: inline-block;
		transition: transform 0.15s;
		line-height: 1;
	}
	.chevron.open {
		transform: rotate(90deg);
	}

	.card-info {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: 1;
		min-width: 0;
	}

	.server-name {
		font-family: var(--font-display);
		font-size: 11px;
		font-weight: 600;
		color: var(--sig-text-bright);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.transport-badge {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 9px;
		padding: 1px 5px;
		border: 1px solid var(--sig-border-strong);
		color: var(--sig-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.transport-badge.http {
		border-color: var(--sig-accent);
		color: var(--sig-accent);
	}

	.cli-badge {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 9px;
		padding: 1px 5px;
		border: 1px solid var(--sig-success);
		color: var(--sig-success);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.card-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	.toggle-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
		background: transparent;
		border: 1px solid var(--sig-border);
		padding: 2px 6px;
		cursor: pointer;
		transition: all 0.1s;
	}
	.toggle-btn.enabled {
		color: var(--sig-success);
		border-color: var(--sig-success);
	}
	.toggle-btn:disabled {
		cursor: default;
		opacity: 0.5;
	}

	.toggle-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
		display: inline-block;
		flex-shrink: 0;
	}
	.toggle-dot.spinning {
		animation: pulse 0.8s infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.2; }
	}

	.remove-btn {
		width: 22px;
		height: 22px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: var(--font-mono);
		font-size: 14px;
		line-height: 1;
		color: var(--sig-text-muted);
		background: transparent;
		border: none;
		cursor: pointer;
		transition: color 0.1s;
		padding: 0;
		flex-shrink: 0;
	}
	.remove-btn:hover {
		color: var(--sig-danger);
	}
	.remove-btn:disabled {
		cursor: default;
		opacity: 0.5;
	}

	.card-body {
		border-top: 1px solid var(--sig-border);
		padding: 10px 12px 12px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.tools-loading,
	.tools-empty {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		font-style: italic;
	}

	.tools-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.tool-row {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.tool-sig {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-bright);
	}

	.tool-desc {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		padding-left: 8px;
	}

	.cli-row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		padding-top: 4px;
		border-top: 1px solid var(--sig-border);
	}

	:global(.cli-btn) {
		font-family: var(--font-mono) !important;
		font-size: 9px !important;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		height: auto !important;
		padding: 3px 8px !important;
		border-radius: 0 !important;
		border-color: var(--sig-border-strong) !important;
		color: var(--sig-text) !important;
	}
	:global(.cli-btn:hover:not(:disabled)) {
		border-color: var(--sig-accent) !important;
		color: var(--sig-accent) !important;
	}

	.cli-path {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-success);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
		min-width: 0;
	}
</style>
