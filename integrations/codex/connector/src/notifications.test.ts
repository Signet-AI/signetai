import { describe, expect, it } from "bun:test";
import { buildHooksFile } from "./index";

describe("Codex cross-agent notification hooks", () => {
	it("installs a trusted PreToolUse notification command", () => {
		const file = buildHooksFile(["signet"], null) as {
			hooks?: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>>;
		};
		const handler = file.hooks?.PreToolUse?.[0]?.hooks[0];
		expect(handler?.command).toContain("hook notifications -H codex --hook PreToolUse --codex-json");
		expect(handler?.timeout).toBe(5);
	});

	it("installs a synchronous Stop wake command alongside session-end", () => {
		const file = buildHooksFile(["signet"], null) as {
			hooks?: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>>;
		};
		const stop = file.hooks?.Stop ?? [];
		expect(stop).toHaveLength(2);
		expect(stop[0]?.hooks[0]?.command).toContain("hook session-end -H codex");
		const wake = stop[1]?.hooks[0];
		expect(wake?.command).toContain("hook wake -H codex --no-wait --hook-json");
		expect(wake?.command).not.toContain("--codex-json");
		expect(wake?.timeout).toBe(5);
	});
});
