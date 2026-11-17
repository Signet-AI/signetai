import { expect, test } from "bun:test";
import { ENTITY_CATEGORIES, categoryColor, entityCategory } from "./entity-category";

test("entity types fold into legend categories and unknown types stay visible as other", () => {
	expect(entityCategory("person")).toBe("person");
	expect(entityCategory("Service")).toBe("tool");
	expect(entityCategory("source_document")).toBe("document");
	expect(entityCategory("concept")).toBe("other");
	expect(entityCategory("")).toBe("other");
	for (const { key } of ENTITY_CATEGORIES) {
		expect(categoryColor(key, true)).toMatch(/^#[0-9a-f]{6}$/);
		expect(categoryColor(key, false)).toMatch(/^#[0-9a-f]{6}$/);
	}
	expect(new Set(ENTITY_CATEGORIES.map(({ key }) => categoryColor(key, true))).size).toBe(ENTITY_CATEGORIES.length);
});
