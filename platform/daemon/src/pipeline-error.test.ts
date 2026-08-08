import { describe, expect, it } from "bun:test";
import { isPipelineTimeout } from "./pipeline-error";

describe("pipeline error classification", () => {
	it("classifies the inference router deadline error as a timeout", () => {
		expect(isPipelineTimeout(new Error("Agent session exceeded the 90000ms deadline"))).toBe(true);
	});
});
