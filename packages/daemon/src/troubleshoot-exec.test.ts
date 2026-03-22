/**
 * Tests for the troubleshooter exec endpoint.
 *
 * Verifies command validation, lifecycle SSE structure, and the
 * critical spawn-before-kill ordering for daemon restart.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "daemon.ts"), "utf-8");

// ---------------------------------------------------------------------------
// Extract the route handler source for targeted assertions
// ---------------------------------------------------------------------------

function extract(pattern: RegExp): string {
	const match = SRC.match(pattern);
	if (!match) throw new Error(`Pattern not found: ${pattern}`);
	return match[0];
}

const execRoute = extract(/app\.post\("\/api\/troubleshoot\/exec"[\s\S]*?\n\}\);/);

const commands = extract(/const TROUBLESHOOT_COMMANDS[\s\S]*?\n\};/);

// ---------------------------------------------------------------------------
// Command validation
// ---------------------------------------------------------------------------

describe("troubleshoot exec: command validation", () => {
	it("defines TROUBLESHOOT_COMMANDS as a known set", () => {
		expect(commands).toContain('"daemon-stop"');
		expect(commands).toContain('"daemon-restart"');
		expect(commands).toContain('"status"');
		expect(commands).toContain('"daemon-status"');
	});

	it("rejects unknown keys with 400", () => {
		expect(execRoute).toContain("Unknown command");
		expect(execRoute).toContain("400");
	});

	it("returns 500 when binary is not found", () => {
		expect(execRoute).toContain("Binary not found");
		expect(execRoute).toContain("500");
	});
});

// ---------------------------------------------------------------------------
// Lifecycle SSE structure
// ---------------------------------------------------------------------------

describe("troubleshoot exec: lifecycle commands", () => {
	it("handles daemon-stop and daemon-restart as lifecycle commands", () => {
		expect(execRoute).toContain('key === "daemon-stop" || key === "daemon-restart"');
	});

	it("emits SSE events: started, stdout, exit", () => {
		expect(execRoute).toContain('type: "started"');
		expect(execRoute).toContain('type: "stdout"');
		expect(execRoute).toContain('type: "exit"');
	});

	it("returns text/event-stream content type for lifecycle", () => {
		expect(execRoute).toContain('"text/event-stream"');
	});

	it("warns about dashboard disconnect on daemon-stop", () => {
		expect(execRoute).toContain("Dashboard will lose connection");
	});
});

// ---------------------------------------------------------------------------
// C1: Spawn-before-kill ordering (critical race condition fix)
// ---------------------------------------------------------------------------

describe("troubleshoot exec: restart spawn ordering", () => {
	it("spawns detached child BEFORE sending SIGTERM", () => {
		const block = extract(/setTimeout\(async \(\) => \{[\s\S]*?daemon-restart[\s\S]*?\}, 1000\);/);

		const spawnIdx = block.indexOf("nodeSpawn(resolved");
		const killIdx = block.indexOf("process.kill(process.pid");
		expect(spawnIdx).toBeGreaterThan(-1);
		expect(killIdx).toBeGreaterThan(-1);
		expect(spawnIdx).toBeLessThan(killIdx);
	});

	it("does not nest spawn inside a separate setTimeout", () => {
		const block = extract(/if \(key === "daemon-restart"\) \{[\s\S]*?child\.unref\(\)/);

		// The old bug: spawn was inside a nested setTimeout that fired
		// after SIGTERM. Verify there's no setTimeout wrapping the spawn.
		const inner = block.match(/setTimeout\(\s*\(\)\s*=>\s*\{[\s\S]*?nodeSpawn/);
		expect(inner).toBeNull();
	});

	it("spawns with detached: true and stdio: ignore", () => {
		expect(execRoute).toContain("detached: true");
		expect(execRoute).toContain('stdio: "ignore"');
	});

	it("unrefs the child so parent can exit", () => {
		expect(execRoute).toContain("child.unref()");
	});

	it("strips SIGNET_NO_HOOKS from env and re-adds it for restart", () => {
		// Env destructuring strips the flag
		expect(execRoute).toContain("SIGNET_NO_HOOKS: _");
		// Re-added in spawn env
		expect(execRoute).toContain('SIGNET_NO_HOOKS: "1"');
	});

	it("wraps spawn in try/finally so SIGTERM fires even on failure", () => {
		const block = extract(/setTimeout\(async \(\) => \{[\s\S]*?daemon-restart[\s\S]*?\}, 1000\);/);
		// try block contains the spawn logic
		expect(block).toContain("try {");
		// finally block guarantees SIGTERM
		expect(block).toContain("} finally {");
		// SIGTERM is inside the finally, not the try
		const finallyIdx = block.indexOf("} finally {");
		const killIdx = block.indexOf("process.kill(process.pid");
		expect(killIdx).toBeGreaterThan(finallyIdx);
	});
});

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

describe("troubleshoot exec: auth middleware", () => {
	it("has admin auth middleware on /api/troubleshoot/*", () => {
		const middleware = SRC.match(/app\.use\("\/api\/troubleshoot\/\*"[\s\S]*?\}\);/);
		expect(middleware).not.toBeNull();
		expect(middleware?.[0]).toContain("admin");
		expect(middleware?.[0]).toContain("requirePermission");
	});
});

// ---------------------------------------------------------------------------
// M3: No connection: keep-alive header
// ---------------------------------------------------------------------------

describe("troubleshoot exec: SSE headers", () => {
	it("does not include connection: keep-alive on lifecycle SSE response", () => {
		const headers = extract(/new Response\(lifecycle[\s\S]*?headers:[\s\S]*?\}/);
		expect(headers).not.toContain("keep-alive");
	});
});
