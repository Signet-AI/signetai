import { afterEach, describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { getSseDiagnosticsSnapshot, openBoundedSse, type BoundedSseProducer } from "./sse-stream.js";

const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

afterEach(async () => {
	for (const reader of readers.splice(0)) await reader.cancel();
});

describe("bounded SSE lifecycle", () => {
	test("registers cleanup before closing an already-aborted request", async () => {
		const before = getSseDiagnosticsSnapshot();
		const request = new AbortController();
		request.abort();
		let started = false;
		let disposed = 0;
		const sse = openBoundedSse({
			requestSignal: request.signal,
			onStart(producer) {
				started = true;
				expect(producer.signal.aborted).toBe(true);
				producer.addDisposer(() => {
					disposed += 1;
				});
			},
		});
		const reader = sse.stream.getReader();

		await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
		expect(started).toBe(true);
		expect(disposed).toBe(1);
		expect(getSseDiagnosticsSnapshot().activeStreams).toBe(before.activeStreams);
	});

	test("consumer cancellation disposes producers and detaches request abort", async () => {
		const request = new AbortController();
		let disposed = 0;
		const sse = openBoundedSse({
			requestSignal: request.signal,
			onStart(producer) {
				producer.addDisposer(() => {
					disposed += 1;
				});
				producer.write({ type: "connected" });
			},
		});
		const reader = sse.stream.getReader();
		readers.push(reader);
		await reader.read();

		await reader.cancel("client disconnected");
		request.abort();

		expect(disposed).toBe(1);
		expect(sse.signal.aborted).toBe(true);
		expect(getEventListeners(request.signal, "abort")).toHaveLength(0);
		expect(getSseDiagnosticsSnapshot().activeStreams).toBe(0);
	});

	test("slow consumers stay within the byte budget and receive a terminal overflow frame", async () => {
		const before = getSseDiagnosticsSnapshot();
		const sse = openBoundedSse({
			highWaterMarkBytes: 1024,
			maxFrameBytes: 256,
			onStart(producer) {
				for (let index = 0; index < 30; index += 1) producer.write({ index, value: "x".repeat(48) });
			},
		});
		const during = getSseDiagnosticsSnapshot();
		expect(during.activeStreams).toBe(before.activeStreams + 1);
		expect(during.queuedBytes).toBeLessThanOrEqual(1024);
		expect(during.overflowCount).toBe(before.overflowCount + 1);

		const reader = sse.stream.getReader();
		readers.push(reader);
		let text = "";
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			text += new TextDecoder().decode(chunk.value);
		}
		expect(text).toContain("event: overflow");
		expect(text).toContain('"reason":"queue_limit"');
		expect(getSseDiagnosticsSnapshot().activeStreams).toBe(before.activeStreams);
	});

	test("drop policy reports discarded bytes after the reader resumes", async () => {
		const before = getSseDiagnosticsSnapshot();
		let producer: BoundedSseProducer | undefined;
		const sse = openBoundedSse({
			highWaterMarkBytes: 1024,
			maxFrameBytes: 256,
			overflowPolicy: "drop",
			onStart(value) {
				producer = value;
				for (let index = 0; index < 30; index += 1) value.write({ index, value: "x".repeat(48) });
			},
		});
		const reader = sse.stream.getReader();
		readers.push(reader);
		let text = "";
		for (let index = 0; index < 30 && !text.includes("event: dropped"); index += 1) {
			producer?.write({ type: "after_resume", index });
			const chunk = await reader.read();
			if (chunk.done) break;
			text += new TextDecoder().decode(chunk.value);
		}

		expect(getSseDiagnosticsSnapshot().droppedEventCount).toBeGreaterThan(before.droppedEventCount);
		expect(getSseDiagnosticsSnapshot().droppedBytes).toBeGreaterThan(before.droppedBytes);
		expect(text).toContain("event: dropped");
		expect(text).toContain('"count":');
	});
});
