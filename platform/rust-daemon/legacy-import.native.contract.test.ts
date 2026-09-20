import { describe, expect, test } from "bun:test";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: contract runner injects the daemon URL
const base = process.env.SIGNET_NATIVE_DAEMON_URL;

describe("native legacy markdown import contract", () => {
	test("persists scoped imports, chunks, validates, and deduplicates retries", async () => {
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
		const isolated = await request("contract-workspace-b", [
			{ name: "2026-02-03.md", content: "contract note\n\nsecond note" },
		]);
		expect(await isolated.json()).toMatchObject({ imported: 2, skipped: 0 });
		const invalid = await request(
			"contract-workspace-a",
			Array.from({ length: 26 }, (_, i) => ({ name: `2026-01-${String(i + 1).padStart(2, "0")}.md`, content: "x" })),
		);
		expect(invalid.ok).toBe(false);
	});
});
