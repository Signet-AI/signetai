<script lang="ts">
import type { DocumentConnector, SignetSourceEntry } from "$lib/api";
import { getConnectors, getSources } from "$lib/api";
import { nav } from "$lib/stores/navigation.svelte";
import FileText from "@lucide/svelte/icons/file-text";
import FolderOpen from "@lucide/svelte/icons/folder-open";
import Network from "@lucide/svelte/icons/network";
import PlugZap from "@lucide/svelte/icons/plug-zap";
import { onMount } from "svelte";

type KnowledgeBase = {
	readonly id: string;
	readonly name: string;
	readonly kind: "memory" | "source" | "connector";
	readonly provider: string;
	readonly detail: string;
	readonly status: "online" | "syncing" | "warning" | "offline";
	readonly updatedAt: string | null;
	readonly x: number;
	readonly y: number;
};

const SIGNET_MEMORY_BASE: KnowledgeBase = {
	id: "signet-memory",
	name: "Signet Memory",
	kind: "memory",
	provider: "signet",
	detail: "Native identity memory",
	status: "online",
	updatedAt: null,
	x: 14,
	y: 28,
};

const NODE_SLOTS = [
	{ x: 18, y: 72 },
	{ x: 73, y: 24 },
	{ x: 80, y: 72 },
	{ x: 22, y: 24 },
	{ x: 88, y: 48 },
] as const;

let loaded = $state(false);
let sources = $state<SignetSourceEntry[]>([]);
let connectors = $state<DocumentConnector[]>([]);

onMount(async () => {
	const results = await Promise.allSettled([getSources(), getConnectors()]);
	if (results[0].status === "fulfilled") sources = results[0].value;
	if (results[1].status === "fulfilled") connectors = results[1].value;
	loaded = true;
});

const externalKnowledgeBases = $derived.by((): KnowledgeBase[] => {
	const sourceBases = sources.map(
		(source, index): KnowledgeBase => ({
			id: `source:${source.id}`,
			name: source.name || basename(source.root),
			kind: "source",
			provider: source.kind,
			detail: source.root,
			status: source.enabled
				? source.lastIndexedAt || (source.stats?.indexed ?? 0) > 0
					? "online"
					: "syncing"
				: "offline",
			updatedAt: source.lastIndexedAt ?? source.updatedAt ?? null,
			...NODE_SLOTS[index % NODE_SLOTS.length],
		}),
	);

	const connectorBases = connectors.map(
		(connector, index): KnowledgeBase => ({
			id: `connector:${connector.id}`,
			name: connector.display_name || connector.provider,
			kind: "connector",
			provider: connector.provider,
			detail: connector.last_error ?? `${connector.provider} document connector`,
			status: connectorStatus(connector),
			updatedAt: connector.last_sync_at ?? connector.updated_at ?? null,
			...NODE_SLOTS[(sourceBases.length + index) % NODE_SLOTS.length],
		}),
	);

	return [...sourceBases, ...connectorBases].slice(0, NODE_SLOTS.length);
});

const onlineCount = $derived(1 + externalKnowledgeBases.filter((base) => base.status === "online").length);
const totalCount = $derived(1 + externalKnowledgeBases.length);
const sourceCount = $derived(sources.length);
const connectorCount = $derived(connectors.length);
const externalCount = $derived(sourceCount + connectorCount);

function connectorStatus(connector: DocumentConnector): KnowledgeBase["status"] {
	if (connector.last_error) return "warning";
	if (connector.status === "syncing") return "syncing";
	if (connector.status === "connected" || connector.status === "active" || connector.status === "ok") return "online";
	return connector.status ? "online" : "offline";
}

function basename(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Knowledge base";
}

function statusLabel(status: KnowledgeBase["status"], base?: KnowledgeBase): string {
	if (base?.kind === "memory") return "always on";
	if (status === "online") return "indexed";
	if (status === "syncing") return "syncing";
	if (status === "warning") return "attention";
	return "offline";
}

function providerLabel(base: KnowledgeBase): string {
	if (base.kind === "memory") return "Signet";
	if (base.kind === "source" && base.provider === "obsidian") return "Obsidian";
	return base.provider.replace(/[-_]/g, " ");
}

function formatTimestamp(value: string | null): string {
	if (!value) return "not indexed yet";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "unknown";
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
}

function openSources(): void {
	nav.activeTab = "sources";
}
</script>

<div class="kb-panel sig-panel">
	<div class="kb-header sig-panel-header">
		<div>
			<span class="kb-title">CONNECTED KNOWLEDGE BASES</span>
			<span class="kb-subtitle">PROVENANCE GRAPH / LIVE SOURCES</span>
		</div>
		<button type="button" class="kb-open" onclick={openSources}>
			<PlugZap class="size-3" />
			<span>MANAGE</span>
		</button>
	</div>

	{#if !loaded && totalCount === 0}
		<div class="empty-state">SCANNING SOURCE MANIFEST...</div>
	{:else}
		<div class="kb-visual" class:kb-visual--solo={externalKnowledgeBases.length === 0}>
			<div class="kb-origin-ring" aria-hidden="true"></div>
			<button type="button" class="kb-core" onclick={openSources}>
				<span class="kb-core-mark">
					<img src="/logo-dark.png" alt="" class="kb-signet-logo" aria-hidden="true" />
				</span>
				<span class="kb-core-copy">
					<strong>Signet Memory</strong>
					<small>native identity graph · always on</small>
				</span>
			</button>
			<svg class="kb-links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
				{#each externalKnowledgeBases as base (base.id)}
					<line x1="50" y1="50" x2={base.x} y2={base.y} class:link-muted={base.status !== "online"} />
				{/each}
			</svg>
			{#if externalKnowledgeBases.length === 0}
				<div class="kb-solo-note">
					<span>NO EXTERNAL SOURCES CONNECTED</span>
					<small>Connect Obsidian or documents to extend recall provenance.</small>
				</div>
			{/if}
			{#each externalKnowledgeBases as base (base.id)}
				<button
					type="button"
					class="kb-node"
					class:kb-node--memory={base.kind === "memory"}
					class:kb-node--source={base.kind === "source"}
					class:kb-node--warning={base.status === "warning"}
					class:kb-node--offline={base.status === "offline"}
					style="left: {base.x}%; top: {base.y}%;"
					onclick={openSources}
				>
					<span class="kb-node-icon">
						{#if base.kind === "memory"}
							<img src="/logo-dark.png" alt="" class="kb-signet-logo" aria-hidden="true" />
						{:else if base.kind === "source"}
							<FolderOpen class="size-3.5" />
						{:else}
							<FileText class="size-3.5" />
						{/if}
					</span>
					<span class="kb-node-copy">
						<strong>{base.name}</strong>
						<small>{providerLabel(base)} · {statusLabel(base.status, base)}</small>
					</span>
				</button>
			{/each}
		</div>

		<div class="kb-footer">
			<div class="kb-stat">
				<span>{onlineCount}/{totalCount}</span>
				<small>ACTIVE</small>
			</div>
			<div class="kb-stat">
				<span>{externalCount}</span>
				<small>EXTERNAL</small>
			</div>
			<div class="kb-stat">
				<span>{connectorCount}</span>
				<small>CONNECTORS</small>
			</div>
			<div class="kb-last">
				<span>LAST EXTERNAL INDEX</span>
				<small>{formatTimestamp(externalKnowledgeBases.find((base) => base.updatedAt)?.updatedAt ?? null)}</small>
			</div>
		</div>
	{/if}
</div>

<style>
	.kb-panel {
		display: flex;
		flex-direction: column;
		min-height: 230px;
		background: var(--sig-surface);
		overflow: hidden;
	}

	.kb-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md);
		flex-shrink: 0;
	}

	.kb-title,
	.kb-subtitle,
	.kb-open,
	.kb-stat small,
	.kb-last span,
	.empty-state {
		font-family: var(--font-body);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.kb-title {
		display: block;
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 700;
		color: var(--sig-text-bright);
	}

	.kb-subtitle {
		display: block;
		margin-top: 2px;
		font-size: 8px;
		color: var(--sig-text-muted);
	}

	.kb-open {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		border: 1px solid var(--sig-border-strong);
		background: transparent;
		color: var(--sig-text);
		padding: 4px 7px;
		font-size: 9px;
		cursor: pointer;
		transition: background var(--dur) var(--ease), color var(--dur) var(--ease), border-color var(--dur) var(--ease);
	}

	.kb-open:hover {
		background: var(--sig-surface-raised);
		color: var(--sig-text-bright);
		border-color: var(--sig-border-strong);
	}

	.kb-visual {
		position: relative;
		flex: 1;
		min-height: 145px;
		margin: var(--space-sm) var(--space-md) 0;
		border: 1px solid var(--sig-border);
		background:
			linear-gradient(var(--sig-grid-line) 1px, transparent 1px),
			linear-gradient(90deg, var(--sig-grid-line) 1px, transparent 1px),
			var(--sig-surface-raised);
		background-size: 22px 22px;
		overflow: hidden;
	}

	.kb-origin-ring {
		position: absolute;
		left: 50%;
		top: 50%;
		z-index: 1;
		width: 142px;
		height: 76px;
		border: 1px dashed var(--sig-border);
		transform: translate(-50%, -50%);
		pointer-events: none;
	}

	.kb-origin-ring::before,
	.kb-origin-ring::after {
		content: "";
		position: absolute;
		left: 50%;
		top: 50%;
		background: var(--sig-border-strong);
		transform: translate(-50%, -50%);
	}

	.kb-origin-ring::before {
		width: 182px;
		height: 1px;
	}

	.kb-origin-ring::after {
		width: 1px;
		height: 112px;
	}

	.kb-core {
		position: absolute;
		left: 50%;
		top: 50%;
		z-index: 4;
		display: flex;
		align-items: center;
		gap: 8px;
		width: min(260px, calc(100% - 32px));
		padding: 9px 10px;
		border: 1px solid var(--sig-border-strong);
		background: color-mix(in srgb, var(--sig-surface) 96%, transparent);
		color: var(--sig-text);
		text-align: left;
		cursor: pointer;
		transform: translate(-50%, -50%);
		transition: transform var(--dur) var(--ease), background var(--dur) var(--ease), border-color var(--dur) var(--ease);
	}

	.kb-core:hover,
	.kb-core:focus-visible {
		border-color: var(--sig-text-muted);
		background: var(--sig-surface-raised);
		transform: translate(-50%, -50%) translateY(-1px);
		outline: none;
	}

	.kb-core-mark {
		display: grid;
		place-items: center;
		width: 34px;
		height: 34px;
		border: 1px solid var(--sig-border-strong);
		background: var(--sig-bg);
		flex-shrink: 0;
	}

	.kb-core-copy {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.kb-core-copy strong {
		font-family: var(--font-display);
		font-size: 13px;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.kb-core-copy small {
		font-family: var(--font-body);
		font-size: 8px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.kb-links {
		position: absolute;
		inset: 0;
		z-index: 1;
		pointer-events: none;
	}

	.kb-links line {
		stroke: var(--sig-border-strong);
		stroke-width: 0.45;
		stroke-dasharray: 3 3;
		vector-effect: non-scaling-stroke;
	}

	.kb-links line.link-muted {
		stroke: var(--sig-border);
	}

	.kb-node {
		position: absolute;
		z-index: 3;
		display: flex;
		align-items: center;
		gap: 6px;
		max-width: 145px;
		padding: 5px 7px;
		border: 1px solid var(--sig-border-strong);
		background: color-mix(in srgb, var(--sig-surface) 92%, transparent);
		color: var(--sig-text);
		text-align: left;
		cursor: pointer;
		transform: translate(-50%, -50%);
		transition: transform var(--dur) var(--ease), background var(--dur) var(--ease), border-color var(--dur) var(--ease);
	}

	.kb-node:hover,
	.kb-node:focus-visible {
		border-color: var(--sig-text-muted);
		background: var(--sig-surface-raised);
		transform: translate(-50%, -50%) translateY(-1px);
		outline: none;
	}

	.kb-node--warning {
		border-color: color-mix(in srgb, var(--sig-warning) 45%, var(--sig-border));
	}

	.kb-node--offline {
		opacity: 0.62;
	}

	.kb-node-icon {
		display: grid;
		place-items: center;
		width: 23px;
		height: 23px;
		border: 1px solid var(--sig-border);
		color: var(--sig-text-bright);
		background: var(--sig-surface);
		flex-shrink: 0;
	}

	.kb-node--memory .kb-node-icon {
		background: var(--sig-bg);
		border-color: var(--sig-border-strong);
	}

	.kb-node--source .kb-node-icon {
		background: var(--sig-highlight-muted);
	}

	.kb-signet-logo {
		width: 20px;
		height: auto;
		object-fit: contain;
	}

	.kb-node-icon .kb-signet-logo {
		width: 15px;
	}

	:global([data-theme="light"]) .kb-signet-logo {
		filter: invert(1);
	}

	.kb-node-copy {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.kb-node-copy strong {
		font-family: var(--font-body);
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.kb-node-copy small {
		font-family: var(--font-body);
		font-size: 8px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.kb-solo-note {
		position: absolute;
		left: 50%;
		top: calc(50% + 54px);
		z-index: 3;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		transform: translateX(-50%);
		text-align: center;
		pointer-events: none;
	}

	.kb-solo-note span,
	.kb-solo-note small {
		font-family: var(--font-body);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		white-space: nowrap;
	}

	.kb-solo-note span {
		font-size: 8px;
		color: var(--sig-text);
	}

	.kb-solo-note small {
		font-size: 7px;
		color: var(--sig-text-muted);
	}

	.kb-footer {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr)) minmax(105px, 1.2fr);
		gap: 1px;
		padding: var(--space-sm) var(--space-md);
		flex-shrink: 0;
	}

	.kb-stat,
	.kb-last {
		border: 1px solid var(--sig-border);
		background: var(--sig-surface-raised);
		padding: 6px 7px;
		min-width: 0;
	}

	.kb-stat span {
		display: block;
		font-family: var(--font-display);
		font-size: 15px;
		font-weight: 700;
		color: var(--sig-text-bright);
		line-height: 1;
	}

	.kb-stat small,
	.kb-last span,
	.kb-last small {
		display: block;
		font-size: 8px;
		color: var(--sig-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.kb-last small {
		margin-top: 4px;
		font-family: var(--font-body);
		color: var(--sig-text);
	}

	.empty-state {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		border: 0;
		background: transparent;
		color: var(--sig-text-muted);
		font-size: 9px;
	}

	@media (max-width: 820px) {
		.kb-footer {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}

		.kb-last {
			grid-column: 1 / -1;
		}
	}
</style>

