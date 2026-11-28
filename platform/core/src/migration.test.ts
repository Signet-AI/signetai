import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { detectSchemaType, initializeDatabaseSchema } from "./migration";
import { MIGRATIONS } from "./migrations/index";

it("initializes with foreign keys enabled without enclosing migration 179 in a transaction", () => {
	const db = new Database(":memory:");
	try {
		db.exec("PRAGMA foreign_keys=ON");
		expect(() => initializeDatabaseSchema(db)).not.toThrow();
		expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
		expect(db.query("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({
			version: MIGRATIONS.at(-1)?.version,
		});
		expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
	} finally {
		db.close();
	}
});

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
