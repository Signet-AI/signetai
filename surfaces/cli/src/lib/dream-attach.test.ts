import "../../../../tests/support/connector-safety.js";
import { describe, expect, it } from "bun:test";
import type { DaemonStreamResult } from "./daemon.js";
import {
	DreamingAttachError,
	DreamingAttachView,
	followDreamingPass,
	parseDreamingAttachEnvelope,
	parseSseEventBlock,
	readSseStream,
} from "./dream-attach.js";

function streamResult(body: string): DaemonStreamResult {
	return { ok: true, response: new Response(body, { headers: { "content-type": "text/event-stream" } }) };
}

describe("Dreaming attach stream", () => {
	it("parses comments, ids, and multiline SSE data", () => {
		const parsed = parseSseEventBlock(': heartbeat\nid: 7\nevent: snapshot\ndata: {\ndata: "ok": true\ndata: }\n\n');
		if (!parsed) throw new Error("expected an SSE event");
		expect(parsed).toEqual({ event: "snapshot", id: "7", data: '{\n"ok": true\n}' });
		expect(parseDreamingAttachEnvelope(parsed)).toEqual({ ok: true });
	});

	it("renders an auditable activity timeline with tool payloads and reasoning summaries", () => {
		const view = new DreamingAttachView(() => {});
		view.applySnapshot({
			passId: "pass-1",
			agentId: "agent-a",
			mode: "incremental",
			status: "running",
			startedAt: "2026-08-05T00:00:00.000Z",
			completedAt: null,
			summary: "Reviewed current evidence",
			error: null,
			cursor: 1,
			replayFrom: 1,
			replayTo: 1,
			tokensConsumed: 130,
			tokensInput: 100,
			tokensOutput: 30,
			tokensCacheRead: 4,
			tokensCacheWrite: 2,
			tokensCost: 0.02,
			mutationsApplied: 2,
			mutationsSkipped: 1,
			mutationsFailed: 0,
		});
		view.applyEvent({
			passId: "pass-1",
			agentId: "agent-a",
			cursor: 2,
			timestamp: "2026-08-05T00:00:01.000Z",
			type: "assistant_delta",
			data: { delta: "Checking the evidence." },
		});
		view.applyEvent({
			passId: "pass-1",
			agentId: "agent-a",
			cursor: 3,
			timestamp: "2026-08-05T00:00:02.000Z",
			type: "tool_start",
			data: {
				toolName: "search_evidence",
				raw: { type: "tool_execution_start", toolName: "search_evidence", input: { query: "source provenance" } },
			},
		});
		view.applyEvent({
			passId: "pass-1",
			agentId: "agent-a",
			cursor: 4,
			timestamp: "2026-08-05T00:00:03.000Z",
			type: "thinking_delta",
			data: {
				delta: "Assessing source provenance",
				raw: { assistantMessageEvent: { type: "thinking_delta", auditMarker: "provider-thought-event" } },
			},
		});
		view.applyEvent({
			passId: "pass-1",
			agentId: "agent-a",
			cursor: 5,
			timestamp: "2026-08-05T00:00:03.100Z",
			type: "thinking_delta",
			data: { delta: " before deciding whether to mutate." },
		});
		const timeline = view.render(120).join("\n");
		expect(timeline).toContain("Activity");
		expect(timeline).toContain("Reviewed current evidence");
		expect(timeline).toContain("1 observed tool calls");
		expect(timeline).toContain("tokens 130 total · 100 in · 30 out");
		expect(timeline).toContain("$0.020000");
		expect(timeline).toContain("2 applied/1 skipped/0 failed");
		expect(timeline).toContain("Assistant");
		expect(timeline).toContain("Checking the evidence.");
		expect(timeline).toContain("search_evidence");
		expect(timeline).toContain("Input");
		expect(timeline).toContain("source provenance");
		expect(timeline).toContain("Model reasoning");
		expect(timeline).toContain("Assessing source provenance before deciding whether to mutate.");
		view.handleInput("\u0016");
		expect(view.isRawDetail).toBe(true);
		expect(view.render(120).join("\n")).toContain('"type": "tool_execution_start"');
		expect(view.render(120).join("\n")).toContain("Assessing source provenance before deciding whether to mutate.");
		expect(view.render(120).join("\n")).toContain("provider-thought-event");
	});

	it("keeps assistant text together across hidden updates and shows every raw delta", () => {
		const view = new DreamingAttachView(() => {});
		view.applyEvent({
			passId: "pass-1",
			agentId: "agent-a",
			cursor: 1,
			timestamp: "2026-08-05T00:00:01.000Z",
			type: "assistant_delta",
			data: {
				delta: "hello ",
				raw: { assistantMessageEvent: { type: "text_delta", delta: "hello " } },
			},
		});
		view.applyEvent({
			passId: "pass-1",
			agentId: "agent-a",
			cursor: 2,
			timestamp: "2026-08-05T00:00:01.100Z",
			type: "message_update",
			data: { eventType: "toolcall_delta" },
		});
		view.applyEvent({
			passId: "pass-1",
			agentId: "agent-a",
			cursor: 3,
			timestamp: "2026-08-05T00:00:01.200Z",
			type: "assistant_delta",
			data: {
				delta: "world",
				raw: { assistantMessageEvent: { type: "text_delta", delta: "world" } },
			},
		});

		const concise = view.render(120).join("\n");
		expect(concise.match(/Assistant/g)).toHaveLength(1);
		expect(concise).toContain("hello world");

		view.handleInput("\u0016");
		const raw = view.render(120).join("\n");
		expect(raw.match(/"type": "text_delta"/g)).toHaveLength(2);
	});

	it("reconnects from the latest cursor and stops on the terminal event", async () => {
		const paths: string[] = [];
		const timeouts: number[] = [];
		const view = new DreamingAttachView(() => {});
		const controller = new AbortController();
		const fetchStream = async (
			path: string,
			options?: RequestInit & { timeout?: number },
		): Promise<DaemonStreamResult> => {
			paths.push(path);
			timeouts.push(options?.timeout ?? 0);
			if (paths.length === 1) {
				return streamResult(
					[
						`event: snapshot\ndata: ${JSON.stringify({
							type: "snapshot",
							passId: "pass-1",
							snapshot: {
								passId: "pass-1",
								agentId: "agent-a",
								mode: "incremental",
								status: "running",
								startedAt: "2026-08-05T00:00:00.000Z",
								completedAt: null,
								summary: null,
								error: null,
								cursor: 1,
								replayFrom: 1,
								replayTo: 1,
							},
						})}\n\n`,
						`id: 2\nevent: assistant_delta\ndata: ${JSON.stringify({
							type: "assistant_delta",
							passId: "pass-1",
							cursor: 2,
							agentId: "agent-a",
							timestamp: "2026-08-05T00:00:01.000Z",
							data: { delta: "hello" },
						})}\n\n`,
					].join(""),
				);
			}
			return streamResult(
				`id: 3\nevent: pass_completed\ndata: ${JSON.stringify({
					type: "pass_completed",
					passId: "pass-1",
					cursor: 3,
					agentId: "agent-a",
					timestamp: "2026-08-05T00:00:02.000Z",
					data: { status: "completed", summary: "done" },
				})}\n\n`,
			);
		};

		const terminal = await followDreamingPass({
			passId: "pass-1",
			fetchStream,
			view,
			signal: controller.signal,
			streamTimeoutMs: 35_000,
			maxReconnects: 1,
			sleep: async () => {},
		});

		expect(terminal).toBe(true);
		expect(paths).toEqual(["/api/dream/passes/pass-1/events", "/api/dream/passes/pass-1/events?after=2"]);
		expect(timeouts).toEqual([35_000, 35_000]);
		expect(view.cursor).toBe(3);
	});

	it("does not block on a chunked SSE body", async () => {
		const chunks = ['event: lifecycle\ndata: {"type":"lifecycle",', '"passId":"pass-1"}\n\n'];
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
				controller.close();
			},
		});
		const records: string[] = [];
		await readSseStream(body, (record) => records.push(record.data), new AbortController().signal);
		expect(records).toEqual(['{"type":"lifecycle","passId":"pass-1"}']);
	});

	it("cancels a pending read when Ctrl+C aborts the attachment", async () => {
		const controller = new AbortController();
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		const pending = readSseStream(body, () => {}, controller.signal);
		setTimeout(() => controller.abort(), 5);
		await pending;
		expect(cancelled).toBe(true);
	});

	it("bounds repeated successful stream terminations", async () => {
		const view = new DreamingAttachView(() => {});
		let attempts = 0;
		await expect(
			followDreamingPass({
				passId: "pass-1",
				fetchStream: async () => {
					attempts += 1;
					return streamResult("");
				},
				view,
				signal: new AbortController().signal,
				maxReconnects: 2,
				sleep: async () => {},
			}),
		).rejects.toBeInstanceOf(DreamingAttachError);
		expect(attempts).toBe(3);
	});

	it("toggles raw event details locally without reconnecting the stream", async () => {
		const controller = new AbortController();
		const view = new DreamingAttachView(() => controller.abort());
		const paths: string[] = [];
		const fetchStream = async (path: string): Promise<DaemonStreamResult> => {
			paths.push(path);
			return { ok: true, response: new Response(new ReadableStream<Uint8Array>()) };
		};
		const follow = followDreamingPass({
			passId: "pass-1",
			fetchStream,
			view,
			signal: controller.signal,
			maxReconnects: 2,
			sleep: async () => {},
		});
		setTimeout(() => view.handleInput("\u0016"), 5);
		setTimeout(() => view.handleInput("\u0003"), 10);

		expect(await follow).toBe(false);
		expect(paths).toEqual(["/api/dream/passes/pass-1/events"]);
		expect(view.isRawDetail).toBe(true);
	});
});
