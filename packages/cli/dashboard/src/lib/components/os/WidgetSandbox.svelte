<script lang="ts">
import { API_BASE } from "$lib/api";
import { getWidgetAction, registerWidgetSandbox, unregisterWidgetSandbox } from "$lib/stores/os.svelte";
import { onDestroy, onMount } from "svelte";
import { broadcastWidgetEvent, getLastEvent } from "./widget-events.svelte";
import { buildSrcdoc } from "./widget-theme";

interface Props {
	html: string;
	serverId: string;
	expanded?: boolean;
}

let { html, serverId, expanded = false }: Props = $props();

let iframe: HTMLIFrameElement | null = $state(null);
let ready = $state(false);

// Pending promises for page-agent bridge calls
let agentRid = 0;
const agentPending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/**
 * Get DOM state from the widget iframe (for agent automation).
 * Returns simplified HTML of interactive elements for LLM consumption.
 */
export function getDomState(): Promise<unknown> {
	return new Promise((resolve, reject) => {
		if (!iframe?.contentWindow || !ready) {
			return reject(new Error("Widget iframe not ready"));
		}
		const id = `agent_${++agentRid}`;
		agentPending.set(id, { resolve, reject });
		postToWidget({ type: "signet:getDomState", id });
		// Timeout after 10s
		setTimeout(() => {
			if (agentPending.has(id)) {
				agentPending.delete(id);
				reject(new Error("getDomState timeout"));
			}
		}, 10000);
	});
}

/**
 * Execute an action in the widget iframe (click, type, scroll, etc.).
 */
export function executeAction(action: {
	type: string;
	index?: number;
	text?: string;
	direction?: string;
	amount?: number;
}): Promise<unknown> {
	return new Promise((resolve, reject) => {
		if (!iframe?.contentWindow || !ready) {
			return reject(new Error("Widget iframe not ready"));
		}
		const id = `agent_${++agentRid}`;
		agentPending.set(id, { resolve, reject });
		postToWidget({ type: "signet:executeAction", id, action });
		setTimeout(() => {
			if (agentPending.has(id)) {
				agentPending.delete(id);
				reject(new Error("executeAction timeout"));
			}
		}, 10000);
	});
}

/**
 * Start agent mode — shows mask + cursor overlay in the widget.
 */
export function agentStart(): void {
	if (iframe?.contentWindow && ready) {
		postToWidget({ type: "signet:agentStart" });
	}
}

/**
 * Stop agent mode — hides the mask/cursor overlay.
 */
export function agentStop(): void {
	if (iframe?.contentWindow && ready) {
		postToWidget({ type: "signet:agentStop" });
	}
}

const srcdoc = $derived(buildSrcdoc(html, serverId));

function handleMessage(e: MessageEvent): void {
	if (!iframe || e.source !== iframe.contentWindow) return;

	const data = e.data;
	if (!data || typeof data.type !== "string") return;

	if (data.type === "signet:ready") {
		ready = true;
		return;
	}

	if (data.type === "signet:callTool") {
		callTool(data.id, data.tool, data.args);
		return;
	}

	if (data.type === "signet:readResource") {
		readResource(data.id, data.uri);
		return;
	}

	if (data.type === "signet:emit") {
		broadcastWidgetEvent(serverId, data.eventType, data.data);
		return;
	}

	// Page-agent bridge responses
	if (data.type === "signet:domState" && data.id && agentPending.has(data.id)) {
		const pending = agentPending.get(data.id);
		pending?.resolve(data.result);
		agentPending.delete(data.id);
		return;
	}

	if (data.type === "signet:actionResult" && data.id && agentPending.has(data.id)) {
		const pending = agentPending.get(data.id);
		pending?.resolve(data.result);
		agentPending.delete(data.id);
		return;
	}
}

async function callTool(id: string, tool: string, args: Record<string, unknown>): Promise<void> {
	try {
		const res = await fetch(`${API_BASE}/api/marketplace/mcp/call`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ serverId, toolName: tool, args }),
		});
		const data = await res.json();
		if (data.success) {
			postToWidget({ type: "signet:result", id, result: data.result });
		} else {
			postToWidget({
				type: "signet:error",
				id,
				error: data.error ?? "Tool call failed",
			});
		}
	} catch (err) {
		postToWidget({
			type: "signet:error",
			id,
			error: err instanceof Error ? err.message : "Unknown error",
		});
	}
}

async function readResource(id: string, uri: string): Promise<void> {
	try {
		const res = await fetch(`${API_BASE}/api/marketplace/mcp/read-resource`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ serverId, uri }),
		});
		const data = await res.json();
		if (data.success) {
			postToWidget({ type: "signet:result", id, result: data.contents });
		} else {
			postToWidget({
				type: "signet:error",
				id,
				error: data.error ?? "Resource read failed",
			});
		}
	} catch (err) {
		postToWidget({
			type: "signet:error",
			id,
			error: err instanceof Error ? err.message : "Unknown error",
		});
	}
}

/**
 * Send an action to this widget (refresh, navigate, highlight).
 * For 'refresh': force iframe reload so React re-mounts and fetches fresh data.
 * For 'highlight': send postMessage to find and highlight matching element.
 */
$effect(() => {
	const action = getWidgetAction(serverId);
	if (action && ready) {
		if (action.action === "refresh") {
			// Force full iframe reload: reset srcdoc to trigger React remount
			// This causes useEffect to re-run, fetching fresh data from MCP
			if (iframe) {
				ready = false;
				const currentSrcdoc = iframe.srcdoc;
				iframe.srcdoc = "";
				requestAnimationFrame(() => {
					if (iframe) {
						iframe.srcdoc = currentSrcdoc;
					}
				});
			}
		} else {
			postToWidget({ type: "signet:action", ...action });
		}
	}
});

function postToWidget(msg: Record<string, unknown>): void {
	// srcdoc iframes have a null origin, so we must use "*" as the targetOrigin.
	// This is safe because: (1) sandbox="allow-scripts" prevents navigation,
	// (2) there's no allow-same-origin so the iframe can't access parent cookies/storage,
	// (3) the iframe content is our own generated HTML, not an external URL.
	iframe?.contentWindow?.postMessage(msg, "*");
}

// Watch the cross-widget event bus and forward events from other widgets
$effect(() => {
	const evt = getLastEvent();
	if (evt && evt.serverId !== serverId && ready) {
		postToWidget({ type: "signet:event", eventType: evt.eventType, data: evt.data });
	}
});

onMount(() => {
	window.addEventListener("message", handleMessage);
	// Register this sandbox so AgentChat can call getDomState/executeAction
	registerWidgetSandbox(serverId, { getDomState, executeAction, agentStart, agentStop });
});

onDestroy(() => {
	window.removeEventListener("message", handleMessage);
	unregisterWidgetSandbox(serverId);
});
</script>

<div class="widget-sandbox" class:expanded>
	<iframe
		bind:this={iframe}
		{srcdoc}
		sandbox="allow-scripts"
		title="Widget: {serverId}"
		class="widget-iframe"
	></iframe>
	{#if !ready}
		<div class="widget-loading">
			<span class="widget-loading-text">Loading...</span>
		</div>
	{/if}
</div>

<style>
	.widget-sandbox {
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
	}

	.widget-iframe {
		width: 100%;
		height: 100%;
		border: none;
		background: var(--sig-bg);
	}

	.widget-loading {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--sig-surface);
		z-index: 1;
	}

	.widget-loading-text {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
</style>
