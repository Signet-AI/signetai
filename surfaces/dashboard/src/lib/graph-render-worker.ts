import { createGraphEngine, type EngineInput, type EngineOutput, type GraphEngine } from "./graph-engine";
import type { GraphSceneData } from "./graph-scene";

export interface FontSource {
	readonly family: string;
	readonly source: string;
	readonly descriptors: FontFaceDescriptors;
}

export type RenderWorkerRequest =
	| {
			type: "init";
			canvas: OffscreenCanvas;
			overlay: OffscreenCanvas;
			simulation: MessagePort;
			data: GraphSceneData;
			layoutScope?: string;
			fonts: readonly FontSource[];
			timeOrigin: number;
			setup: readonly EngineInput[];
	  }
	| { type: "input"; input: EngineInput };

interface WorkerScope {
	postMessage(message: EngineOutput): void;
	onmessage: ((event: MessageEvent<RenderWorkerRequest>) => void) | null;
	requestAnimationFrame?: (callback: (now: number) => void) => number;
	cancelAnimationFrame?: (frame: number) => void;
	fonts?: FontFaceSet;
}

const scope = self as unknown as WorkerScope;
let engine: GraphEngine | undefined;
let shift = 0;

const frame = (callback: (now: number) => void) =>
	scope.requestAnimationFrame
		? scope.requestAnimationFrame(callback)
		: (setTimeout(() => callback(performance.now()), 16) as unknown as number);
const cancel = (id: number) => {
	if (scope.cancelAnimationFrame) scope.cancelAnimationFrame(id);
	else clearTimeout(id);
};

scope.onmessage = (event) => {
	const message = event.data;
	if (message.type === "input") {
		const input = message.input;
		engine?.input(input.type === "pointer" ? { ...input, t: input.t + shift } : input);
		return;
	}
	shift = message.timeOrigin - performance.timeOrigin;
	const loads = message.fonts.map((font) => {
		const face = new FontFace(font.family, font.source, font.descriptors);
		scope.fonts?.add(face);
		return face.load();
	});
	engine = createGraphEngine(
		{ canvas: message.canvas, overlay: message.overlay },
		message.data,
		message.simulation,
		{ emit: (output) => scope.postMessage(output), frame, cancel, now: () => performance.now() },
		message.layoutScope,
	);
	for (const input of message.setup) engine.input(input);
	void Promise.allSettled(loads).then(() => engine?.input({ type: "redraw" }));
};
