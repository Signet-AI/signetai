import { describe, expect, test } from "bun:test";
import {
	classificationImpact,
	offboardingRequest,
	organizationSections,
	rolePermissions,
	terminalJob,
} from "./organization";

describe("organization controls", () => {
	test("local mode never exposes organization sections", () => {
		expect(organizationSections(false, "admin", true)).toEqual([]);
		expect(organizationSections(true, "member", false)).toEqual(["teams"]);
		expect(organizationSections(true, "readonly", true)).toContain("classifications");
	});
	test("offboarding requires the exact displayed name and a preview", () => {
		const plan = { userId: "usr_bob", mode: "transfer", transferTo: "usr_alice", counts: { memories: 2 } } as const;
		expect(offboardingRequest(plan, "Bob", "bob")).toBeNull();
		expect(offboardingRequest(null, "Bob", "Bob")).toBeNull();
		expect(offboardingRequest(plan, "Bob", "Bob")).toEqual({
			mode: "transfer",
			transferTo: "usr_alice",
			dryRun: false,
		});
	});
	test("accepted and running jobs are not complete", () => {
		expect(terminalJob("pending")).toBe(false);
		expect(terminalJob("running")).toBe(false);
		expect(terminalJob("complete")).toBe(true);
		expect(terminalJob("failed")).toBe(true);
	});
	test("admin is not compliance or break-glass", () => {
		expect(rolePermissions("admin")).not.toContain("classify");
		expect(rolePermissions("readonly")).toEqual(["recall"]);
	});
});

test("classification previews use plain counts and correct singular and plural copy", () => {
	expect(classificationImpact("memory", 1, 0)).toBe("This will classify 1 memory and 0 items derived from it.");
	expect(classificationImpact("memory", 2, 1)).toBe("This will classify 2 memories and 1 item derived from them.");
	expect(classificationImpact("source", 1, 2)).toBe("This will classify 1 item and 2 items derived from it.");
});
