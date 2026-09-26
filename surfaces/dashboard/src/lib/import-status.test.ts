import { expect, test } from "bun:test";
import { importStatusLabel, isInboxEntry, type DurableImportState } from "./import-status";

test("labels every durable import state and exposes recovery guidance", () => {
	const states: DurableImportState[] = ["pending", "processing", "imported", "duplicate", "failed", "quarantined"];
	expect(states.map(importStatusLabel)).toEqual([
		"Pending admission",
		"Processing",
		"Imported",
		"Duplicate",
		"Failed",
		"Quarantined",
	]);
});

test("inbox entries never appear as configured sources", () => {
	expect(isInboxEntry({ kind: "inbox", id: "1" })).toBe(true);
	expect(isInboxEntry({ kind: "import", id: "1" })).toBe(false);
});
