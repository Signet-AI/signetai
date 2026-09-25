import { describe, expect, it } from "bun:test";
import { buildMemoryCountPlan } from "./status-summary.js";

describe("buildMemoryCountPlan", () => {
	it("scopes by agent and excludes soft-deleted rows on the core schema", () => {
		const plan = buildMemoryCountPlan([
			"id",
			"content",
			"category",
			"confidence",
			"source_id",
			"vector_clock",
			"agent_id",
			"is_deleted",
		]);
		expect(plan.schema).toBe("core");
		expect(plan.scopedByAgent).toBe(true);
		expect(plan.memoryCountSql).toContain("agent_id");
		expect(plan.memoryCountSql).toContain("is_deleted");
	});

	it("counts unscoped on a legacy python schema so the summary still reports", () => {
		const plan = buildMemoryCountPlan(["id", "content", "who", "why", "created_at"]);
		expect(plan.schema).toBe("python");
		expect(plan.scopedByAgent).toBe(false);
		expect(plan.memoryCountSql).toBe("(SELECT COUNT(*) FROM memories) AS memoryCount");
	});

	it("counts unscoped on a legacy cli-v1 schema", () => {
		const plan = buildMemoryCountPlan(["id", "content", "source", "accessed_at"]);
		expect(plan.schema).toBe("cli-v1");
		expect(plan.scopedByAgent).toBe(false);
	});

	it("filters by agent without an is_deleted clause when only agent scoping exists", () => {
		const plan = buildMemoryCountPlan([
			"id",
			"content",
			"category",
			"confidence",
			"source_id",
			"vector_clock",
			"agent_id",
		]);
		expect(plan.schema).toBe("core");
		expect(plan.scopedByAgent).toBe(true);
		expect(plan.memoryCountSql).not.toContain("is_deleted");
		expect(plan.memoryCountSql).toContain("agent_id");
	});

	it("throws when the memories table is absent", () => {
		expect(() => buildMemoryCountPlan([])).toThrow("memories table");
	});
});
