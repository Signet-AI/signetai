import { describe, expect, test } from "bun:test";
import {
	BOUNDARY_REASONS,
	DEFAULT_DURABLE_BOUNDARIES,
	DURABLE_BOUNDARY_REASONS,
	isDurableBoundary,
	normalizeBoundaryReason,
} from "./boundary-reason";

describe("boundary-reason", () => {
	describe("normalizeBoundaryReason", () => {
		test("returns session_closed for undefined/null/empty", () => {
			expect(normalizeBoundaryReason(undefined)).toBe("session_closed");
			expect(normalizeBoundaryReason(null)).toBe("session_closed");
			expect(normalizeBoundaryReason("")).toBe("session_closed");
		});

		test("normalizes known reasons", () => {
			expect(normalizeBoundaryReason("session_closed")).toBe("session_closed");
			expect(normalizeBoundaryReason("compaction")).toBe("compaction");
			expect(normalizeBoundaryReason("checkpoint")).toBe("checkpoint");
			expect(normalizeBoundaryReason("CHECKPOINT")).toBe("checkpoint");
			expect(normalizeBoundaryReason(" ttl_expired ")).toBe("ttl_expired");
		});

		test("maps legacy trigger values", () => {
			expect(normalizeBoundaryReason("session_end")).toBe("session_closed");
			expect(normalizeBoundaryReason("clear")).toBe("session_closed");
			expect(normalizeBoundaryReason("checkpoint_extract")).toBe("checkpoint");
			expect(normalizeBoundaryReason("mid_session_extract")).toBe("checkpoint");
		});

		test("defaults unknown values to session_closed", () => {
			expect(normalizeBoundaryReason("unknown_thing")).toBe("session_closed");
			expect(normalizeBoundaryReason("whatever")).toBe("session_closed");
		});
	});

	describe("isDurableBoundary", () => {
		test("session_closed and new_session are durable by default", () => {
			expect(isDurableBoundary("session_closed")).toBe(true);
			expect(isDurableBoundary("new_session")).toBe(true);
		});

		test("compaction and checkpoint are NOT durable by default", () => {
			expect(isDurableBoundary("compaction")).toBe(false);
			expect(isDurableBoundary("checkpoint")).toBe(false);
			expect(isDurableBoundary("ttl_expired")).toBe(false);
			expect(isDurableBoundary("connector_retry")).toBe(false);
		});

		test("missing reason is treated as durable (backward compat)", () => {
			expect(isDurableBoundary(undefined)).toBe(true);
			expect(isDurableBoundary(null)).toBe(true);
			expect(isDurableBoundary("")).toBe(true);
		});

		test("respects custom durable set", () => {
			const custom = new Set(["compaction", "checkpoint"]);
			expect(isDurableBoundary("compaction", custom)).toBe(true);
			expect(isDurableBoundary("checkpoint", custom)).toBe(true);
			expect(isDurableBoundary("session_closed", custom)).toBe(false);
		});

		test("unknown reason is not durable with a custom set", () => {
			expect(isDurableBoundary("random_thing", DURABLE_BOUNDARY_REASONS)).toBe(false);
		});
	});

	describe("constants", () => {
		test("BOUNDARY_REASONS includes all expected values", () => {
			expect(BOUNDARY_REASONS).toContain("session_closed");
			expect(BOUNDARY_REASONS).toContain("new_session");
			expect(BOUNDARY_REASONS).toContain("compaction");
			expect(BOUNDARY_REASONS).toContain("checkpoint");
			expect(BOUNDARY_REASONS).toContain("ttl_expired");
			expect(BOUNDARY_REASONS).toContain("connector_retry");
		});

		test("DEFAULT_DURABLE_BOUNDARIES matches DURABLE_BOUNDARY_REASONS", () => {
			expect(new Set(DEFAULT_DURABLE_BOUNDARIES)).toEqual(DURABLE_BOUNDARY_REASONS);
		});
	});
});
