import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
		writeFileSync(join(workspace, "workspace-layout.json"), JSON.stringify({ version: 2 }));
		saveRestoreReceipt(workspace, { at: "2026-09-22T00:00:00.000Z", valid: true, id: "receipt-1" });
		expect(readRestoreReceipt(workspace)).toEqual({ at: "2026-09-22T00:00:00.000Z", valid: true, id: "receipt-1" });
		expect(existsSync(join(workspace, "runtime", "protection-restore-receipt.json"))).toBe(true);
		expect(existsSync(join(workspace, ".daemon", "protection-restore-receipt.json"))).toBe(false);
	});
});
