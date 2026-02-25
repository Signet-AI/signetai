/**
 * Reactive pipeline state store.
 *
 * Connects to the SSE log stream to detect node activity (pulses)
 * and polls /api/pipeline/status every 5s for health + queue data.
 */

import {
	PIPELINE_NODES,
	createDefaultNodeState,
	type PipelineNodeState,
	type PipelineStatusResponse,
	type LogEntry,
	type HealthStatus,
} from "./pipeline-types";
import { getPipelineStatus } from "$lib/api";

// ---------------------------------------------------------------------------
// Category -> node ID mapping (built once from topology)
// ---------------------------------------------------------------------------

const categoryToNodeIds = new Map<string, string[]>();
for (const node of PIPELINE_NODES) {
	for (const cat of node.logCategories) {
		const arr = categoryToNodeIds.get(cat);
		if (arr) arr.push(node.id);
		else categoryToNodeIds.set(cat, [node.id]);
	}
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const MAX_RECENT_LOGS = 20;

function buildInitialNodes(): Record<string, PipelineNodeState> {
	const out: Record<string, PipelineNodeState> = {};
	for (const n of PIPELINE_NODES) {
		out[n.id] = createDefaultNodeState();
	}
	return out;
}

const MAX_FEED_ENTRIES = 50;

export const pipeline = $state({
	nodes: buildInitialNodes(),
	mode: "unknown",
	connected: false,
	lastPoll: null as string | null,
	selectedNodeId: null as string | null,
	/** Global live feed of pipeline-relevant events */
	feed: [] as LogEntry[],
});

// ---------------------------------------------------------------------------
// SSE connection
// ---------------------------------------------------------------------------

let eventSource: EventSource | null = null;

export function connectSSE(): void {
	// Close existing connection if any (allows reconnect)
	if (eventSource) {
		eventSource.close();
		eventSource = null;
	}

	const isDev = import.meta.env.DEV;
	const base = isDev ? "http://localhost:3850" : "";
	eventSource = new EventSource(`${base}/api/logs/stream`);

	eventSource.onopen = () => {
		pipeline.connected = true;
	};

	eventSource.onmessage = (event) => {
		try {
			const entry: LogEntry = JSON.parse(event.data);
			if ((entry as unknown as { type: string }).type === "connected") {
				pipeline.connected = true;
				return;
			}

			// Push ALL pipeline-relevant events to the global feed
			const feed = [...pipeline.feed, entry];
			pipeline.feed = feed.length > MAX_FEED_ENTRIES
				? feed.slice(-MAX_FEED_ENTRIES)
				: feed;

			// Route to matching nodes (if any)
			const nodeIds = categoryToNodeIds.get(entry.category);
			if (!nodeIds) return;

			for (const id of nodeIds) {
				const node = pipeline.nodes[id];
				if (!node) continue;

				node.pulseCount += 1;
				node.lastActivity = entry.timestamp;

				// Append to recent logs (capped)
				const logs = [...node.recentLogs, entry];
				node.recentLogs = logs.length > MAX_RECENT_LOGS
					? logs.slice(-MAX_RECENT_LOGS)
					: logs;

				// Track errors from log level
				if (entry.level === "error") {
					node.errorCount += 1;
				}
			}
		} catch {
			// ignore parse errors
		}
	};

	eventSource.onerror = () => {
		pipeline.connected = false;
		eventSource?.close();
		eventSource = null;
		// Auto-reconnect after 3s
		setTimeout(() => {
			if (!eventSource) connectSSE();
		}, 3000);
	};
}

export function disconnectSSE(): void {
	pipeline.connected = false;
	eventSource?.close();
	eventSource = null;
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

let pollInterval: ReturnType<typeof setInterval> | null = null;

function mapHealthStatus(score: number): HealthStatus {
	if (score >= 0.8) return "healthy";
	if (score >= 0.5) return "degraded";
	if (score > 0) return "unhealthy";
	return "unknown";
}

function applyDiagnostics(diagnostics: Record<string, unknown>): void {
	for (const node of PIPELINE_NODES) {
		if (!node.diagnosticDomain) continue;
		const domain = diagnostics[node.diagnosticDomain] as
			| { score?: number; status?: string }
			| undefined;
		if (!domain) continue;

		const state = pipeline.nodes[node.id];
		if (!state) continue;

		const score = typeof domain.score === "number" ? domain.score : 0;
		state.score = score;
		state.health = mapHealthStatus(score);
		state.metrics = domain as Record<string, unknown>;
	}
}

function applyQueueCounts(
	queues: PipelineStatusResponse["queues"],
): void {
	const queueNode = pipeline.nodes.queue;
	if (queueNode) {
		const mem = queues.memory;
		const sum = queues.summary;
		queueNode.queueDepth = mem.pending + mem.leased + sum.pending + sum.leased;
		queueNode.metrics = { memory: mem, summary: sum };
	}

	const extractionNode = pipeline.nodes.extraction;
	if (extractionNode) {
		extractionNode.queueDepth = queues.memory.pending;
	}

	const summaryNode = pipeline.nodes.summary;
	if (summaryNode) {
		summaryNode.queueDepth = queues.summary.pending;
	}
}

export async function pollStatus(): Promise<void> {
	try {
		const status = await getPipelineStatus();
		if (!status) return;

		pipeline.mode = status.mode;
		pipeline.lastPoll = new Date().toISOString();

		// Apply diagnostics health
		if (status.diagnostics) {
			applyDiagnostics(status.diagnostics);
		}

		// Apply queue counts
		if (status.queues) {
			applyQueueCounts(status.queues);
		}

		// Apply worker running states
		if (status.workers) {
			for (const [id, ws] of Object.entries(status.workers)) {
				const node = pipeline.nodes[id];
				if (node && ws.running) {
					// If the node had "unknown" health and is running, it's at least healthy
					if (node.health === "unknown") {
						node.health = "healthy";
						node.score = 1;
					}
				}
			}
		}

		// Apply error summary
		if (status.errorSummary) {
			for (const [stage, count] of Object.entries(status.errorSummary)) {
				// Map error stages to node IDs
				const nodeId =
					stage === "extraction" ? "extraction" :
					stage === "decision" ? "extraction" :
					stage === "embedding" ? "database" :
					stage === "mutation" ? "database" :
					stage === "connector" ? "sync" :
					null;
				if (nodeId) {
					const node = pipeline.nodes[nodeId];
					if (node) node.errorCount = count;
				}
			}
		}
	} catch {
		// silently ignore poll failures
	}
}

export function startPolling(intervalMs = 5000): void {
	if (pollInterval) return;
	pollStatus();
	pollInterval = setInterval(pollStatus, intervalMs);
}

export function stopPolling(): void {
	if (pollInterval) {
		clearInterval(pollInterval);
		pollInterval = null;
	}
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function selectNode(id: string | null): void {
	pipeline.selectedNodeId = id;
}
