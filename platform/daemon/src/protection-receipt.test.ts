import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRestoreReceipt, saveRestoreReceipt } from "./protection";

let workspace = "";
afterEach(() => {
	if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("restore receipt seam", () => {
	it("stores and reads only a valid receipt", () => {
		workspace = mkdtempSync(join(tmpdir(), "protection-receipt-"));
		saveRestoreReceipt(workspace, { at: "2026-09-22T00:00:00.000Z", valid: true, id: "receipt-1" });
		expect(readRestoreReceipt(workspace)).toEqual({ at: "2026-09-22T00:00:00.000Z", valid: true, id: "receipt-1" });
	});
});
