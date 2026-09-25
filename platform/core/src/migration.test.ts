import { describe, expect, it } from "bun:test";
import { detectSchemaType } from "./migration";

describe("detectSchemaType", () => {
	it("recognizes the legacy Python schema", () => {
		expect(detectSchemaType(["who", "why"])).toBe("python");
	});

	it("recognizes the legacy CLI schema", () => {
		expect(detectSchemaType(["source", "accessed_at"])).toBe("cli-v1");
	});

	it("prioritizes the core schema when legacy columns remain", () => {
		expect(
			detectSchemaType(["who", "why", "source", "accessed_at", "category", "confidence", "source_id", "vector_clock"]),
		).toBe("core");
	});

	it("returns unknown for absent or unrecognized columns", () => {
		expect(detectSchemaType([])).toBe("unknown");
		expect(detectSchemaType(["id", "created_at"])).toBe("unknown");
	});
});
