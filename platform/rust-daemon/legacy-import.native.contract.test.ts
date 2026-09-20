import { describe, expect, test } from "bun:test";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: contract runner injects the daemon URL
const base = process.env.SIGNET_NATIVE_DAEMON_URL;

describe("native legacy markdown import contract", () => {
	test.skipIf(!base)("persists scoped imports and deduplicates retries", async () => {
		const response = await fetch(`${base}/api/memory/import`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-signet-agent": "contract-agent" },
			body: JSON.stringify({
				workspaceId: "contract-workspace",
				files: [{ name: "2026-02-03.md", content: "contract note\n\nsecond note" }],
			}),
		});
		expect(response.ok).toBe(true);
		expect(await response.json()).toMatchObject({ imported: 2, skipped: 0, errors: [] });
		const retry = await fetch(`${base}/api/memory/import`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-signet-agent": "contract-agent" },
			body: JSON.stringify({
				workspaceId: "contract-workspace",
				files: [{ name: "2026-02-03.md", content: "contract note\n\nsecond note" }],
			}),
		});
		expect(await retry.json()).toMatchObject({ imported: 0, skipped: 2 });
	});
});
