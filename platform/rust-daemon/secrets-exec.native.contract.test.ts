/* biome-ignore-all lint/suspicious/noUndeclaredEnvVars: disposable native contract harness */
import { describe, expect, it } from "bun:test";

describe("native secrets exec contract", () => {
	it("documents malformed input and unknown-job envelopes", async () => {
		const origin = process.env.SIGNET_NATIVE_ORIGIN;
		if (!origin) return;
		const headers = {
			"content-type": "application/json",
			authorization: `Bearer ${process.env.SIGNET_API_KEY ?? ""}`,
			"x-signet-agent-id": "agent-a",
		};
		const bad = await fetch(`${origin}/api/secrets/exec`, {
			method: "POST",
			headers,
			body: JSON.stringify({ command: "", secretRefs: {} }),
		});
		expect(bad.status).toBe(400);
		const unknown = await fetch(`${origin}/api/secrets/exec/missing`, { headers });
		expect(unknown.status).toBe(404);
	});
});
