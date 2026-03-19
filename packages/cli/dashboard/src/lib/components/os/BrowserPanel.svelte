<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import Globe from "@lucide/svelte/icons/globe";
	import ExternalLink from "@lucide/svelte/icons/external-link";
	import MessageSquare from "@lucide/svelte/icons/message-square";
	import { API_BASE } from "$lib/api";

	// Browser state from SSE events
	let currentUrl = $state<string | null>(null);
	let currentTitle = $state<string | null>(null);
	let currentTabId = $state<string | null>(null);
	let lastUpdated = $state<string | null>(null);
	let connected = $state(false);
	let eventSource: EventSource | null = null;

	function connectSSE(): void {
		if (eventSource) {
			eventSource.close();
		}

		try {
			eventSource = new EventSource(`${API_BASE}/api/os/events/stream`);

			eventSource.onopen = () => {
				connected = true;
			};

			eventSource.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data);
					if (data.type === "browser.navigate") {
						currentUrl = data.payload?.url ?? null;
						currentTitle = data.payload?.title ?? null;
						currentTabId = data.payload?.tabId ?? null;
						lastUpdated = new Date().toLocaleTimeString();
					}
				} catch {
					// Ignore parse errors
				}
			};

			eventSource.onerror = () => {
				connected = false;
				// Auto-reconnect is handled by EventSource spec
			};
		} catch {
			connected = false;
		}
	}

	function handleBrowse(): void {
		// Placeholder — would launch `signet browse` in Phase 9
		// TODO: Phase 9 — wire to signet browse CLI launch
	}

	function getDomain(url: string): string {
		try {
			return new URL(url).hostname;
		} catch {
			return url;
		}
	}

	onMount(() => {
		connectSSE();
	});

	onDestroy(() => {
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
	});
</script>

<div class="browser-panel">
	<!-- Left pane: Agent chat placeholder -->
	<div class="browser-panel-left">
		<div class="panel-header">
			<MessageSquare class="size-3.5" />
			<span class="sig-label">Agent</span>
		</div>
		<div class="chat-placeholder">
			<span class="sig-eyebrow">Agent chat coming in Phase 9</span>
			<textarea
				class="chat-input"
				placeholder="Ask the agent about what you're browsing..."
				disabled
			></textarea>
		</div>
	</div>

	<!-- Divider -->
	<div class="panel-divider"></div>

	<!-- Right pane: Browser info -->
	<div class="browser-panel-right">
		<div class="panel-header">
			<Globe class="size-3.5" />
			<span class="sig-label">Browser</span>
			<span class="connection-dot" class:connected></span>
		</div>

		<div class="browser-info">
			{#if currentUrl}
				<div class="browser-page">
					<div class="page-title">
						{currentTitle ?? "Untitled"}
					</div>
					<div class="page-url">
						<span class="url-domain">{getDomain(currentUrl)}</span>
						<span class="url-path">{currentUrl}</span>
					</div>
					{#if currentTabId}
						<div class="page-meta">
							<span class="sig-eyebrow">Tab {currentTabId}</span>
							{#if lastUpdated}
								<span class="sig-eyebrow">Updated {lastUpdated}</span>
							{/if}
						</div>
					{/if}
				</div>
			{:else}
				<div class="browser-empty">
					<Globe class="size-5 empty-icon" />
					<span class="sig-eyebrow">No active browser session</span>
					<span class="sig-label" style="color: var(--sig-text-muted); font-size: 11px;">
						Run <code>signet browse</code> to start
					</span>
				</div>
			{/if}
		</div>

		<div class="browser-actions">
			<button class="sig-switch browse-btn" onclick={handleBrowse}>
				<ExternalLink class="size-3" />
				Browse
			</button>
		</div>
	</div>
</div>

<style>
	.browser-panel {
		display: flex;
		border: 1px solid var(--sig-border);
		border-radius: var(--radius);
		background: var(--sig-surface);
		overflow: hidden;
		min-height: 160px;
		max-height: 220px;
	}

	/* Left pane — agent chat */
	.browser-panel-left {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	/* Right pane — browser info */
	.browser-panel-right {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.panel-divider {
		width: 1px;
		background: var(--sig-border);
		flex-shrink: 0;
	}

	.panel-header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--sig-border);
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-muted);
	}

	.connection-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--sig-text-muted);
		margin-left: auto;
		flex-shrink: 0;
	}

	.connection-dot.connected {
		background: #4a8a4a;
		box-shadow: 0 0 4px #4a8a4a;
	}

	/* Chat placeholder */
	.chat-placeholder {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 12px;
	}

	.chat-input {
		width: 100%;
		height: 40px;
		resize: none;
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border);
		border-radius: var(--radius);
		color: var(--sig-text-muted);
		font-family: var(--font-mono);
		font-size: 11px;
		padding: 8px;
		opacity: 0.5;
	}

	/* Browser info */
	.browser-info {
		flex: 1;
		padding: 10px;
		overflow-y: auto;
	}

	.browser-page {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.page-title {
		font-family: var(--font-mono);
		font-size: 13px;
		color: var(--sig-text-bright);
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.page-url {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.url-domain {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-accent);
		font-weight: 500;
	}

	.url-path {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.page-meta {
		display: flex;
		gap: 12px;
		padding-top: 4px;
	}

	.browser-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		height: 100%;
		text-align: center;
	}

	.browser-empty :global(.empty-icon) {
		color: var(--sig-text-muted);
		opacity: 0.4;
	}

	.browser-empty code {
		font-family: var(--font-mono);
		background: var(--sig-surface-raised);
		padding: 1px 4px;
		border-radius: 2px;
		font-size: 10px;
	}

	/* Actions */
	.browser-actions {
		padding: 6px 10px;
		border-top: 1px solid var(--sig-border);
		display: flex;
		justify-content: flex-end;
	}

	.browse-btn {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		padding: 4px 10px;
	}
</style>
