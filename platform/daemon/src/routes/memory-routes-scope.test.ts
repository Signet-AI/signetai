/**
 * Regression tests for scope enforcement and structured payload validation
 * on POST /api/memory/remember and aggregate-save paths.
 *
 * These tests validate the input-shape checks and scope gates at the
 * validation boundary — they do not spin up the full Hono server.
 */
import { describe, expect, it } from "bun:test";

describe("structured payload validation", () => {
	// Validates the same shape checks that run inline in the remember handler.
	// Duplicated here as pure validation tests since the route handler
	// requires full Hono + DB setup.

	function validateStructured(body: {
		structured?: unknown;
	}): { valid: true } | { valid: false; error: string } {
		if (!("structured" in body)) {
			return { valid: true };
		}
		if (body.structured == null || typeof body.structured !== "object" || Array.isArray(body.structured)) {
			return { valid: false, error: "structured must be an object with entities and/or aspects arrays" };
		}
		const s = body.structured as Record<string, unknown>;
		if (s.entities !== undefined && !Array.isArray(s.entities)) {
			return { valid: false, error: "structured.entities must be an array" };
		}
		if (s.aspects !== undefined && !Array.isArray(s.aspects)) {
			return { valid: false, error: "structured.aspects must be an array" };
		}
		if (s.hints !== undefined && !Array.isArray(s.hints)) {
			return { valid: false, error: "structured.hints must be an array" };
		}
		return { valid: true };
	}

	it("rejects structured: string", () => {
		const result = validateStructured({ structured: "yes" });
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.error).toContain("must be an object");
	});

	it("rejects structured: number", () => {
		const result = validateStructured({ structured: 42 });
		expect(result.valid).toBe(false);
	});

	it("rejects structured: boolean", () => {
		const result = validateStructured({ structured: true });
		expect(result.valid).toBe(false);
	});

	it("rejects structured: array", () => {
		const result = validateStructured({ structured: [1, 2, 3] });
		expect(result.valid).toBe(false);
	});

	it("rejects structured: null", () => {
		const result = validateStructured({ structured: null });
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.error).toContain("must be an object");
	});

	it("accepts valid structured with entities array", () => {
		const result = validateStructured({
			structured: {
				entities: [{ source: "a", relationship: "rel", target: "b", confidence: 0.9 }],
			},
		});
		expect(result.valid).toBe(true);
	});

	it("accepts valid structured with empty entities", () => {
		const result = validateStructured({ structured: { entities: [] } });
		expect(result.valid).toBe(true);
	});

	it("rejects structured with non-array entities", () => {
		const result = validateStructured({ structured: { entities: "not-array" } });
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.error).toContain("structured.entities must be an array");
	});

	it("rejects structured with non-array aspects", () => {
		const result = validateStructured({ structured: { aspects: 123 } });
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.error).toContain("structured.aspects must be an array");
	});

	it("rejects structured with non-array hints", () => {
		const result = validateStructured({ structured: { hints: {} } });
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.error).toContain("structured.hints must be an array");
	});

	it("accepts structured with only hints array", () => {
		const result = validateStructured({ structured: { hints: ["test hint that is long enough"] } });
		expect(result.valid).toBe(true);
	});
});

describe("project scope check", () => {
	// Mirrors the inline check in the remember handler for project-scoped tokens.
	function checkProjectScope(params: {
		tokenProject: string | undefined;
		bodyProject: string | undefined;
		isAdmin: boolean;
	}): { allowed: true } | { allowed: false; error: string } {
		const { tokenProject, bodyProject, isAdmin } = params;
		if (isAdmin || !tokenProject) return { allowed: true };
		if (!bodyProject || bodyProject !== tokenProject) {
			return { allowed: false, error: `scope restricted to project '${tokenProject}'` };
		}
		return { allowed: true };
	}

	it("allows unscoped tokens to write without project", () => {
		expect(checkProjectScope({ tokenProject: undefined, bodyProject: undefined, isAdmin: false }).allowed).toBe(true);
	});

	it("allows admin tokens to bypass project scope", () => {
		expect(checkProjectScope({ tokenProject: "project-a", bodyProject: undefined, isAdmin: true }).allowed).toBe(true);
	});

	it("allows admin tokens to write any project", () => {
		expect(checkProjectScope({ tokenProject: "project-a", bodyProject: "project-b", isAdmin: true }).allowed).toBe(true);
	});

	it("rejects project-scoped token writing without project", () => {
		const result = checkProjectScope({ tokenProject: "project-a", bodyProject: undefined, isAdmin: false });
		expect(result.allowed).toBe(false);
		if (!result.allowed) expect(result.error).toContain("project-a");
	});

	it("rejects project-scoped token writing different project", () => {
		const result = checkProjectScope({ tokenProject: "project-a", bodyProject: "project-b", isAdmin: false });
		expect(result.allowed).toBe(false);
	});

	it("allows project-scoped token writing matching project", () => {
		expect(checkProjectScope({ tokenProject: "project-a", bodyProject: "project-a", isAdmin: false }).allowed).toBe(true);
	});
});
