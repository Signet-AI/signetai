import { expect, test } from "bun:test";
import { curveSegments, fillSegments } from "./graph-gl";

test("circle tessellation matches the counts Chrome's canvas uses at each device radius", () => {
	expect([1.1, 2.1, 2.15, 8, 8.2, 16].map(fillSegments)).toEqual([2, 2, 4, 4, 8, 8]);
	expect([2, 2.5, 4.6, 4.65, 8.1, 8.15, 18, 20].map(curveSegments)).toEqual([2, 3, 3, 4, 4, 5, 6, 7]);
});
