import { EventEmitter } from "node:events";
import type { ContextSnapshot, EventBusSubscription, SignetOSEvent } from "@signet/core";
import { logger } from "./logger.js";

const MAX_BUFFER_SIZE = 500;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const MAX_CONTEXT_EVENTS = 100;
const DEDUP_WINDOW_MS = 500;

type EventCallback = (event: SignetOSEvent) => void;

interface InternalSubscription {
	id: string;
	type: string;
	callback: EventCallback;
}

class SignetEventBus {
	private emitter = new EventEmitter();
	private buffer: SignetOSEvent[] = [];
	private subscriptions = new Map<string, InternalSubscription>();
	private subCounter = 0;
	private lastEventHash = new Map<string, number>();

	constructor() {
		this.emitter.setMaxListeners(200);
	}
	emit(event: SignetOSEvent): void {
		const dedupKey = `${event.type}:${event.source}`;
		const lastTs = this.lastEventHash.get(dedupKey);
		if (lastTs && event.timestamp - lastTs < DEDUP_WINDOW_MS) {
			return;
		}
		this.lastEventHash.set(dedupKey, event.timestamp);
		if (this.lastEventHash.size > 1000) {
			const cutoff = Date.now() - DEDUP_WINDOW_MS * 2;
			for (const [key, ts] of this.lastEventHash) {
				if (ts < cutoff) this.lastEventHash.delete(key);
			}
		}
		this.buffer.push(event);
		this.pruneBuffer();
		this.emitter.emit(event.type, event);
		this.emitter.emit("*", event);

		logger.debug("event-bus", `Event: ${event.type} from ${event.source}`, {
			eventId: event.id,
		});
	}
	subscribe(type: string, callback: EventCallback): EventBusSubscription {
		const id = `sub_${++this.subCounter}_${Date.now().toString(36)}`;
		const internal: InternalSubscription = { id, type, callback };
		this.subscriptions.set(id, internal);
		this.emitter.on(type, callback);

		return {
			type,
			id,
			unsubscribe: () => this.unsubscribeById(id),
		};
	}
	unsubscribe(type: string, callback: EventCallback): void {
		this.emitter.off(type, callback);
		for (const [id, sub] of this.subscriptions) {
			if (sub.type === type && sub.callback === callback) {
				this.subscriptions.delete(id);
				break;
			}
		}
	}
	getRecentEvents(opts?: { windowMs?: number; type?: string; limit?: number }): readonly SignetOSEvent[] {
		const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
		const limit = opts?.limit ?? MAX_BUFFER_SIZE;
		const cutoff = Date.now() - windowMs;

		let events = this.buffer.filter((e) => e.timestamp >= cutoff);

		if (opts?.type) {
			events = events.filter((e) => e.type === opts.type);
		}
		events.sort((a, b) => b.timestamp - a.timestamp);

		return events.slice(0, limit);
	}
	getContextSnapshot(): ContextSnapshot {
		const now = Date.now();
		const cutoff = now - DEFAULT_WINDOW_MS;
		const windowEvents = this.buffer.filter((e) => e.timestamp >= cutoff);
		const deduped = new Map<string, SignetOSEvent>();
		for (const event of windowEvents) {
			const key = `${event.type}:${event.source}:${JSON.stringify(event.payload)}`;
			const existing = deduped.get(key);
			if (!existing || event.timestamp > existing.timestamp) {
				deduped.set(key, event);
			}
		}
		const sorted = Array.from(deduped.values())
			.sort((a, b) => b.timestamp - a.timestamp)
			.slice(0, MAX_CONTEXT_EVENTS);
		const sources = new Set(sorted.map((e) => e.source));

		return {
			events: sorted,
			totalEvents: windowEvents.length,
			windowStart: sorted.length > 0 ? sorted[sorted.length - 1].timestamp : now,
			windowEnd: sorted.length > 0 ? sorted[0].timestamp : now,
			activeSources: sources.size,
			generatedAt: now,
		};
	}
	getStats(): {
		bufferSize: number;
		subscriptionCount: number;
		listenerCount: number;
	} {
		return {
			bufferSize: this.buffer.length,
			subscriptionCount: this.subscriptions.size,
			listenerCount: this.emitter.listenerCount("*"),
		};
	}
	reset(): void {
		this.buffer = [];
		this.lastEventHash.clear();
		for (const sub of this.subscriptions.values()) {
			this.emitter.off(sub.type, sub.callback);
		}
		this.subscriptions.clear();
		this.subCounter = 0;
	}

	private unsubscribeById(id: string): void {
		const sub = this.subscriptions.get(id);
		if (sub) {
			this.emitter.off(sub.type, sub.callback);
			this.subscriptions.delete(id);
		}
	}

	private pruneBuffer(): void {
		const cutoff = Date.now() - DEFAULT_WINDOW_MS;
		while (this.buffer.length > 0 && this.buffer[0].timestamp < cutoff) {
			this.buffer.shift();
		}
		while (this.buffer.length > MAX_BUFFER_SIZE) {
			this.buffer.shift();
		}
	}
}

export const eventBus = new SignetEventBus();
export function createEvent(source: string, type: string, payload: Record<string, unknown>): SignetOSEvent {
	return {
		id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		source,
		type,
		timestamp: Date.now(),
		payload,
	};
}
