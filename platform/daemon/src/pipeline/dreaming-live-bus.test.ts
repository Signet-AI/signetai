import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DREAMING_LIVE_BUFFER_SIZE, DreamingLiveBus } from "./dreaming-live";

const PASS_ID = "pass-live-1";

function deltaEvent(text: string) {
	return { type: "assistant_delta", passId: PASS_ID, text } as const;
}

function terminalEvent(state: string) {
	return { type: "state_transition", passId: PASS_ID, state } as const;
}

describe("dreaming live bus semantics (#1601)", () => {
	let bus: DreamingLiveBus;

	beforeEach(() => {
		bus = new DreamingLiveBus();
	});

	afterEach(() => {
		bus.pruneAll();
	});

	it("stamps seq on emits and fans out to subscribers", () => {
		const frames: { seq: number; event: unknown }[] = [];
		expect(bus.subscribe(PASS_ID, "obs-1", (frame) => frames.push(frame))).toBe(true);
		expect(bus.emit(PASS_ID, deltaEvent("a"))).toBe(1);
		expect(bus.emit(PASS_ID, deltaEvent("b"))).toBe(2);
		expect(frames).toEqual([
			{ seq: 1, event: { type: "assistant_delta", passId: PASS_ID, text: "a" } },
			{ seq: 2, event: { type: "assistant_delta", passId: PASS_ID, text: "b" } },
		]);
	});

	it("isolates a throwing subscriber from its siblings", () => {
		let received = 0;
		bus.subscribe(PASS_ID, "thrower", () => {
			throw new Error("subscriber fault");
		});
		bus.subscribe(PASS_ID, "healthy", () => {
			received += 1;
		});
		expect(() => bus.emit(PASS_ID, deltaEvent("a"))).not.toThrow();
		expect(received).toBe(1);
	});

	it("replays bounded history above the requested cursor", () => {
		bus.attach(PASS_ID);
		bus.emit(PASS_ID, deltaEvent("a"));
		bus.emit(PASS_ID, deltaEvent("b"));
		const frames = bus.replay(PASS_ID, 1);
		expect(frames.map((frame) => frame.seq)).toEqual([2]);
		expect(bus.replay(PASS_ID, 0).map((frame) => frame.seq)).toEqual([1, 2]);
	});

	it("bounds the replay ring and tracks the oldest held seq", () => {
		bus.attach(PASS_ID);
		for (let index = 1; index <= DREAMING_LIVE_BUFFER_SIZE + 1; index += 1) {
			bus.emit(PASS_ID, deltaEvent(`e-${index}`));
		}
		expect(bus.states(PASS_ID)?.oldest).toBe(2);
		expect(bus.replay(PASS_ID, 0).length).toBe(DREAMING_LIVE_BUFFER_SIZE);
	});

	it("rejects subscriptions past the per-pass subscriber bound", () => {
		bus.attach(PASS_ID);
		for (let index = 0; index < 32; index += 1) {
			expect(bus.subscribe(PASS_ID, `s-${index}`, () => undefined)).toBe(true);
		}
		expect(bus.subscribe(PASS_ID, "s-overflow", () => undefined)).toBe(false);
	});

	it("marks the pass terminal on a state transition and closes new subscriptions", () => {
		bus.attach(PASS_ID);
		const frames: number[] = [];
		expect(bus.subscribe(PASS_ID, "obs-1", (frame) => frames.push(frame.seq))).toBe(true);
		bus.emit(PASS_ID, deltaEvent("a"));
		bus.emit(PASS_ID, terminalEvent("completed"));
		expect(bus.states(PASS_ID)?.terminal).toBe(true);
		expect(bus.subscribe(PASS_ID, "late", () => undefined)).toBe(false);
		expect(bus.emit(PASS_ID, deltaEvent("b"))).toBeNull();
		expect(frames).toEqual([1, 2]);
	});

	it("evicts the oldest attached pass at the attach bound", () => {
		for (let index = 1; index <= 33; index += 1) {
			bus.attach(`pass-${index}`);
		}
		expect(bus.list().length).toBe(32);
		expect(bus.list().includes("pass-1")).toBe(false);
		expect(bus.states("pass-33")).not.toBeNull();
	});

	it("prunes state and replay history on pruneNow", () => {
		bus.attach(PASS_ID);
		bus.emit(PASS_ID, deltaEvent("a"));
		bus.pruneNow(PASS_ID);
		expect(bus.states(PASS_ID)).toBeNull();
		expect(bus.replay(PASS_ID, 0)).toEqual([]);
	});
});
