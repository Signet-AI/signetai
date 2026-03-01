/**
 * ANSI-colored text formatters for pipeline events.
 *
 * Each formatter produces string arrays suitable for
 * pi-tui's setWidget() which renders lines as-is.
 */

import type { PipelineEvent } from "./types.js";

// ANSI escape codes — no dependency needed
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";
const WHITE = "\x1b[37m";

function timestamp(ts: number): string {
	const d = new Date(ts);
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	const s = String(d.getSeconds()).padStart(2, "0");
	return `${DIM}${h}:${m}:${s}${RESET}`;
}

function truncate(str: string, max: number): string {
	if (str.length <= max) return str;
	return `${str.slice(0, max - 3)}...`;
}

export function formatEvent(event: PipelineEvent): string {
	const ts = timestamp(event.timestamp);

	switch (event.kind) {
		case "hook":
			return `${ts} ${CYAN}hook${RESET} ${BOLD}${event.name}${RESET} ${DIM}${event.durationMs}ms${RESET} ${GREEN}${event.memoryCount} memories${RESET} ${DIM}${event.injectChars} chars${RESET}`;

		case "extraction":
			return `${ts} ${MAGENTA}extract${RESET} ${event.facts} facts, ${event.entities} entities ${DIM}${event.durationMs}ms${RESET}`;

		case "decision": {
			const color =
				event.action === "add"
					? GREEN
					: event.action === "update"
						? YELLOW
						: event.action === "delete"
							? RED
							: DIM;
			const conf = Math.round(event.confidence * 100);
			return `${ts} ${color}${event.action}${RESET} ${DIM}${conf}%${RESET} ${truncate(event.content, 60)}`;
		}

		case "memory_write":
			return `${ts} ${GREEN}write${RESET} ${DIM}${event.id.slice(0, 8)}${RESET} [${event.type}] ${truncate(event.content, 50)}`;

		case "llm_call": {
			const cost =
				event.costUsd > 0
					? ` ${YELLOW}$${event.costUsd.toFixed(4)}${RESET}`
					: "";
			return `${ts} ${BLUE}llm${RESET} ${event.provider} ${DIM}in:${event.inputTokens} out:${event.outputTokens}${RESET}${cost} ${DIM}${event.durationMs}ms${RESET}`;
		}

		case "session_claim":
			return `${ts} ${WHITE}session${RESET} ${BOLD}${event.harness}${RESET} ${DIM}${event.runtimePath}${RESET} key=${DIM}${event.sessionKey.slice(0, 12)}${RESET}`;

		case "injection_candidates":
			return `${ts} ${CYAN}inject${RESET} ${event.injected}/${event.total} candidates served`;

		case "pipeline_worker":
			return `${ts} ${DIM}worker${RESET} ${event.worker}: ${event.status}`;
	}
}

/** Format a batch of events into lines for the widget */
export function formatEvents(events: ReadonlyArray<PipelineEvent>): string[] {
	if (events.length === 0) {
		return [`${DIM}  no pipeline events yet${RESET}`];
	}

	const header = `${DIM}── signet pipeline ──${RESET}`;
	const lines = events.map(formatEvent);
	return [header, ...lines];
}

/** Summary line for the status bar */
export function formatStatusLine(
	events: ReadonlyArray<PipelineEvent>,
	mode: string,
): string {
	const hookCount = events.filter((e) => e.kind === "hook").length;
	const writeCount = events.filter((e) => e.kind === "memory_write").length;
	const llmCount = events.filter((e) => e.kind === "llm_call").length;

	return `${DIM}signet${RESET} ${hookCount} hooks ${writeCount} writes ${llmCount} llm ${DIM}[${mode}]${RESET}`;
}
