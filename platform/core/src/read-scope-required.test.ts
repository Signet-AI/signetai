import { describe, expect, it } from "bun:test";
import { isReadScope, localAllReadScope, readScopeSql, requireReadScope } from "./read-scope";

describe("read scope constructors", () => {
	it("localAllReadScope keeps the explicit reach and opens every compartment for local callers", () => {
		expect(localAllReadScope({ kind: "own", agentId: "a" })).toEqual({
			reach: { kind: "own", agentId: "a" },
			compartments: "all",
			projects: null,
		});
		expect(localAllReadScope({ kind: "group", agentId: "a", group: "g" }).reach).toEqual({
			kind: "group",
			agentId: "a",
			group: "g",
		});
		expect(localAllReadScope({ kind: "all" }).compartments).toBe("all");
	});

	it("localAllReadScope rejects a missing or malformed reach at runtime", () => {
		expect(() => Reflect.apply(localAllReadScope, undefined, [])).toThrow("read scope required");
		expect(() => Reflect.apply(localAllReadScope, undefined, [{ kind: "own" }])).toThrow("read scope required");
		expect(() => Reflect.apply(localAllReadScope, undefined, [{ kind: "everyone" }])).toThrow("read scope required");
	});

	it("requireReadScope accepts complete scopes and rejects partial ones", () => {
		const scope: unknown = {
			reach: { kind: "shared", agentId: "a" },
			compartments: [3],
			projects: ["p"],
			inFlightUserId: "u",
		};
		expect(requireReadScope(scope) === scope).toBe(true);
		expect(isReadScope({ reach: { kind: "all" }, compartments: [], projects: null })).toBe(true);
		for (const partial of [
			undefined,
			null,
			{},
			{ reach: { kind: "all" }, projects: null },
			{ reach: { kind: "all" }, compartments: "all" },
			{ reach: { kind: "all" }, compartments: [0], projects: null },
			{ reach: { kind: "all" }, compartments: "all", projects: null, inFlightUserId: 7 },
		])
			expect(() => requireReadScope(partial)).toThrow("read scope required");
	});

	it("readScopeSql fails closed for an omitted scope", () => {
		expect(() => Reflect.apply(readScopeSql, undefined, ["m"])).toThrow("read scope required");
		expect(readScopeSql("m", localAllReadScope({ kind: "own", agentId: "a" }))).toEqual({
			sql: " AND m.agent_id = ? AND m.visibility != 'archived'",
			args: ["a"],
		});
	});
});
