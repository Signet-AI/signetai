import { describe, expect, test } from "bun:test";
import { createDebouncedValue } from "./graph-density";

const graphViewSource = await Bun.file(new URL("../views/graph.tsx", import.meta.url)).text();

const graphSceneSource = await Bun.file(new URL("./graph-scene.ts", import.meta.url)).text();
const stylesheet = await Bun.file(new URL("../index.css", import.meta.url)).text();

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("graph density updates", () => {
	test("commits only the final slider value after dragging settles", async () => {
		const committed: number[] = [];
		const density = createDebouncedValue(20, (value: number) => committed.push(value));

		density.schedule(3.2);
		await wait(10);
		density.schedule(5.4);
		await wait(35);

		expect(committed).toEqual([5.4]);
	});

	test("cancels a queued density update when the graph is unmounted", async () => {
		const committed: number[] = [];
		const density = createDebouncedValue(20, (value: number) => committed.push(value));

		density.schedule(4.8);
		density.cancel();
		await wait(30);

		expect(committed).toEqual([]);
	});

	test("keeps the requested thumb position after the rounded graph response arrives", () => {
		expect(graphViewSource).toContain("const displayPct = sliderPct ?? shownPct;");
		expect(graphViewSource).not.toContain("setSliderPct(null);");
	});

	test("reveals a rebuilt constellation instead of popping it into view", () => {
		expect(graphSceneSource).toContain("fadeIn?: boolean");
		expect(graphSceneSource).toContain("graph-density-reveal");
		expect(stylesheet).toContain("@keyframes graph-density-reveal");
	});
});
