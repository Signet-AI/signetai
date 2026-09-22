import { describe, expect, test } from "bun:test";
import { createAcpxProvider } from "./provider";

const AGENT = process.env.SIGNET_ACPX_LIVE_AGENT;
const SKIP = !AGENT;

describe.skipIf(SKIP)(`createAcpxProvider drives ${AGENT ?? "harness"} (live)`, () => {
	test("completes a one-shot prompt through ACPX (or reaches the auth gate)", async () => {
		if (!AGENT) return;
		const provider = createAcpxProvider({
			agent: AGENT,
			hooks: "disabled",
			format: "quiet",
		});
		try {
			const text = await provider.generate("Reply with exactly the word PONG and nothing else.", {
				timeoutMs: 90_000,
			});
			console.log(`[${AGENT}] response:`, JSON.stringify(text));
			expect(text.trim().length).toBeGreaterThan(0);
			expect(text.toLowerCase()).toContain("pong");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (/AUTH_REQUIRED|Authentication required/i.test(msg)) {
				console.log(`[${AGENT}] invocation reached auth gate (success): ${msg}`);
				return;
			}
			throw e;
		}
	}, 120_000);

	test("reports unavailable when the agent binary is missing", async () => {
		if (!AGENT) return;
		const provider = createAcpxProvider({
			agent: AGENT,
			bin: "./node_modules/.bin/signet-definitely-missing-acpx",
			hooks: "disabled",
		});
		await expect(provider.available()).resolves.toBe(false);
	});
});
