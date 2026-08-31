import {
	Key,
	ProcessTerminal,
	TuiMainScreen,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { DaemonStreamResult } from "./daemon.js";

const MAX_VIEW_LINE_CHARS = 16_000;

export interface DreamingAttachSnapshot {
	readonly passId: string;
	readonly agentId: string;
	readonly mode: string;
	readonly status: string;
	readonly startedAt: string;
	readonly completedAt: string | null;
	readonly summary: string | null;
	readonly error: string | null;
	readonly cursor: number;
	readonly replayFrom: number | null;
	readonly replayTo: number | null;
}

export interface DreamingAttachEvent {
	readonly passId: string;
	readonly agentId: string;
	readonly cursor: number;
	readonly timestamp: string;
	readonly type: string;
	readonly data: Readonly<Record<string, unknown>>;
}

export interface DreamingAttachGap {
	readonly requestedCursor: number;
	readonly availableFrom: number | null;
	readonly availableTo: number;
	readonly reason: string;
}

export interface DreamingAttachEnvelope {
	readonly type?: string;
	readonly passId?: string;
	readonly agentId?: string;
	readonly cursor?: number;
	readonly timestamp?: string;
	readonly data?: Readonly<Record<string, unknown>>;
	readonly snapshot?: DreamingAttachSnapshot;
	readonly event?: DreamingAttachEvent;
	readonly gap?: DreamingAttachGap;
}

export interface ParsedSseEvent {
	readonly event: string;
	readonly id: string | null;
	readonly data: string;
}

export function parseSseEventBlock(block: string): ParsedSseEvent | null {
	let event = "message";
	let id: string | null = null;
	const data: string[] = [];
	for (const rawLine of block.replace(/\r/g, "").split("\n")) {
		if (rawLine.startsWith(":")) continue;
		const separator = rawLine.indexOf(":");
		const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
		let value = separator === -1 ? "" : rawLine.slice(separator + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") event = value;
		else if (field === "id") id = value;
		else if (field === "data") data.push(value);
	}
	if (data.length === 0) return null;
	return { event, id, data: data.join("\n") };
}

export function parseDreamingAttachEnvelope(record: ParsedSseEvent): DreamingAttachEnvelope | null {
	try {
		const parsed: unknown = JSON.parse(record.data);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return parsed as DreamingAttachEnvelope;
	} catch {
		return null;
	}
}

function eventFromEnvelope(envelope: DreamingAttachEnvelope, sseEventName: string): DreamingAttachEvent | undefined {
	if (envelope.event) return envelope.event;
	if (
		sseEventName !== "snapshot" &&
		sseEventName !== "gap" &&
		sseEventName !== "error" &&
		typeof envelope.passId === "string" &&
		typeof envelope.agentId === "string" &&
		typeof envelope.cursor === "number" &&
		typeof envelope.timestamp === "string" &&
		envelope.data !== undefined
	) {
		return envelope as DreamingAttachEvent;
	}
	return undefined;
}

function textValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function eventData(event: DreamingAttachEvent, key: string): unknown {
	return event.data[key];
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "null";
	} catch {
		return "[unserializable]";
	}
}

function wrappedLines(value: string, width: number): string[] {
	return value.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
}

function formatTimestamp(value: string): string {
	const timestamp = Date.parse(value.replace(" ", "T") + (value.includes("Z") ? "" : "Z"));
	if (!Number.isFinite(timestamp)) return value;
	return new Date(timestamp).toLocaleTimeString();
}

function formatElapsed(startedAt: string): string {
	const timestamp = Date.parse(startedAt.replace(" ", "T") + (startedAt.includes("Z") ? "" : "Z"));
	if (!Number.isFinite(timestamp)) return "?";
	const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
	const hours = Math.floor(elapsedSeconds / 3_600);
	const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
	const seconds = elapsedSeconds % 60;
	return hours > 0
		? `${hours}h${String(minutes).padStart(2, "0")}m`
		: `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/** Read-only Pi TUI component used by dream attach. It intentionally has no editor/input child. */
export class DreamingAttachView implements Component {
	private snapshot: DreamingAttachSnapshot | undefined;
	private readonly events: DreamingAttachEvent[] = [];
	private readonly lines: string[] = [];
	private verbose = false;
	private lastCursor = 0;
	private snapshotCursor = 0;
	private phase = "connecting";
	private model: string | undefined;
	private modeChangeHandler: (verbose: boolean) => void;

	constructor(
		private readonly onDetach: () => void,
		private readonly onChange: () => void = () => {},
		onModeChange: (verbose: boolean) => void = () => {},
	) {
		this.modeChangeHandler = onModeChange;
	}

	setModeChangeHandler(handler: (verbose: boolean) => void): void {
		this.modeChangeHandler = handler;
	}

	get isVerbose(): boolean {
		return this.verbose;
	}

	get cursor(): number {
		return this.lastCursor;
	}

	applySnapshot(snapshot: DreamingAttachSnapshot): void {
		this.snapshot = snapshot;
		this.snapshotCursor = Math.max(this.snapshotCursor, snapshot.cursor);
		this.phase = snapshot.status;
		this.addLine(`Connected to pass ${snapshot.passId} (${snapshot.agentId}, ${snapshot.mode})`);
		if (snapshot.status !== "running") {
			this.addLine(`Pass is already ${snapshot.status}.`);
			if (snapshot.summary) this.addLine(`Summary: ${snapshot.summary}`);
			if (snapshot.error) this.addLine(`Error: ${snapshot.error}`);
		}
		this.invalidateAndRender();
	}

	applyGap(gap: DreamingAttachGap): void {
		this.addLine(
			`Replay gap (${gap.reason}): cursor ${gap.requestedCursor} is not fully available; showing a fresh snapshot and live events.`,
		);
		this.invalidateAndRender();
	}

	applyEvent(event: DreamingAttachEvent): void {
		this.lastCursor = Math.max(this.lastCursor, event.cursor);
		this.events.push(event);
		if (this.events.length > 160) this.events.splice(0, this.events.length - 160);

		const type = event.type;
		if (type === "assistant_delta") {
			this.phase = "assistant";
			const delta = textValue(eventData(event, "delta")) ?? "";
			if (delta) {
				const previous = this.lines.at(-1);
				if (previous?.startsWith("assistant: "))
					this.lines[this.lines.length - 1] = `${previous}${delta}`.slice(0, MAX_VIEW_LINE_CHARS);
				else this.addLine(`assistant: ${delta}`);
			}
		} else if (type === "thinking_delta") {
			this.phase = "reasoning";
			if (this.verbose) this.addLine(`reasoning: ${textValue(eventData(event, "delta")) ?? ""}`);
		} else if (type === "tool_start") {
			const tool = textValue(eventData(event, "toolName")) ?? "unknown";
			this.phase = `tool:${tool}`;
			this.addLine(`tool ${tool} started`);
		} else if (type === "tool_progress") {
			if (this.verbose) this.addLine(`tool progress: ${safeJson(event.data)}`);
		} else if (type === "tool_end") {
			const tool = textValue(eventData(event, "toolName")) ?? "unknown";
			const success = eventData(event, "success") === true;
			this.phase = "running";
			this.addLine(`tool ${tool} ${success ? "completed" : "failed"}`);
		} else if (type === "tool_trace") {
			const tool = textValue(eventData(event, "toolName")) ?? "unknown";
			const success = eventData(event, "success") === true;
			this.addLine(`tool ${tool} trace ${success ? "ok" : "failed"}`);
		} else if (type === "session_info") {
			this.model = textValue(eventData(event, "model"));
			this.addLine(`Pi session ready${this.model ? ` (${this.model})` : ""}`);
		} else if (type === "lifecycle") {
			this.phase = textValue(eventData(event, "phase")) ?? type;
		} else if (type === "pass_completed" || type === "pass_failed") {
			const status = textValue(eventData(event, "status")) ?? (type === "pass_completed" ? "completed" : "failed");
			this.phase = status;
			this.addLine(`Dreaming pass ${status}`);
			const summary = textValue(eventData(event, "summary")) ?? "";
			const error = textValue(eventData(event, "error")) ?? "";
			if (summary) this.addLine(`Summary: ${summary}`);
			if (error) this.addLine(`Error: ${error}`);
		} else if (type === "gap") {
			this.addLine("The stream reported a replay gap; the snapshot is authoritative.");
		} else if (type !== "message_update") {
			this.addLine(type.replaceAll("_", " "));
		}
		this.invalidateAndRender();
	}

	applyMalformedEvent(): void {
		this.addLine("Received a malformed live event; continuing with the next event.");
		this.invalidateAndRender();
	}

	addConnectionMessage(message: string): void {
		this.addLine(message);
		this.invalidateAndRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.onDetach();
			return;
		}
		if (matchesKey(data, Key.ctrl("v"))) {
			this.verbose = !this.verbose;
			this.modeChangeHandler(this.verbose);
			this.addLine(this.verbose ? "Verbose raw mode enabled" : "Concise mode enabled");
			this.invalidateAndRender();
			return;
		}
		// All other input is intentionally ignored: this is not a chat/editor UI.
	}

	render(width: number): string[] {
		const snapshot = this.snapshot;
		const header = snapshot
			? `Dreaming attach ${this.verbose ? "[RAW VERBOSE]" : "[concise]"} | pass ${snapshot.passId} | agent ${snapshot.agentId} | model ${this.model ?? "pending"} | mode ${snapshot.mode} | phase ${this.phase} | elapsed ${formatElapsed(snapshot.startedAt)} | cursor ${Math.max(this.lastCursor, this.snapshotCursor)}`
			: "Dreaming attach [connecting]";
		const help = "Ctrl+V toggle raw verbose • Ctrl+C detach (the pass keeps running)";
		const source = this.verbose
			? this.events
					.slice(-80)
					.map((event) => `${formatTimestamp(event.timestamp)} ${event.type}: ${safeJson(event.data)}`)
			: this.lines.slice(-80);
		const output = [header, help, "", ...source];
		return output.flatMap((line) => wrappedLines(truncateToWidth(line, Math.max(1, width), "…"), width));
	}

	invalidate(): void {}

	private invalidateAndRender(): void {
		this.onChange();
	}

	private addLine(line: string): void {
		this.lines.push(line.slice(0, MAX_VIEW_LINE_CHARS));
		if (this.lines.length > 160) this.lines.splice(0, this.lines.length - 160);
	}
}

export interface FollowDreamingPassOptions {
	readonly passId: string;
	readonly fetchStream: (path: string, opts?: RequestInit & { timeout?: number }) => Promise<DaemonStreamResult>;
	readonly view: DreamingAttachView;
	readonly signal: AbortSignal;
	readonly maxReconnects?: number;
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		const abort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener("abort", abort, { once: true });
		setTimeout(() => signal.removeEventListener("abort", abort), ms + 1);
	});
}

export async function readSseStream(
	body: ReadableStream<Uint8Array>,
	onEvent: (event: ParsedSseEvent) => void,
	signal: AbortSignal,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const cancelOnAbort = (): void => {
		void reader.cancel().catch(() => undefined);
	};
	if (signal.aborted) cancelOnAbort();
	else signal.addEventListener("abort", cancelOnAbort, { once: true });
	const consume = (flush: boolean): void => {
		buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		let boundary = buffer.indexOf("\n\n");
		while (boundary !== -1) {
			const block = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			const event = parseSseEventBlock(block);
			if (event) onEvent(event);
			boundary = buffer.indexOf("\n\n");
		}
		if (flush && buffer.trim()) {
			const event = parseSseEventBlock(buffer);
			if (event) onEvent(event);
			buffer = "";
		}
	};
	try {
		while (!signal.aborted) {
			const result = await reader.read();
			if (result.done) break;
			buffer += decoder.decode(result.value, { stream: true });
			consume(false);
		}
		buffer += decoder.decode();
		consume(true);
	} finally {
		signal.removeEventListener("abort", cancelOnAbort);
		try {
			await reader.cancel();
		} catch {
			// The daemon may already have closed the response.
		}
		reader.releaseLock();
	}
}

export class DreamingAttachError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DreamingAttachError";
	}
}

export async function followDreamingPass(options: FollowDreamingPassOptions): Promise<boolean> {
	const maxReconnects = options.maxReconnects ?? 5;
	const sleep = options.sleep ?? waitFor;
	let cursor = options.view.cursor;
	let reconnects = 0;
	let terminal = false;
	let connectionAbort: AbortController | undefined;
	options.view.setModeChangeHandler(() => connectionAbort?.abort());
	try {
		while (!options.signal.aborted && !terminal) {
			const currentConnection = new AbortController();
			connectionAbort = currentConnection;
			const relayAbort = () => currentConnection.abort();
			options.signal.addEventListener("abort", relayAbort, { once: true });
			const query = new URLSearchParams();
			if (cursor > 0) query.set("after", String(cursor));
			if (options.view.isVerbose) query.set("verbose", "1");
			const queryString = query.toString();
			const path = `/api/dream/passes/${encodeURIComponent(options.passId)}/events${queryString ? `?${queryString}` : ""}`;
			let result: DaemonStreamResult;
			try {
				result = await options.fetchStream(path, {
					signal: currentConnection.signal,
					headers: { Accept: "text/event-stream" },
				});
			} catch (error) {
				options.signal.removeEventListener("abort", relayAbort);
				if (connectionAbort === currentConnection) connectionAbort = undefined;
				if (options.signal.aborted) break;
				if (reconnects >= maxReconnects) {
					throw new DreamingAttachError(error instanceof Error ? error.message : String(error));
				}
				reconnects++;
				options.view.addConnectionMessage(`Live stream error; reconnecting (${reconnects}/${maxReconnects})...`);
				await sleep(Math.min(4_000, 250 * 2 ** (reconnects - 1)), options.signal);
				continue;
			}
			if (!result.ok) {
				options.signal.removeEventListener("abort", relayAbort);
				if (connectionAbort === currentConnection) connectionAbort = undefined;
				if (options.signal.aborted) break;
				if (reconnects >= maxReconnects) throw new DreamingAttachError(result.error ?? "Dreaming live stream failed");
				reconnects++;
				options.view.addConnectionMessage(`Live stream disconnected; reconnecting (${reconnects}/${maxReconnects})...`);
				await sleep(Math.min(4_000, 250 * 2 ** (reconnects - 1)), options.signal);
				continue;
			}
			if (!result.response.body) {
				options.signal.removeEventListener("abort", relayAbort);
				if (connectionAbort === currentConnection) connectionAbort = undefined;
				throw new DreamingAttachError("Dreaming live stream returned no body");
			}

			let streamError: unknown;
			try {
				await readSseStream(
					result.response.body,
					(record) => {
						const envelope = parseDreamingAttachEnvelope(record);
						if (!envelope) {
							options.view.applyMalformedEvent();
							return;
						}
						if (envelope.snapshot) {
							options.view.applySnapshot(envelope.snapshot);
							if (envelope.snapshot.status !== "running") terminal = true;
						}
						if (envelope.gap) options.view.applyGap(envelope.gap);
						const event = eventFromEnvelope(envelope, record.event);
						if (event) {
							options.view.applyEvent(event);
							if (event.type === "pass_completed" || event.type === "pass_failed") terminal = true;
						}
						const parsedCursor = record.id === null ? 0 : Number.parseInt(record.id, 10);
						if (Number.isSafeInteger(parsedCursor) && parsedCursor > cursor) cursor = parsedCursor;
					},
					currentConnection.signal,
				);
			} catch (error) {
				streamError = error;
			}
			options.signal.removeEventListener("abort", relayAbort);
			if (connectionAbort === currentConnection) connectionAbort = undefined;
			if (options.signal.aborted || terminal) break;
			if (reconnects >= maxReconnects) {
				throw new DreamingAttachError(
					streamError instanceof Error ? streamError.message : "Dreaming live stream ended unexpectedly",
				);
			}
			reconnects++;
			const modeChanged = currentConnection.signal.aborted;
			options.view.addConnectionMessage(
				modeChanged
					? `Switching to ${options.view.isVerbose ? "raw verbose" : "concise"} mode...`
					: streamError
						? `Live stream error; reconnecting (${reconnects}/${maxReconnects})...`
						: `Live stream ended; reconnecting (${reconnects}/${maxReconnects})...`,
			);
			await sleep(Math.min(4_000, 250 * 2 ** (reconnects - 1)), options.signal);
		}
	} finally {
		options.view.setModeChangeHandler(() => {});
		connectionAbort?.abort();
	}
	return terminal;
}

export function createDreamingAttachTui(view: DreamingAttachView): {
	readonly tui: TUI;
	readonly terminal: ProcessTerminal;
} {
	const terminal = new ProcessTerminal();
	const tui = new TuiMainScreen(terminal);
	tui.addChild(view);
	tui.setFocus(view);
	return { tui, terminal };
}
