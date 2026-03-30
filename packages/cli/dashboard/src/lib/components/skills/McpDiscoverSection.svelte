<script lang="ts">
import type { DiscoveredServer } from "$lib/api";
import { mcp, fetchDiscovered, doImport } from "$lib/stores/mcp-servers.svelte";
import { onMount } from "svelte";

// Group discovered servers by importKind
let grouped = $derived.by(() => {
	const map = new Map<string, DiscoveredServer[]>();
	for (const s of mcp.discovered) {
		const key = s.importKind ?? "unknown";
		const existing = map.get(key);
		if (existing) {
			existing.push(s);
		} else {
			map.set(key, [s]);
		}
	}
	return map;
});

const KIND_LABELS: Record<string, string> = {
	"claude-code": "Claude Code",
	"claude-desktop": "Claude Desktop",
	cursor: "Cursor",
	codex: "Codex",
	opencode: "OpenCode",
	vscode: "VS Code",
	windsurf: "Windsurf",
	unknown: "Other",
};

function kindLabel(kind: string): string {
	return KIND_LABELS[kind] ?? kind;
}

onMount(() => {
	if (!mcp.discoverLoaded && !mcp.discoverLoading) {
		void fetchDiscovered();
	}
});
</script>

<div class="discover-section">
	{#if mcp.discoverLoading}
		<div class="state-msg">Scanning for MCP servers…</div>
	{:else if mcp.discovered.length === 0 && mcp.discoverLoaded}
		<div class="state-msg empty">
			No MCP servers found in known harness configs.
			<br />
			<span class="hint">
				Configure servers in Claude Code, Cursor, or other MCP-compatible
				harnesses to discover them here.
			</span>
		</div>
	{:else}
		{#each [...grouped.entries()] as [kind, servers] (kind)}
			<div class="kind-group">
				<div class="kind-header">
					<span class="kind-label">{kindLabel(kind)}</span>
					<span class="kind-count">{servers.length}</span>
				</div>

				{#each servers as server (server.name)}
					<div class="discover-row">
						<div class="discover-info">
							<span class="discover-name">{server.name}</span>
							{#if server.sourcePath}
								<span class="discover-path" title={server.sourcePath}>
									{server.sourcePath}
								</span>
							{/if}
						</div>

						<div class="discover-action">
							{#if server.alreadyInstalled}
								<span class="installed-badge">INSTALLED</span>
							{:else}
								<button
									type="button"
									class="import-btn"
									disabled={mcp.importing.has(server.name)}
									onclick={() => doImport(server)}
								>
									{mcp.importing.has(server.name) ? "…" : "IMPORT"}
								</button>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/each}
	{/if}
</div>

<style>
	.discover-section {
		display: flex;
		flex-direction: column;
		gap: 16px;
		padding: var(--space-md);
	}

	.state-msg {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-muted);
		padding: var(--space-md) 0;
		text-align: center;
	}
	.state-msg.empty {
		line-height: 1.7;
	}
	.hint {
		font-size: 10px;
		color: var(--sig-text-muted);
		opacity: 0.7;
	}

	.kind-group {
		display: flex;
		flex-direction: column;
		gap: 0;
		border: 1px solid var(--sig-border);
	}

	.kind-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 10px;
		background: var(--sig-surface);
		border-bottom: 1px solid var(--sig-border);
	}

	.kind-label {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.kind-count {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border);
		padding: 0 4px;
		min-width: 16px;
		text-align: center;
	}

	.discover-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 7px 10px;
		border-bottom: 1px solid var(--sig-border);
		background: var(--sig-surface-raised);
	}
	.discover-row:last-child {
		border-bottom: none;
	}
	.discover-row:hover {
		background: var(--sig-surface);
	}

	.discover-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.discover-name {
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

	.discover-path {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.discover-action {
		flex-shrink: 0;
	}

	.installed-badge {
		font-family: var(--font-mono);
		font-size: 9px;
		padding: 2px 6px;
		border: 1px solid var(--sig-success);
		color: var(--sig-success);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.import-btn {
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		padding: 2px 8px;
		border: 1px solid var(--sig-accent);
		color: var(--sig-accent);
		background: transparent;
		cursor: pointer;
		transition: all 0.1s;
	}
	.import-btn:hover:not(:disabled) {
		background: var(--sig-accent);
		color: var(--sig-bg);
	}
	.import-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
