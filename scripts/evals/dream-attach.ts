#!/usr/bin/env bun
/**
 * Deterministic Dreaming attach eval (#1601).
 *
 * Exercises the bounded daemon event bridge and the read-only CLI stream
 * consumer with fixed local inputs. It fails if replay cursors are not
 * monotonic, raw payloads escape their bound, the viewer cannot resume from a
 * cursor, or the concise/raw and detach controls are not isolated.
 */

import {
	DREAMING_LIVE_MAX_EVENTS,
	DREAMING_LIVE_MAX_EVENT_CHARS,
	DREAMING_LIVE_MAX_RAW_CHARS,
	DreamingLiveEventHub,
	publishDreamingAgentEvent,
} from "../../platform/daemon/src/pipeline/dreaming-live-events";
import type { DaemonStreamResult } from "../../surfaces/cli/src/lib/daemon";
import { DreamingAttachView, followDreamingPass } from "../../surfaces/cli/src/lib/dream-attach";

function streamResult(body: string): DaemonStreamResult {
	return { ok: true, response: new Response(body, { headers: { "content-type": "text/event-stream" } }) };
}

const hub = new DreamingLiveEventHub();
hub.startPass({ passId: "eval-pass", agentId: "eval-agent", mode: "incremental" });
for (let index = 0; index < DREAMING_LIVE_MAX_EVENTS + 8; index += 1) {
	hub.publish("eval-pass", "lifecycle", { index });
}
const replay = hub.subscribe("eval-pass", 0, () => {});
const replayCursors = replay?.replay.map((event) => event.cursor) ?? [];
const monotonicReplay = replayCursors.every((cursor, index) => index === 0 || cursor > (replayCursors[index - 1] ?? 0));
const boundedEvents = replayCursors.length <= DREAMING_LIVE_MAX_EVENTS && replay?.gap?.reason === "buffer_exhausted";
replay?.unsubscribe();

const rawHub = new DreamingLiveEventHub();
rawHub.startPass({ passId: "eval-raw", agentId: "eval-agent", mode: "incremental" });
publishDreamingAgentEvent(
	"eval-raw",
	{
		type: "tool_execution_start",
		toolCallId: "tool-1",
		toolName: "search_evidence",
		arguments: "raw-argument-".repeat(DREAMING_LIVE_MAX_RAW_CHARS),
	},
	rawHub,
);
const rawEvents = rawHub.subscribe("eval-raw", 0, () => {})?.replay ?? [];
const rawPayload = rawEvents.find((event) => event.type === "tool_start")?.data;
const boundedRaw = rawPayload !== undefined && JSON.stringify(rawPayload).length <= DREAMING_LIVE_MAX_EVENT_CHARS;

let detached = false;
const view = new DreamingAttachView(() => {
	detached = true;
});
view.applySnapshot({
	passId: "eval-stream",
	agentId: "eval-agent",
	mode: "incremental",
	status: "running",
	startedAt: new Date(Date.now() - 2_000).toISOString(),
	completedAt: null,
	summary: null,
	error: null,
	cursor: 1,
	replayFrom: 1,
	replayTo: 1,
});
view.applyEvent({
	passId: "eval-stream",
	agentId: "eval-agent",
	cursor: 2,
	timestamp: new Date().toISOString(),
	type: "tool_start",
	data: { toolName: "search_evidence", raw: { secret: "operator-opt-in" } },
});
const concise = view.render(120).join("\n");
view.handleInput("\u0016");
const verbose = view.render(120).join("\n");
view.handleInput("\u0003");

const paths: string[] = [];
const streamView = new DreamingAttachView(() => {});
const terminal = await followDreamingPass({
	passId: "eval-stream",
	fetchStream: async (path): Promise<DaemonStreamResult> => {
		paths.push(path);
		return streamResult(
			[
				`event: snapshot\ndata: ${JSON.stringify({
					type: "snapshot",
					passId: "eval-stream",
					snapshot: {
						passId: "eval-stream",
						agentId: "eval-agent",
						mode: "incremental",
						status: "running",
						startedAt: new Date().toISOString(),
						completedAt: null,
						summary: null,
						error: null,
						cursor: 1,
						replayFrom: 1,
						replayTo: 1,
					},
				})}\n\n`,
				`id: 2\nevent: pass_completed\ndata: ${JSON.stringify({
					type: "pass_completed",
					passId: "eval-stream",
					agentId: "eval-agent",
					cursor: 2,
					timestamp: new Date().toISOString(),
					data: { status: "completed", summary: "eval complete" },
				})}\n\n`,
			].join(""),
		);
	},
	view: streamView,
	signal: new AbortController().signal,
	maxReconnects: 1,
	sleep: async () => {},
});

const checks = {
	monotonicReplay,
	boundedEvents,
	boundedRaw,
	conciseHidesRaw: !concise.includes("operator-opt-in"),
	verboseShowsRaw: verbose.includes("operator-opt-in"),
	ctrlCDetaches: detached,
	terminalEventCompletes: terminal && streamView.cursor === 2,
	resumesFromInitialCursor: paths[0] === "/api/dream/passes/eval-stream/events",
};
const verdict = Object.values(checks).every(Boolean) ? "pass" : "fail";
const report = {
	verdict,
	checks,
	replayEvents: replayCursors.length,
	maxReplayEvents: DREAMING_LIVE_MAX_EVENTS,
	maxRawChars: DREAMING_LIVE_MAX_RAW_CHARS,
};
console.log(JSON.stringify(report, null, 2));
process.exit(verdict === "pass" ? 0 : 1);
