import { describe, expect, it } from "bun:test";
import { assessDurability } from "./durability-gate";

const ENABLED = { enabled: true };

describe("durability-gate", () => {
	describe("rejects transient operational content (#897)", () => {
		// Each case is drawn directly from issue #897's reported pollution:
		// temporary paths, queue/process counts, diagnostic status, in-progress
		// state, short-validity hedging, task progress, and self-diagnostics.
		const cases: ReadonlyArray<readonly [string, string]> = [
			["temporary_path", "Scan output was written to /tmp/signet-audit-7f3a.log"],
			["temporary_path", "The runtime trace is at /var/folders/xx/run-42.log"],
			["queue_or_resource_count", "There are 5 items currently queued for processing"],
			["queue_or_resource_count", "8 background processes are running with 3 connections active"],
			["queue_or_resource_count", "Memory usage is at 72% during the indexing run"],
			["run_status", "The test suite is currently running with 3 failures so far"],
			["run_status", "The build currently exited with exit code 1"],
			["in_progress", "The embedding backfill is in progress and about 60% done"],
			["in_progress", "Currently working on the auth refactor, halfway through"],
			["short_validity", "Still checking whether the migration is reversible"],
			["short_validity", "Tentatively, the fix might land in the next release"],
			["task_progress", "Next I need to debug the stale lease in worker.ts"],
			["task_progress", "TODO: wire the new gate into the Rust worker"],
			["self_diagnostic", "Recall latency averaged 140ms during this diagnostic session"],
		];

		for (const [expectedCategory, content] of cases) {
			it(`rejects [${expectedCategory}]: "${content.slice(0, 48)}…"`, () => {
				const result = assessDurability(content, "fact", ENABLED);
				expect(result.durable).toBe(false);
				expect(result.reason).toBe("transient_operational");
				expect(result.category).toBe(expectedCategory);
			});
		}
	});

	describe("preserves durable facts that look similar (no over-rejection)", () => {
		// These mirror #897's "not stable user facts" boundary from the safe
		// side: facts that mention paths, numbers, PRs, or "tests/running" but
		// ARE durable must survive the gate.
		const durable: readonly string[] = [
			"Signet stores its database at $HOME/.agents/memory/memories.db",
			"The auth service uses PostgreSQL on port 5432",
			"Nicholai prefers to review PRs in small batches",
			"CI runs the full test suite on every push to main",
			"The team chose SQLite over Postgres for local state",
			"The daemon listens on port 3850 by default",
			"Bun compiles the native binary with --target=bun-darwin-arm64",
		];

		for (const content of durable) {
			it(`preserves: "${content.slice(0, 48)}…"`, () => {
				const result = assessDurability(content, "fact", ENABLED);
				expect(result.durable).toBe(true);
				expect(result.reason).toBe("durable");
			});
		}
	});

	it("bypasses for decision facts (durable by definition)", () => {
		// Even a decision phrased with operational wording stays durable.
		const result = assessDurability("Decided to queue the release until the build is in progress", "decision", ENABLED);
		expect(result.durable).toBe(true);
		expect(result.reason).toBe("decision_type");
	});

	it("passes everything when the gate is disabled", () => {
		const result = assessDurability("There are 5 items currently queued for processing", "fact", { enabled: false });
		expect(result.durable).toBe(true);
		expect(result.reason).toBe("gate_disabled");
	});

	it("treats empty content as durable (caller handles emptiness)", () => {
		const result = assessDurability("   ", "fact", ENABLED);
		expect(result.durable).toBe(true);
		expect(result.reason).toBe("durable");
	});
});
