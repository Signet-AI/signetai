/**
 * Live verification that createAcpxProvider drives each ACP-backed harness
 * (claude, codex, opencode, gemini, etc.). Runs only when
 * SIGNET_ACPX_LIVE_AGENT is set.
 *
 * Example:
 *   SIGNET_ACPX_LIVE_AGENT=claude bun test platform/daemon/src/pipeline/acpx-harness.live.test.ts
 *
 * The harness should be installed on the host; authentication is optional — an
 * AUTH_REQUIRED response is treated as a successful invocation (it proves the
 * full chain createAcpxProvider -> acpx -> harness -> ACP init ran and reached
 * the harness's auth gate).
 */
import { describe, expect, test } from "bun:test";
import { createAcpxProvider } from "./provider";

const AGENT = process.env.SIGNET_ACPX_LIVE_AGENT;
const SKIP = !AGENT;

describe.skipIf(SKIP)(`createAcpxProvider drives ${AGENT ?? "harness"} (live)`, () => {
	test("completes a one-shot prompt through ACPX (or reaches the auth gate)", async () => {
		const provider = createAcpxProvider({
			agent: AGENT!,
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
			// AUTH_REQUIRED proves the invocation chain worked — createAcpxProvider
			// spawned acpx, which spawned the harness, which initialized its ACP
			// client and reached the auth gate. The failure is the harness's own
			// missing/expired auth, not a provider defect. Treat as a pass so the
			// test is useful even where harness auth isn't configured.
			if (/AUTH_REQUIRED|Authentication required/i.test(msg)) {
				console.log(`[${AGENT}] invocation reached auth gate (success): ${msg}`);
				return;
			}
			throw e;
		}
	}, 120_000);

	test("reports unavailable when the agent binary is missing", async () => {
		const provider = createAcpxProvider({
			agent: AGENT!,
			bin: "./node_modules/.bin/signet-definitely-missing-acpx",
			hooks: "disabled",
		});
		await expect(provider.available()).resolves.toBe(false);
	});
});
