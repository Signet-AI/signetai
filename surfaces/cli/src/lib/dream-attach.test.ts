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

	it("renders concise output by default and exposes raw data after Ctrl+V", () => {
		const view = new DreamingAttachView(() => {});
		view.applySnapshot({
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
		});
		view.applyEvent({
			passId: "pass-1",
			agentId: "agent-a",
			cursor: 2,
			timestamp: "2026-08-05T00:00:01.000Z",
			type: "tool_start",
			data: { toolName: "search_evidence", secret: "raw-payload" },
		});
		const concise = view.render(120).join("\n");
		expect(concise).toContain("tool search_evidence started");
		expect(concise).not.toContain("raw-payload");
		view.handleInput("\u0016");
		expect(view.isVerbose).toBe(true);
		expect(view.render(120).join("\n")).toContain("raw-payload");
	});

	it("reconnects from the latest cursor and stops on the terminal event", async () => {
		const paths: string[] = [];
		const view = new DreamingAttachView(() => {});
		const controller = new AbortController();
		const fetchStream = async (path: string): Promise<DaemonStreamResult> => {
			paths.push(path);
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
			maxReconnects: 1,
			sleep: async () => {},
		});

		expect(terminal).toBe(true);
		expect(paths).toEqual(["/api/dream/passes/pass-1/events", "/api/dream/passes/pass-1/events?after=2"]);
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

	it("reconnects the same SSE transport when verbose mode is toggled", async () => {
		const view = new DreamingAttachView(() => {});
		const paths: string[] = [];
		const fetchStream = async (path: string): Promise<DaemonStreamResult> => {
			paths.push(path);
			if (paths.length === 1) {
				return {
					ok: true,
					response: new Response(new ReadableStream<Uint8Array>()),
				};
			}
			return streamResult(
				`event: pass_completed\ndata: ${JSON.stringify({
					type: "pass_completed",
					passId: "pass-1",
					agentId: "agent-a",
					cursor: 1,
					timestamp: new Date().toISOString(),
					data: { status: "completed" },
				})}\n\n`,
			);
		};
		const follow = followDreamingPass({
			passId: "pass-1",
			fetchStream,
			view,
			signal: new AbortController().signal,
			maxReconnects: 2,
			sleep: async () => {},
		});
		setTimeout(() => view.handleInput("\u0016"), 5);

		expect(await follow).toBe(true);
		expect(paths).toEqual(["/api/dream/passes/pass-1/events", "/api/dream/passes/pass-1/events?verbose=1"]);
		expect(view.isVerbose).toBe(true);
	});
});
