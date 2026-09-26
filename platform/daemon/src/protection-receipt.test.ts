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
		const receipt = {
			schema: "signet.restore.v1" as const,
			id: "receipt-1",
			at: "2026-09-23T00:00:00.000Z",
			expiresAt: "2026-09-24T00:00:00.000Z",
			valid: true as const,
			workspace,
			components: ["sqlite"] as const,
			digests: { sqlite: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
		};
		saveRestoreReceipt(workspace, receipt);
		expect(readRestoreReceipt(workspace)).toEqual(receipt);
		expect(existsSync(join(workspace, "runtime", "protection-restore-receipt.json"))).toBe(true);
		expect(existsSync(join(workspace, ".daemon", "protection-restore-receipt.json"))).toBe(false);
	});
});
