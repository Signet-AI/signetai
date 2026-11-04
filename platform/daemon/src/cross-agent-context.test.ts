import { describe, expect, it } from "bun:test";
import {
	applyContextDefaults,
	mergePresenceContext,
	parsePresenceContext,
	sanitizeContextText,
} from "./cross-agent-context";

describe("presence context parsing", () => {
	it("leaves absent fields absent and treats empty values as explicit clears", () => {
		expect(parsePresenceContext(undefined)).toEqual({ ok: true, patch: undefined });
		expect(parsePresenceContext({})).toEqual({ ok: true, patch: undefined });
		expect(parsePresenceContext({ task: "", resources: [] })).toEqual({ ok: true, patch: { task: "", resources: [] } });
	});

	it("rejects wrong types, unknown fields, and over-limit values instead of truncating", () => {
		for (const bad of [
			5,
			"x",
			[],
			{ cwd: [] },
			{ title: "t".repeat(161) },
			{ modifiedFiles: [["a"]] },
			{ extra: "x" },
		]) {
			const parsed = parsePresenceContext(bad);
			expect(parsed.ok).toBe(false);
		}
	});

	it("removes control and bidi characters and collapses whitespace", () => {
		expect(sanitizeContextText("a\u0000b\nc\u202ed\u001b[0m   e")).toBe("a b c d [0m e");
	});
});

describe("presence context merge", () => {
	it("merges per field, clears on empty, and drops the object when nothing remains", () => {
		const base = { cwd: "/a", task: "t", resources: ["gpu:0"] };
		expect(mergePresenceContext(base, { task: "u" })).toEqual({ cwd: "/a", task: "u", resources: ["gpu:0"] });
		expect(mergePresenceContext(base, { resources: [] })).toEqual({ cwd: "/a", task: "t" });
		expect(mergePresenceContext(base, undefined)).toEqual(base);
		expect(mergePresenceContext({ task: "t" }, { task: "" })).toBeUndefined();
	});

	it("applies defaults only to unset fields", () => {
		expect(applyContextDefaults({ cwd: "/own" }, { cwd: "/project" })).toBeUndefined();
		expect(applyContextDefaults(undefined, { cwd: "/project" })).toEqual({ cwd: "/project" });
	});
});
