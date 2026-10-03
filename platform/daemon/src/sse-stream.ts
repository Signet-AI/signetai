export const SSE_DEFAULT_HIGH_WATER_MARK_BYTES = 256 * 1024;
export const SSE_DEFAULT_MAX_FRAME_BYTES = 64 * 1024;

export type SseWriteStatus = "accepted" | "closed" | "overflow" | "dropped";
export type SseOverflowReason = "queue_limit" | "frame_too_large";

export interface SseFrameOptions {
	readonly event?: string;
	readonly id?: string | number;
}

export interface BoundedSseProducer {
	readonly stream: ReadableStream<Uint8Array>;
	readonly response: Response;
	readonly signal: AbortSignal;
	readonly isClosed: boolean;
	readonly queuedBytes: number;
	write(data: unknown, frame?: SseFrameOptions): SseWriteStatus;
	writeFinal(data: unknown, frame?: SseFrameOptions): SseWriteStatus;
	writeComment(comment: string): SseWriteStatus;
	close(): void;
	addDisposer(dispose: () => void): () => void;
	addDrainListener(listener: (queuedBytes: number) => void): () => void;
}

export type SseHeartbeat =
	| { readonly intervalMs: number; readonly comment: string }
	| { readonly intervalMs: number; readonly event: string; readonly data: unknown };

export interface OpenBoundedSseOptions {
	readonly requestSignal?: AbortSignal;
	readonly highWaterMarkBytes?: number;
	readonly maxFrameBytes?: number;
	readonly overflowPolicy?: "close" | "drop";
	readonly overflowEvent?: {
		readonly name?: string;
		readonly payload?: (reason: SseOverflowReason) => unknown;
	};
	readonly heartbeat?: SseHeartbeat;
	readonly headers?: HeadersInit;
	readonly onStart?: (producer: BoundedSseProducer) => void;
}

interface ActiveSseStream {
	readonly openedAt: number;
	readonly queuedBytes: () => number;
}

const encoder = new TextEncoder();
const activeStreams = new Map<number, ActiveSseStream>();
let nextStreamId = 1;
let overflowCount = 0;
let droppedEventCount = 0;
let droppedBytes = 0;

export interface SseDiagnosticsSnapshot {
	readonly activeStreams: number;
	readonly queuedBytes: number;
	readonly overflowCount: number;
	readonly droppedEventCount: number;
	readonly droppedBytes: number;
	readonly oldestStreamAgeMs: number;
}

export function getSseDiagnosticsSnapshot(now = Date.now()): SseDiagnosticsSnapshot {
	let queuedBytes = 0;
	let oldestStreamAgeMs = 0;
	for (const stream of activeStreams.values()) {
		queuedBytes += stream.queuedBytes();
		oldestStreamAgeMs = Math.max(oldestStreamAgeMs, Math.max(0, now - stream.openedAt));
	}
	return {
		activeStreams: activeStreams.size,
		queuedBytes,
		overflowCount,
		droppedEventCount,
		droppedBytes,
		oldestStreamAgeMs,
	};
}

function sseFrame(data: unknown, frame: SseFrameOptions = {}): Uint8Array {
	const eventLine = frame.event ? `event: ${frame.event.replace(/[\r\n]/g, "")}\n` : "";
	const idLine = frame.id === undefined ? "" : `id: ${String(frame.id).replace(/[\r\n]/g, "")}\n`;
	const value = typeof data === "string" ? data : (JSON.stringify(data) ?? "null");
	const dataLines = value
		.split(/\r\n|\r|\n/)
		.map((line) => `data: ${line}\n`)
		.join("");
	return encoder.encode(`${eventLine}${idLine}${dataLines}\n`);
}

function defaultHeaders(extra?: HeadersInit): Headers {
	const headers = new Headers({
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	if (extra) {
		for (const [name, value] of new Headers(extra)) headers.set(name, value);
	}
	return headers;
}

export function openBoundedSse(options: OpenBoundedSseOptions = {}): BoundedSseProducer {
	const highWaterMarkBytes = options.highWaterMarkBytes ?? SSE_DEFAULT_HIGH_WATER_MARK_BYTES;
	if (!Number.isSafeInteger(highWaterMarkBytes) || highWaterMarkBytes < 256) {
		throw new RangeError("SSE high-water mark must be an integer of at least 256 bytes");
	}
	const reservedBytes = Math.min(512, Math.max(128, Math.floor(highWaterMarkBytes / 8)));
	const maxFrameBytes =
		options.maxFrameBytes ?? Math.min(SSE_DEFAULT_MAX_FRAME_BYTES, highWaterMarkBytes - reservedBytes);
	if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > highWaterMarkBytes - reservedBytes) {
		throw new RangeError("SSE maximum frame size must fit below the byte high-water mark and terminal reserve");
	}
	if (options.heartbeat && (!Number.isSafeInteger(options.heartbeat.intervalMs) || options.heartbeat.intervalMs < 1)) {
		throw new RangeError("SSE heartbeat interval must be a positive integer");
	}

	const overflowPolicy = options.overflowPolicy ?? "close";
	const abortController = new AbortController();
	const disposers = new Set<() => void>();
	const drainListeners = new Set<(queuedBytes: number) => void>();
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let closed = false;
	let bodyClosed = false;
	let bodyCloseWhenDrained = false;
	let streamId: number | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let pendingDroppedEvents = 0;
	let pendingDroppedBytes = 0;
	let startInProgress = true;
	let requestAbortPending = false;

	const queuedBytes = (): number => {
		if (bodyClosed) return 0;
		const desiredSize = controller?.desiredSize;
		if (desiredSize === null || desiredSize === undefined) return 0;
		return Math.min(highWaterMarkBytes, Math.max(0, highWaterMarkBytes - desiredSize));
	};

	const dispose = (): void => {
		options.requestSignal?.removeEventListener("abort", onRequestAbort);
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
		const registered = [...disposers];
		disposers.clear();
		drainListeners.clear();
		for (let index = registered.length - 1; index >= 0; index -= 1) {
			try {
				registered[index]?.();
			} catch {}
		}
	};

	const closeBody = (error?: unknown): void => {
		if (bodyClosed) return;
		bodyClosed = true;
		if (streamId !== undefined) activeStreams.delete(streamId);
		try {
			if (error === undefined) controller?.close();
			else controller?.error(error);
		} catch {}
	};

	const finish = (reason: string, abortUpstream: boolean, error?: unknown): void => {
		if (closed) return;
		closed = true;
		dispose();
		if (abortUpstream && !abortController.signal.aborted) abortController.abort(reason);
		if (error !== undefined) closeBody(error);
		else if (queuedBytes() === 0 && pendingDroppedEvents === 0) closeBody();
		else bodyCloseWhenDrained = true;
	};

	const addDisposer = (disposeResource: () => void): (() => void) => {
		if (closed) {
			try {
				disposeResource();
			} catch {}
			return () => {};
		}
		disposers.add(disposeResource);
		return () => disposers.delete(disposeResource);
	};

	const writeBytes = (bytes: Uint8Array): SseWriteStatus => {
		if (closed) return "closed";
		const desiredSize = controller?.desiredSize;
		if (desiredSize === null || desiredSize === undefined) return "closed";
		if (bytes.byteLength > maxFrameBytes) return handleOverflow("frame_too_large", bytes.byteLength);
		if (bytes.byteLength > desiredSize - reservedBytes) return handleOverflow("queue_limit", bytes.byteLength);
		try {
			controller?.enqueue(bytes);
			return "accepted";
		} catch {
			return handleOverflow("queue_limit", bytes.byteLength);
		}
	};

	const writeFinalBytes = (bytes: Uint8Array): SseWriteStatus => {
		if (closed) return "closed";
		const desiredSize = controller?.desiredSize;
		if (desiredSize === null || desiredSize === undefined) return "closed";
		if (bytes.byteLength > maxFrameBytes) return handleOverflow("frame_too_large", bytes.byteLength);
		if (bytes.byteLength > desiredSize) return handleOverflow("queue_limit", bytes.byteLength);
		try {
			controller?.enqueue(bytes);
			return "accepted";
		} catch {
			return handleOverflow("queue_limit", bytes.byteLength);
		}
	};

	const writeDropSummary = (): void => {
		if (pendingDroppedEvents === 0 || bodyClosed) return;
		const frame = sseFrame({ count: pendingDroppedEvents, bytes: pendingDroppedBytes }, { event: "dropped" });
		const desiredSize = controller?.desiredSize;
		const reserve = closed ? 0 : reservedBytes;
		if (desiredSize === null || desiredSize === undefined || frame.byteLength > desiredSize - reserve) return;
		try {
			controller?.enqueue(frame);
			pendingDroppedEvents = 0;
			pendingDroppedBytes = 0;
		} catch {}
	};

	const handleOverflow = (reason: SseOverflowReason, byteLength: number): SseWriteStatus => {
		if (overflowPolicy === "drop") {
			pendingDroppedEvents += 1;
			pendingDroppedBytes += byteLength;
			droppedEventCount += 1;
			droppedBytes += byteLength;
			return "dropped";
		}
		overflowCount += 1;
		const payload = options.overflowEvent?.payload?.(reason) ?? { reason, highWaterMarkBytes };
		const frame = sseFrame(payload, { event: options.overflowEvent?.name ?? "overflow" });
		const desiredSize = controller?.desiredSize;
		if (desiredSize !== null && desiredSize !== undefined && frame.byteLength <= desiredSize) {
			try {
				controller?.enqueue(frame);
			} catch {}
		}
		finish("overflow", true);
		return "overflow";
	};

	const onRequestAbort = (): void => {
		if (startInProgress) {
			requestAbortPending = true;
			if (!abortController.signal.aborted) abortController.abort("request_aborted");
			return;
		}
		finish("request_aborted", true, new DOMException("Request aborted", "AbortError"));
	};
	let producer!: BoundedSseProducer;
	const stream = new ReadableStream<Uint8Array>(
		{
			start(streamController) {
				controller = streamController;
				streamId = nextStreamId++;
				activeStreams.set(streamId, { openedAt: Date.now(), queuedBytes });
				options.requestSignal?.addEventListener("abort", onRequestAbort, { once: true });
				if (options.requestSignal?.aborted) {
					requestAbortPending = true;
					abortController.abort("request_aborted");
				}
			},
			pull() {
				if (!closed) {
					if (overflowPolicy === "drop") writeDropSummary();
					for (const listener of drainListeners) {
						try {
							listener(queuedBytes());
						} catch {}
					}
				}
				if (closed && overflowPolicy === "drop" && bodyCloseWhenDrained) writeDropSummary();
				if (bodyCloseWhenDrained && queuedBytes() === 0 && pendingDroppedEvents === 0) closeBody();
			},
			cancel(reason) {
				if (closed) {
					closeBody();
					return;
				}
				finish(typeof reason === "string" ? reason : "consumer_cancelled", true);
				closeBody();
			},
		},
		{ highWaterMark: highWaterMarkBytes, size: (chunk?: Uint8Array) => chunk?.byteLength ?? 0 },
	);
	producer = {
		stream,
		response: new Response(stream, { headers: defaultHeaders(options.headers) }),
		signal: abortController.signal,
		get isClosed() {
			return closed;
		},
		get queuedBytes() {
			return queuedBytes();
		},
		write(data, frame = {}) {
			if (closed) return "closed";
			if (overflowPolicy === "drop") writeDropSummary();
			return writeBytes(sseFrame(data, frame));
		},
		writeFinal(data, frame = {}) {
			if (closed) return "closed";
			if (overflowPolicy === "drop") writeDropSummary();
			return writeFinalBytes(sseFrame(data, frame));
		},
		writeComment(comment) {
			if (closed) return "closed";
			const normalized = comment.replace(/[\r\n]/g, " ");
			return writeBytes(encoder.encode(`: ${normalized}\n\n`));
		},
		close() {
			if (overflowPolicy === "drop") writeDropSummary();
			finish("complete", false);
		},
		addDisposer,
		addDrainListener(listener) {
			if (closed) return () => {};
			drainListeners.add(listener);
			return () => drainListeners.delete(listener);
		},
	};
	const heartbeat = options.heartbeat;
	if (!closed && !requestAbortPending && heartbeat) {
		heartbeatTimer = setInterval(() => {
			if ("comment" in heartbeat) producer.writeComment(heartbeat.comment);
			else producer.write(heartbeat.data, { event: heartbeat.event });
		}, heartbeat.intervalMs);
		heartbeatTimer.unref?.();
	}
	if (!closed) {
		try {
			options.onStart?.(producer);
		} catch (error) {
			finish("producer_error", true, error);
		}
	}
	startInProgress = false;
	if (requestAbortPending && !closed) {
		finish("request_aborted", true, new DOMException("Request aborted", "AbortError"));
	}
	return producer;
}
