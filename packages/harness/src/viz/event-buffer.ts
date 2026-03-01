/**
 * Fixed-size ring buffer for pipeline events.
 *
 * Both the SSE observer and the extension hook-bridge write into this.
 * The visualization layer reads from it.
 */

import type { PipelineEvent } from "./types.js";

export class EventBuffer {
	private readonly events: PipelineEvent[];
	private readonly capacity: number;
	private head = 0;
	private count = 0;
	private listeners: Array<(event: PipelineEvent) => void> = [];

	constructor(capacity = 200) {
		this.capacity = capacity;
		this.events = new Array(capacity);
	}

	push(event: PipelineEvent): void {
		this.events[this.head] = event;
		this.head = (this.head + 1) % this.capacity;
		if (this.count < this.capacity) this.count++;

		for (const listener of this.listeners) {
			listener(event);
		}
	}

	/** Get all buffered events in chronological order */
	getAll(): ReadonlyArray<PipelineEvent> {
		if (this.count === 0) return [];
		if (this.count < this.capacity) {
			return this.events.slice(0, this.count);
		}
		// Ring buffer wrapped — assemble in order
		return [
			...this.events.slice(this.head, this.capacity),
			...this.events.slice(0, this.head),
		];
	}

	/** Get the N most recent events */
	getRecent(n: number): ReadonlyArray<PipelineEvent> {
		const all = this.getAll();
		return all.slice(Math.max(0, all.length - n));
	}

	/** Subscribe to new events */
	onEvent(listener: (event: PipelineEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	get size(): number {
		return this.count;
	}

	clear(): void {
		this.head = 0;
		this.count = 0;
	}
}
