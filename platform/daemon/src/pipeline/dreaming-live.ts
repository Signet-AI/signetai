/**
 * Dreaming live event bus (#1601).
 *
 * In-daemon subscription backbone for attached live pass views. Each attached
 * pass owns a monotonic seq counter and a bounded replay buffer; live events are
 * stamped with their seq, buffered, and fanned out to subscribers without ever
 * blocking the pass executor (subscriber callbacks are isolated per call).
 *
 * The bus is ephemeral: buffered events are a bounded observation convenience,
 * never durable state. `dreaming_passes` / `dreaming_tool_calls` remain the
 * durable audit trail.
 */
import type { DreamingLiveEvent } from "@signet/core";

/** Wire frame: a normalized event with the seq assigned by the bus. */
export interface DreamingLiveFrame {
	readonly seq: number;
	readonly event: DreamingLiveEvent;
}

export interface DreamingLivePassStateInfo {
	readonly seq: number;
	/** Oldest seq still held in the replay buffer. */
	readonly oldest: number;
	readonly terminal: boolean;
	readonly subscribers: number;
}

export const DREAMING_LIVE_BUFFER_SIZE = 256;
const DREAMING_LIVE_MAX_SUBSCRIBERS = 32;
const DREAMING_LIVE_MAX_ATTACHED = 32;
/** Retention grace after a pass reaches a terminal state. */
const DREAMING_LIVE_PRUNE_GRACE_MS = 5 * 60 * 1000;

interface LivePassState {
	seq: number;
	oldest: number;
	frames: DreamingLiveFrame[];
	terminal: boolean;
	subscribers: Map<string, (frame: DreamingLiveFrame) => void>;
	/** Context observed from system_instructions events (verbose view). */
	instructions: string | null;
	modelLabel: string | null;
	pruneTimer: ReturnType<typeof setTimeout> | null;
	onPrune: (() => void)[];
}

function newPassState(): LivePassState {
	return {
		seq: 0,
		oldest: 1,
		frames: [],
		terminal: false,
		subscribers: new Map(),
		instructions: null,
		modelLabel: null,
		pruneTimer: null,
		onPrune: [],
	};
}

export class DreamingLiveBus {
	private readonly passes = new Map<string, LivePassState>();

	list(): readonly string[] {
		return [...this.passes.keys()];
	}

	/**
	 * Ensure state exists for a pass and register a prune notification.
	 * Returns the detach function (idempotent; safe to call repeatedly).
	 */
	attach(passId: string, onPrune: () => void = () => undefined): () => void {
		let state = this.passes.get(passId);
		if (!state) {
			if (this.passes.size >= DREAMING_LIVE_MAX_ATTACHED) {
				// Evict the oldest attached non-terminal pass so a fresh pass
				// always gets live coverage.
				for (const [id, candidate] of this.passes) {
					if (!candidate.terminal) {
						this.pruneNow(id);
						break;
					}
				}
			}
			state = newPassState();
			this.passes.set(passId, state);
		}
		state.onPrune.push(onPrune);
		return () => this.detach(passId, onPrune);
	}

	private detach(passId: string, onPrune: () => void): void {
		const state = this.passes.get(passId);
		if (!state) return;
		const idx = state.onPrune.indexOf(onPrune);
		if (idx >= 0) state.onPrune.splice(idx, 1);
	}

	subscribe(passId: string, subscriberId: string, callback: (frame: DreamingLiveFrame) => void): boolean {
		if (!this.passes.has(passId)) this.attach(passId);
		const state = this.passes.get(passId);
		if (!state || state.terminal) return false;
		if (state.subscribers.size >= DREAMING_LIVE_MAX_SUBSCRIBERS) return false;
		state.subscribers.set(subscriberId, callback);
		return true;
	}

	unsubscribe(passId: string, subscriberId: string): void {
		this.passes.get(passId)?.subscribers.delete(subscriberId);
	}

	states(passId: string): DreamingLivePassStateInfo | null {
		const state = this.passes.get(passId);
		if (!state) return null;
		return {
			seq: state.seq,
			oldest: state.oldest,
			terminal: state.terminal,
			subscribers: state.subscribers.size,
		};
	}

	replay(passId: string, sinceSeq: number): readonly DreamingLiveFrame[] {
		const state = this.passes.get(passId);
		if (!state) return [];
		const out: DreamingLiveFrame[] = [];
		for (const frame of state.frames) {
			if (frame.seq > sinceSeq) out.push(frame);
		}
		return out;
	}

	context(passId: string): { instructions: string | null; modelLabel: string | null } {
		const state = this.passes.get(passId);
		return {
			instructions: state?.instructions ?? null,
			modelLabel: state?.modelLabel ?? null,
		};
	}

	private schedulePrune(passId: string, state: LivePassState): void {
		if (state.pruneTimer) return;
		state.pruneTimer = setTimeout(() => {
			this.pruneNow(passId);
		}, DREAMING_LIVE_PRUNE_GRACE_MS);
		state.pruneTimer.unref?.();
	}

	/**
		 * Stamp and fan out one normalized event. Returns the assigned seq, or
		 * null when the pass is terminal. Unknown passes auto-attach on first
		 * emit so lifecycle observation can lead data-plane events. Never
		 * throws: subscriber callbacks are isolated per call so one misbehaving
		 * subscriber cannot wedge the executor or its siblings.
		 */
	emit(passId: string, event: DreamingLiveEvent): number | null {
		let state = this.passes.get(passId);
		if (!state) {
			state = newPassState();
			this.passes.set(passId, state);
		}
		if (state.terminal) return null;
		const seq = state.seq + 1;
		const frame: DreamingLiveFrame = { seq, event };
		state.seq = seq;

		if (event.type === "system_instructions") {
			state.instructions = event.instructions;
			if (typeof event.modelLabel === "string") state.modelLabel = event.modelLabel;
		}

		state.frames.push(frame);
		while (state.frames.length > DREAMING_LIVE_BUFFER_SIZE) {
			const evicted = state.frames.shift();
			if (evicted) state.oldest = evicted.seq + 1;
		}

		for (const callback of [...state.subscribers.values()]) {
			try {
				callback(frame);
			} catch {
				// Observation must never propagate into the pass executor.
			}
		}
		if (
			frame.event.type === "state_transition" &&
			(frame.event.state === "completed" ||
				frame.event.state === "failed" ||
				frame.event.state === "cancelled" ||
				frame.event.state === "timed_out")
		) {
			state.terminal = true;
			this.schedulePrune(passId, state);
		}
		return seq;
	}

	/** Mark a pass terminal and schedule bounded prune. */
	markTerminal(passId: string): void {
		const state = this.passes.get(passId);
		if (!state) return;
		state.terminal = true;
		this.schedulePrune(passId, state);
	}

	pruneNow(passId: string): void {
		const state = this.passes.get(passId);
		if (!state) return;
		if (state.pruneTimer) {
			clearTimeout(state.pruneTimer);
			state.pruneTimer = null;
		}
		for (const notify of [...state.onPrune]) {
			try {
				notify();
			} catch {
				// prune notifications are best-effort
			}
		}
		state.onPrune.length = 0;
		state.subscribers.clear();
		state.frames.length = 0;
		this.passes.delete(passId);
	}

	pruneAll(): void {
		for (const passId of [...this.passes.keys()]) {
			this.pruneNow(passId);
		}
	}
}

let busSingleton: DreamingLiveBus | null = null;

/** Process-wide live bus. Lazily created; shared by the worker and routes. */
export function getDreamingLiveBus(): DreamingLiveBus {
	if (!busSingleton) busSingleton = new DreamingLiveBus();
	return busSingleton;
}

/** Test seam: replace the singleton. */
export function setDreamingLiveBusForTests(bus: DreamingLiveBus | null): void {
	busSingleton = bus;
}
