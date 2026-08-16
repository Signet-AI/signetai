/**
 * Ephemeral live-event bridge for an in-flight Dreaming pass.
 *
 * The database remains the durable source of pass and tool-call audit data.
 * This module only keeps a small in-process replay window for read-only
 * observers. Event delivery is deliberately synchronous: a subscriber must
 * enqueue or drop its own notification and must never perform awaited work in
 * the Dreaming agent's event callback.
 */

export const DREAMING_LIVE_MAX_EVENTS = 256;
export const DREAMING_LIVE_MAX_SUBSCRIBERS = 16;
export const DREAMING_LIVE_MAX_PASSES = 32;
export const DREAMING_LIVE_MAX_EVENT_CHARS = 48_000;
export const DREAMING_LIVE_MAX_RAW_CHARS = 16_000;
export const DREAMING_LIVE_HEARTBEAT_MS = 15_000;
export const DREAMING_LIVE_TERMINAL_RETENTION_MS = 10 * 60_000;

export type DreamingLiveEventType =
	| "pass_started"
	| "session_info"
	| "agent_start"
	| "agent_end"
	| "turn_start"
	| "turn_end"
	| "message_start"
	| "message_update"
	| "message_end"
	| "assistant_delta"
	| "thinking_delta"
	| "tool_start"
	| "tool_progress"
	| "tool_end"
	| "tool_trace"
	| "lifecycle"
	| "pass_completed"
	| "pass_failed";

export interface DreamingLiveEvent {
	readonly passId: string;
	readonly agentId: string;
	readonly cursor: number;
	readonly timestamp: string;
	readonly type: DreamingLiveEventType;
	readonly data: Readonly<Record<string, unknown>>;
}

export interface DreamingLivePassInput {
	readonly passId: string;
	readonly agentId: string;
	readonly mode: string;
	readonly startedAt?: string;
}

export interface DreamingLivePassMetadata {
	readonly passId: string;
	readonly agentId: string;
	readonly mode: string;
	readonly status: string;
	readonly startedAt: string;
	readonly completedAt: string | null;
	readonly summary: string | null;
	readonly error: string | null;
}

export interface DreamingLivePassSnapshot extends DreamingLivePassMetadata {
	readonly cursor: number;
	readonly replayFrom: number | null;
	readonly replayTo: number | null;
}

export interface DreamingLiveGap {
	readonly requestedCursor: number;
	readonly availableFrom: number | null;
	readonly availableTo: number;
	readonly reason: "buffer_exhausted" | "cursor_ahead";
}

export interface DreamingLiveSubscription {
	readonly snapshot: DreamingLivePassSnapshot;
	readonly replay: readonly DreamingLiveEvent[];
	readonly gap: DreamingLiveGap | null;
	readonly unsubscribe: () => void;
}

export type DreamingLiveEventListener = (event: DreamingLiveEvent) => void;

interface LivePass {
	metadata: DreamingLivePassMetadata;
	nextCursor: number;
	events: DreamingLiveEvent[];
	subscribers: Set<DreamingLiveEventListener>;
	lastTouchedAt: number;
}

function nowIso(): string {
	return new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? { ...(value as Record<string, unknown>) }
		: {};
}

function safeJson(value: unknown): string {
	try {
		const json = JSON.stringify(value);
		return json === undefined ? "null" : json;
	} catch (error) {
		return JSON.stringify({ serializationError: error instanceof Error ? error.message : String(error) });
	}
}

function truncatedJsonValue(serialized: string, maxChars: number): Readonly<Record<string, unknown>> {
	const base = { truncated: true, originalChars: serialized.length };
	let preview = serialized.slice(0, Math.max(0, maxChars - safeJson(base).length - 16));
	let result = { ...base, preview };
	while (safeJson(result).length > maxChars && preview.length > 0) {
		preview = preview.slice(0, Math.max(0, preview.length - Math.max(1, Math.ceil(preview.length / 10))));
		result = { ...base, preview };
	}
	return result;
}

/** Bound a raw Pi object before it enters the replay buffer or SSE payload. */
export function boundDreamingLiveValue(value: unknown, maxChars = DREAMING_LIVE_MAX_RAW_CHARS): unknown {
	const json = safeJson(value);
	if (json.length <= maxChars) return value;
	return truncatedJsonValue(json, maxChars);
}

function boundString(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

function boundMetadataString(value: string, maxChars = 512): string {
	return boundString(value, maxChars);
}

function boundNullableMetadataString(value: string | null | undefined, maxChars: number): string | null {
	return value == null ? null : boundString(value, maxChars);
}

function boundEventData(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const data: Record<string, unknown> = {};
	for (const [key, rawValue] of Object.entries(value)) {
		if (key === "raw") {
			data[key] = boundDreamingLiveValue(rawValue, DREAMING_LIVE_MAX_RAW_CHARS);
		} else if (typeof rawValue === "string") {
			data[key] = boundString(rawValue, 12_000);
		} else {
			data[key] = boundDreamingLiveValue(rawValue, 12_000);
		}
	}

	const serialized = safeJson(data);
	if (serialized.length <= DREAMING_LIVE_MAX_EVENT_CHARS) return data;
	const compact: Record<string, unknown> = {};
	for (const [key, rawValue] of Object.entries(data)) {
		if (key === "raw") {
			compact[key] = boundDreamingLiveValue(rawValue, 4_000);
		} else if (typeof rawValue === "string") {
			compact[key] = boundString(rawValue, 2_000);
		} else {
			compact[key] = boundDreamingLiveValue(rawValue, 4_000);
		}
	}
	const compactSerialized = safeJson(compact);
	if (compactSerialized.length <= DREAMING_LIVE_MAX_EVENT_CHARS) return compact;
	return truncatedJsonValue(serialized, DREAMING_LIVE_MAX_EVENT_CHARS);
}

function metadataFromInput(input: DreamingLivePassInput): DreamingLivePassMetadata {
	return {
		passId: boundMetadataString(input.passId),
		agentId: boundMetadataString(input.agentId),
		mode: boundMetadataString(input.mode),
		status: "running",
		startedAt: boundMetadataString(input.startedAt ?? nowIso(), 128),
		completedAt: null,
		summary: null,
		error: null,
	};
}

function isTerminal(status: string): boolean {
	return status !== "running";
}

function isTerminalEvent(event: DreamingLiveEvent): boolean {
	return event.type === "pass_completed" || event.type === "pass_failed";
}

/** In-memory bounded event hub shared by the daemon's Dreaming worker/routes. */
export class DreamingLiveEventHub {
	private readonly passes = new Map<string, LivePass>();

	startPass(input: DreamingLivePassInput): void {
		this.prune();
		const existing = this.passes.get(input.passId);
		if (existing) {
			existing.metadata = {
				...existing.metadata,
				agentId: boundMetadataString(input.agentId),
				mode: boundMetadataString(input.mode),
				startedAt: boundMetadataString(input.startedAt ?? existing.metadata.startedAt, 128),
			};
			existing.lastTouchedAt = Date.now();
			return;
		}
		// Live observation is optional. If every retained pass is actively
		// viewed, decline this in-process registration rather than growing the
		// map or displacing another operator's stream.
		if (this.passes.size >= DREAMING_LIVE_MAX_PASSES) return;

		const pass: LivePass = {
			metadata: metadataFromInput(input),
			nextCursor: 1,
			events: [],
			subscribers: new Set(),
			lastTouchedAt: Date.now(),
		};
		this.passes.set(input.passId, pass);
		this.append(pass, "pass_started", {
			agentId: input.agentId,
			mode: input.mode,
			startedAt: pass.metadata.startedAt,
		});
	}

	/** Create route visibility for a pass recovered from the durable database. */
	ensurePass(
		input: DreamingLivePassInput & Partial<Omit<DreamingLivePassMetadata, keyof DreamingLivePassInput>>,
	): void {
		const existing = this.passes.get(input.passId);
		if (!existing) {
			this.startPass(input);
			const created = this.passes.get(input.passId);
			if (created) {
				created.metadata = {
					...created.metadata,
					status: boundMetadataString(input.status ?? created.metadata.status),
					completedAt: boundNullableMetadataString(input.completedAt ?? created.metadata.completedAt, 128),
					summary: boundNullableMetadataString(input.summary ?? created.metadata.summary, 12_000),
					error: boundNullableMetadataString(input.error ?? created.metadata.error, 12_000),
				};
				this.appendRecoveredTerminal(created);
			}
			return;
		}
		// A route lookup can observe the durable row just before the worker
		// publishes its terminal event. Never let that stale running row reopen
		// an already-finished in-memory pass on reconnect.
		if (isTerminal(existing.metadata.status) && (input.status === undefined || input.status === "running")) {
			existing.lastTouchedAt = Date.now();
			return;
		}
		existing.metadata = {
			...existing.metadata,
			status: boundMetadataString(input.status ?? existing.metadata.status),
			completedAt: boundNullableMetadataString(input.completedAt ?? existing.metadata.completedAt, 128),
			summary: boundNullableMetadataString(input.summary ?? existing.metadata.summary, 12_000),
			error: boundNullableMetadataString(input.error ?? existing.metadata.error, 12_000),
		};
		existing.lastTouchedAt = Date.now();
		this.appendRecoveredTerminal(existing);
	}

	publish(passId: string, type: DreamingLiveEventType, data: Readonly<Record<string, unknown>> = {}): void {
		const pass = this.passes.get(passId);
		if (!pass || (isTerminal(pass.metadata.status) && type !== "pass_completed" && type !== "pass_failed")) return;
		this.append(pass, type, data);
	}

	finish(
		passId: string,
		status: "completed" | "failed" | "cancelled",
		data: { readonly summary?: string | null; readonly error?: string | null; readonly [key: string]: unknown } = {},
	): void {
		const pass = this.passes.get(passId);
		if (!pass) return;
		if (isTerminal(pass.metadata.status)) return;
		const completedAt = nowIso();
		const summary = typeof data.summary === "string" ? boundString(data.summary, 12_000) : null;
		const error = typeof data.error === "string" ? boundString(data.error, 12_000) : null;
		pass.metadata = { ...pass.metadata, status, completedAt, summary, error };
		this.append(pass, status === "completed" ? "pass_completed" : "pass_failed", {
			...data,
			status,
			completedAt,
			...(summary === null ? {} : { summary }),
			...(error === null ? {} : { error }),
		});
	}

	getSnapshot(passId: string): DreamingLivePassSnapshot | null {
		const pass = this.passes.get(passId);
		if (!pass) return null;
		return this.snapshot(pass);
	}

	subscribe(
		passId: string,
		afterCursor: number | null,
		listener: DreamingLiveEventListener,
	): DreamingLiveSubscription | null {
		const pass = this.passes.get(passId);
		if (!pass) return null;
		if (pass.subscribers.size >= DREAMING_LIVE_MAX_SUBSCRIBERS) {
			throw new Error("Too many viewers are attached to this Dreaming pass");
		}

		pass.subscribers.add(listener);
		pass.lastTouchedAt = Date.now();
		const requested = afterCursor ?? 0;
		const latest = pass.nextCursor - 1;
		const first = pass.events[0]?.cursor ?? null;
		let gap: DreamingLiveGap | null = null;
		if (requested > latest) {
			gap = {
				requestedCursor: requested,
				availableFrom: first,
				availableTo: latest,
				reason: "cursor_ahead",
			};
		} else if (first !== null && requested < first - 1) {
			gap = {
				requestedCursor: requested,
				availableFrom: first,
				availableTo: latest,
				reason: "buffer_exhausted",
			};
		}
		const replay = pass.events.filter((event) => event.cursor > requested);
		let subscribed = true;
		return {
			snapshot: this.snapshot(pass),
			replay,
			gap,
			unsubscribe: () => {
				if (!subscribed) return;
				subscribed = false;
				pass.subscribers.delete(listener);
				pass.lastTouchedAt = Date.now();
			},
		};
	}

	getSubscriberCount(passId?: string): number {
		if (passId === undefined)
			return [...this.passes.values()].reduce((total, pass) => total + pass.subscribers.size, 0);
		return this.passes.get(passId)?.subscribers.size ?? 0;
	}

	reset(): void {
		this.passes.clear();
	}

	private append(pass: LivePass, type: DreamingLiveEventType, input: Readonly<Record<string, unknown>>): void {
		const event: DreamingLiveEvent = {
			passId: pass.metadata.passId,
			agentId: pass.metadata.agentId,
			cursor: pass.nextCursor++,
			timestamp: nowIso(),
			type,
			data: boundEventData(asRecord(input)),
		};
		pass.events.push(event);
		if (pass.events.length > DREAMING_LIVE_MAX_EVENTS)
			pass.events.splice(0, pass.events.length - DREAMING_LIVE_MAX_EVENTS);
		pass.lastTouchedAt = Date.now();
		for (const listener of [...pass.subscribers]) {
			try {
				listener(event);
			} catch {
				// A disconnected or malformed viewer must not affect Dreaming.
			}
		}
	}

	private snapshot(pass: LivePass): DreamingLivePassSnapshot {
		return {
			...pass.metadata,
			cursor: pass.nextCursor - 1,
			replayFrom: pass.events[0]?.cursor ?? null,
			replayTo: pass.events.at(-1)?.cursor ?? null,
		};
	}

	private appendRecoveredTerminal(pass: LivePass): void {
		if (!isTerminal(pass.metadata.status) || pass.events.some((event) => isTerminalEvent(event))) return;
		this.append(pass, pass.metadata.status === "completed" ? "pass_completed" : "pass_failed", {
			status: pass.metadata.status,
			completedAt: pass.metadata.completedAt,
			...(pass.metadata.summary === null ? {} : { summary: pass.metadata.summary }),
			...(pass.metadata.error === null ? {} : { error: pass.metadata.error }),
		});
	}

	private prune(): void {
		const cutoff = Date.now() - DREAMING_LIVE_TERMINAL_RETENTION_MS;
		for (const [passId, pass] of this.passes) {
			if (pass.subscribers.size === 0 && isTerminal(pass.metadata.status) && pass.lastTouchedAt < cutoff) {
				this.passes.delete(passId);
			}
		}
		if (this.passes.size < DREAMING_LIVE_MAX_PASSES) return;
		const candidates = [...this.passes.entries()]
			.filter(([, pass]) => pass.subscribers.size === 0)
			.sort(([, left], [, right]) => {
				const leftTerminal = isTerminal(left.metadata.status) ? 0 : 1;
				const rightTerminal = isTerminal(right.metadata.status) ? 0 : 1;
				return leftTerminal - rightTerminal || left.lastTouchedAt - right.lastTouchedAt;
			});
		for (const [passId] of candidates) {
			if (this.passes.size < DREAMING_LIVE_MAX_PASSES) break;
			this.passes.delete(passId);
		}
	}
}

export const dreamingLiveEvents = new DreamingLiveEventHub();

function textFromContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value))
		return value
			.map((item) => textFromContent(item))
			.filter(Boolean)
			.join("");
	if (typeof value !== "object" || value === null) return "";
	const record = value as Record<string, unknown>;
	if (typeof record.text === "string") return record.text;
	if (typeof record.content === "string") return record.content;
	return textFromContent(record.content);
}

function rawEventData(event: Record<string, unknown>): Record<string, unknown> {
	return { raw: boundDreamingLiveValue(event) };
}

/** Translate Pi AgentSession events into the stable remote Dreaming event model. */
export function publishDreamingAgentEvent(passId: string, input: unknown, hub = dreamingLiveEvents): void {
	const event = asRecord(input);
	const type = typeof event.type === "string" ? event.type : "unknown";
	const raw = rawEventData(event);
	switch (type) {
		case "message_update": {
			const assistantEvent = asRecord(event.assistantMessageEvent);
			if (assistantEvent.type === "text_delta") {
				hub.publish(passId, "assistant_delta", { delta: assistantEvent.delta ?? "", ...raw });
				return;
			}
			if (assistantEvent.type === "thinking_delta") {
				hub.publish(passId, "thinking_delta", { delta: assistantEvent.delta ?? "", ...raw });
				return;
			}
			hub.publish(passId, "message_update", { eventType: assistantEvent.type ?? "unknown", ...raw });
			return;
		}
		case "tool_execution_start":
			hub.publish(passId, "tool_start", {
				toolCallId: event.toolCallId ?? null,
				toolName: event.toolName ?? "unknown",
				...raw,
			});
			return;
		case "tool_execution_update":
			hub.publish(passId, "tool_progress", {
				toolCallId: event.toolCallId ?? null,
				toolName: event.toolName ?? "unknown",
				...raw,
			});
			return;
		case "tool_execution_end":
			hub.publish(passId, "tool_end", {
				toolCallId: event.toolCallId ?? null,
				toolName: event.toolName ?? "unknown",
				success: event.isError !== true,
				...raw,
			});
			return;
		case "agent_start":
			hub.publish(passId, "agent_start", raw);
			return;
		case "agent_end":
			hub.publish(passId, "agent_end", raw);
			return;
		case "turn_start":
			hub.publish(passId, "turn_start", raw);
			return;
		case "turn_end":
			hub.publish(passId, "turn_end", raw);
			return;
		case "message_start":
		case "message_end": {
			const message = asRecord(event.message);
			const role = typeof message.role === "string" ? message.role : "unknown";
			const text = textFromContent(message.content);
			const data = { role, ...(role === "assistant" && text ? { text } : {}), ...raw };
			hub.publish(passId, type, data);
			return;
		}
		default:
			hub.publish(passId, "lifecycle", { eventType: type, ...raw });
	}
}

export function publishDreamingSessionInfo(
	passId: string,
	info: { readonly sessionId?: string; readonly model?: string; readonly systemPrompt?: string },
	hub = dreamingLiveEvents,
): void {
	hub.publish(passId, "session_info", {
		...(info.sessionId ? { sessionId: info.sessionId } : {}),
		...(info.model ? { model: info.model } : {}),
		// The prompt is intentionally present only in the opt-in raw channel.
		raw: boundDreamingLiveValue({ systemPrompt: info.systemPrompt ?? "" }),
	});
}

export function publishDreamingToolTrace(
	passId: string,
	trace: { readonly toolCallId: string; readonly tool: string; readonly output: unknown; readonly latencyMs: number },
	hub = dreamingLiveEvents,
): void {
	hub.publish(passId, "tool_trace", {
		toolCallId: trace.toolCallId,
		toolName: trace.tool,
		success: asRecord(trace.output).ok === true,
		latencyMs: Math.max(0, Math.floor(trace.latencyMs)),
		raw: boundDreamingLiveValue(trace),
	});
}
