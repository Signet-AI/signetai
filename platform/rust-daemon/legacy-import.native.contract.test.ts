import { describe, expect, test } from "bun:test";
import { performance } from "node:perf_hooks";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: contract runner injects the daemon URL
const base = process.env.SIGNET_NATIVE_DAEMON_URL;

describe("native legacy markdown import contract", () => {
	test("persists scoped imports, chunks, validates, and deduplicates retries", async () => {
		const startedAt = performance.now();
		expect(base).toBeTruthy();
		const headers = {
			"content-type": "application/json",
			"x-signet-api-key": "contract-api-key",
			"x-signet-agent": "contract-agent",
		};
		const request = (workspaceId: string, files: unknown[]) =>
			fetch(`${base}/api/memory/import`, { method: "POST", headers, body: JSON.stringify({ workspaceId, files }) });
		const response = await request("contract-workspace-a", [
			{ name: "2026-02-03.md", content: "contract note\n\nsecond note" },
		]);
		expect(response.ok).toBe(true);
		expect(await response.json()).toMatchObject({ imported: 2, skipped: 0, errors: [] });
		const retry = await request("contract-workspace-a", [
			{ name: "2026-02-03.md", content: "contract note\n\nsecond note" },
		]);
		expect(await retry.json()).toMatchObject({ imported: 0, skipped: 2 });
		const changed = await request("contract-workspace-a", [
			{ name: "2026-02-03.md", content: "changed note\n\nsecond note" },
		]);
		expect(await changed.json()).toMatchObject({ imported: 2, skipped: 0 });
		const duplicateBatch = await request("contract-workspace-a", [
			{ name: "2026-02-04.md", content: "same descriptor" },
			{ name: "2026-02-04.md", content: "same descriptor" },
		]);
		expect(await duplicateBatch.json()).toMatchObject({ imported: 1, skipped: 1 });
		const isolated = await request("contract-workspace-b", [
			{ name: "2026-02-03.md", content: "contract note\n\nsecond note" },
		]);
		expect(await isolated.json()).toMatchObject({ imported: 2, skipped: 0 });
		const invalid = await request(
			"contract-workspace-a",
			Array.from({ length: 26 }, (_, i) => ({ name: `2026-01-${String(i + 1).padStart(2, "0")}.md`, content: "x" })),
		);
		expect(invalid.ok).toBe(false);
		const oversized = await request("contract-workspace-c", [
			{ name: "2026-02-05.md", content: "before rejection" },
			{ name: "2026-02-06.md", content: "x".repeat(8 * 1024 * 1024 + 1) },
		]);
		expect(oversized.ok).toBe(false);
		const multiMegabyte = await request("contract-workspace-large", [
			{ name: "2026-02-07.md", content: "valid large import\n" + "x".repeat(3 * 1024 * 1024) },
		]);
		expect(multiMegabyte.ok).toBe(true);
		const multiMegabyteResult = await multiMegabyte.json();
		expect(multiMegabyteResult).toMatchObject({ skipped: 0, errors: [] });
		expect(multiMegabyteResult.imported).toBeGreaterThan(0);
		const afterRejection = await request("contract-workspace-c", [
			{ name: "2026-02-05.md", content: "before rejection" },
		]);
		expect(await afterRejection.json()).toMatchObject({ imported: 1, skipped: 0 });
		expect(performance.now() - startedAt).toBeLessThan(10_000);
	}, 30_000);
});
