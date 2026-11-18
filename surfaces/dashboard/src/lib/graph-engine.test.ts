import { expect, test } from "bun:test";
import { createGraphEngine, type EngineOutput, type SimulationPort, type Surface } from "./graph-engine";

test("the engine runs only its own key actions, never inherited object members", () => {
	const context = new Proxy({}, { get: (_, key) => (key === "measureText" ? () => ({ width: 20 }) : () => {}) });
	const surface = () =>
		({ width: 1, height: 1, getContext: (type: string) => (type === "2d" ? context : null) }) as unknown as Surface;
	const simulation: SimulationPort = { postMessage() {}, onmessage: null };
	const outputs: EngineOutput[] = [];
	const engine = createGraphEngine(
		{ canvas: surface(), overlay: surface() },
		{ nodes: [{ id: "one", label: "One", kind: "entity", cluster: "one", weight: 1, metric: "" }], edges: [] },
		simulation,
		{ emit: (output) => outputs.push(output), frame: () => 1, cancel() {}, now: () => 0 },
	);
	try {
		for (const key of ["__proto__", "valueOf", "constructor", "toString", "hasOwnProperty"])
			expect(() => engine.input({ type: "key", key })).not.toThrow();
		expect(outputs.filter((output) => output.type !== "attribute" && output.type !== "keys")).toEqual([]);
		const keys = outputs.findLast((output) => output.type === "keys");
		expect(keys).toEqual({ type: "keys", keys: ["z", "c", "=", "+", "-", "_"] });
	} finally {
		engine.dispose();
	}
});
