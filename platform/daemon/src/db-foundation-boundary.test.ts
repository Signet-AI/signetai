import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createDbAccessorLifecycle } from "./db-accessor-lifecycle";

function source(relativePath: string): string {
	return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("DB foundation dependency invariant", () => {
	it("prevents accessor and vacuum primitives from importing owner orchestration", () => {
		const accessor = source("./db-accessor.ts");
		const vacuum = source("./db-vacuum.ts");

		expect(accessor).not.toContain('from "./db-owner-runtime"');
		expect(accessor).not.toContain('import("./agent-id")');
		expect(accessor).not.toContain('from "./db-vacuum-worker"');
		expect(vacuum).not.toContain('from "./db-owner-runtime"');
	});
});

describe("close participant lifecycle", () => {
	it("preserves owner-before-cache order and rejects registration during close", async () => {
		const lifecycle = createDbAccessorLifecycle();
		const closed: string[] = [];
		let duringCloseError: unknown;
		lifecycle.register({
			name: "test-agent-scope-cache",
			order: 200,
			close: () => {
				closed.push("agent-scope-cache");
			},
		});
		lifecycle.register({
			name: "test-db-owner",
			order: 100,
			close: () => {
				closed.push("db-owner");
				try {
					lifecycle.register({
						name: "during-close-participant",
						order: 300,
						close: () => undefined,
					});
				} catch (error) {
					duringCloseError = error;
				}
			},
		});

		await lifecycle.close(undefined);

		expect(closed).toEqual(["db-owner", "agent-scope-cache"]);
		expect(duringCloseError).toBeInstanceOf(Error);
		expect((duringCloseError as Error).message).toContain("registered after close started");

		// A later accessor lifecycle may load a participant after the previous
		// close has completed; only registration during close is forbidden.
		lifecycle.register({
			name: "next-lifecycle-participant",
			order: 300,
			close: () => {
				closed.push("next-lifecycle-participant");
			},
		});
		await lifecycle.close(undefined);
		expect(closed).toEqual([
			"db-owner",
			"agent-scope-cache",
			"db-owner",
			"agent-scope-cache",
			"next-lifecycle-participant",
		]);
	});

	it("reopens after a participant failure without caching the rejected close", async () => {
		const lifecycle = createDbAccessorLifecycle();
		let attempts = 0;
		lifecycle.register({
			name: "flaky-participant",
			order: 100,
			close: () => {
				attempts += 1;
				if (attempts === 1) throw new Error("simulated close failure");
			},
		});

		await expect(lifecycle.close(undefined)).rejects.toThrow("simulated close failure");
		lifecycle.register({
			name: "reinitialized-participant",
			order: 200,
			close: () => undefined,
		});
		await lifecycle.close(undefined);
		expect(attempts).toBe(2);
	});
});

describe("owner transport purity", () => {
	it("keeps DB owner transport independent of Dreaming implementations", () => {
		const runtime = source("./db-owner-runtime.ts");

		expect(runtime).not.toContain('"./knowledge-graph-hygiene"');
		expect(runtime).not.toContain('"./pipeline/dreaming');
	});

	it("keeps the knowledge graph independent of Dreaming composition", () => {
		const graph = source("./knowledge-graph.ts");

		expect(graph).not.toContain('from "./pipeline/dreaming"');
	});

	it("keeps widget generation independent of MCP probe persistence", () => {
		const widget = source("./widget-gen.ts");

		expect(widget).not.toContain('from "./mcp-probe"');
	});
});
