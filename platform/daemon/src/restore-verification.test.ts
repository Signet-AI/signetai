import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeDisposableRestore, verifyRestore } from "./restore-verification";

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "signet-restore-"));
	for (const file of [
		"MEMORY.md",
		"transcripts/2026-01-01.jsonl",
		"skills/independent/SKILL.md",
		"imports/original.md",
	])
		mkdirSync(join(root, file, ".."), { recursive: true });
	writeFileSync(join(root, "MEMORY.md"), "memory");
	writeFileSync(
		join(root, "transcripts/2026-01-01.jsonl"),
		JSON.stringify({ role: "user", content: "hello", timestamp: "2026-01-01T00:00:00Z", provenance: "source-1" }) +
			"\n",
	);
	writeFileSync(join(root, "skills/independent/SKILL.md"), "skill");
	writeFileSync(join(root, "imports/original.md"), "original");
	return root;
}

function fakeHealthyDaemon(snapshot: string): string {
	const daemon = join(snapshot, "fake-daemon.ts");
	writeFileSync(
		daemon,
		'import { createServer } from "node:http"; createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ status: "healthy", db: true, workspace: { path: process.env.SIGNET_PATH } })); }).listen(Number(process.env.SIGNET_RESTORE_PORT), "127.0.0.1");',
	);
	return daemon;
}

const expected = {
	files: ["MEMORY.md", "transcripts/2026-01-01.jsonl", "skills/independent/SKILL.md", "imports/original.md"],
	transcripts: [{ path: "transcripts/2026-01-01.jsonl", roles: ["user"], provenance: ["source-1"] }],
	sources: [{ id: "source-1", generation: 3 }],
	recall: { current: true, scope: "agent-a" },
	dreaming: { frontier: "pass-4", consumed: ["pass-1", "pass-2", "pass-3"] },
	ontology: { history: 2, evidenceLinks: 1 },
	harness: { identity: "agent-a", skills: ["independent"] },
};

describe("verifyRestore", () => {
	it("compares supplied claims but cannot certify a restore without independent evidence", async () => {
		const root = workspace();
		const result = await verifyRestore({
			root,
			expected,
			database: { snapshotConsistent: true },
			daemon: { ready: true },
			observed: {
				sources: expected.sources,
				recall: expected.recall,
				dreaming: expected.dreaming,
				ontology: expected.ontology,
				harness: expected.harness,
			},
		});
		expect(result.ok).toBe(false);
		expect(result.failures.some(({ component }) => component === "evidence")).toBe(true);
		expect(result.receipt.schema).toBe("signet.restore.v1");
		expect(result.receipt).not.toHaveProperty("content");
		expect(result.receipt.components).toContain("transcripts");
	});

	it("runs a disposable compatibility probe but does not certify echoed values", async () => {
		const snapshot = workspace();
		const daemon = fakeHealthyDaemon(snapshot);
		const result = await executeDisposableRestore({
			snapshotRoot: snapshot,
			expected,
			daemon: { binary: process.execPath, args: [daemon] },
			probe: async (root, port) => {
				expect(port).toBeGreaterThan(0);
				expect(existsSync(join(root, "MEMORY.md"))).toBe(true);
				return {
					database: { snapshotConsistent: true },
					observed: {
						sources: expected.sources,
						recall: expected.recall,
						dreaming: expected.dreaming,
						ontology: expected.ontology,
						harness: expected.harness,
					},
				};
			},
		});
		expect(result.ok).toBe(false);
		expect(result.cleaned).toBe(true);
		expect(result.receipt.protection).toBe("unverified");
		expect(result.failures.some(({ component }) => component === "sources")).toBe(false);
		expect(result.receipt.fileDigests["MEMORY.md"]).toMatch(/^[a-f0-9]{64}$/);
	});

	it("does not certify caller-echoed observations or write a receipt into the source snapshot", async () => {
		const snapshot = workspace();
		const daemon = fakeHealthyDaemon(snapshot);
		const result = await executeDisposableRestore({
			snapshotRoot: snapshot,
			expected,
			daemon: { binary: process.execPath, args: [daemon] },
			probe: async () => ({
				database: { snapshotConsistent: true },
				observed: {
					sources: expected.sources,
					recall: expected.recall,
					dreaming: expected.dreaming,
					ontology: expected.ontology,
					harness: expected.harness,
				},
			}),
		});
		expect(result.ok).toBe(false);
		expect(result.failures.some(({ component }) => component === "protection")).toBe(true);
		expect(result.failures.some(({ component }) => component === "sources")).toBe(false);
		expect(existsSync(join(snapshot, ".signet", "restore-receipt.json"))).toBe(false);
		expect(result.cleaned).toBe(true);
	});

	it("does not call a live-only daemon ready when workspace health is degraded", async () => {
		const snapshot = workspace();
		const daemon = join(snapshot, "live-only-daemon.ts");
		writeFileSync(
			daemon,
			'import { createServer } from "node:http"; createServer((req, res) => { res.setHeader("content-type", "application/json"); if (req.url === "/health/live") { res.end(JSON.stringify({ status: "healthy" })); return; } if (req.url === "/health") { res.statusCode = 503; res.end(JSON.stringify({ status: "degraded", db: false, workspace: { path: process.env.SIGNET_PATH } })); return; } res.statusCode = 404; res.end(); }).listen(Number(process.env.SIGNET_RESTORE_PORT), "127.0.0.1");',
		);
		let probed = false;
		const result = await executeDisposableRestore({
			snapshotRoot: snapshot,
			expected,
			daemon: { binary: process.execPath, args: [daemon] },
			probe: async () => {
				probed = true;
				return { database: { snapshotConsistent: true }, observed: {} };
			},
		});
		expect(probed).toBe(false);
		expect(result.failures.some(({ component }) => component === "daemon")).toBe(true);
		expect(result.cleaned).toBe(true);
	}, 10_000);

	it("attributes a probe failure to its component after the daemon becomes healthy", async () => {
		const snapshot = workspace();
		const daemon = fakeHealthyDaemon(snapshot);
		const result = await executeDisposableRestore({
			snapshotRoot: snapshot,
			expected,
			daemon: { binary: process.execPath, args: [daemon] },
			probe: async () => {
				throw Object.assign(new Error("private source endpoint detail"), { component: "sources" });
			},
		});
		expect(result.failures.some(({ component }) => component === "sources")).toBe(true);
		expect(result.failures.some(({ component }) => component === "daemon")).toBe(false);
		expect(JSON.stringify(result)).not.toContain("private source endpoint detail");
		expect(result.cleaned).toBe(true);
	});

	it("fails closed and withholds an all-components receipt when secret continuity is unverified", async () => {
		const snapshot = workspace();
		const daemon = fakeHealthyDaemon(snapshot);
		const result = await executeDisposableRestore({
			snapshotRoot: snapshot,
			expected,
			daemon: { binary: process.execPath, args: [daemon] },
			probe: async () => ({
				database: { snapshotConsistent: true },
				observed: {
					sources: expected.sources,
					recall: expected.recall,
					dreaming: expected.dreaming,
					ontology: expected.ontology,
					harness: expected.harness,
				},
			}),
		});
		expect(result.ok).toBe(false);
		expect(result.receipt.ok).toBe(false);
		expect(result.receipt.protection).toBe("unverified");
		expect(result.failures).toContainEqual({
			component: "protection",
			reason: "secret provider continuity is unverified",
		});
		expect(result.failures.some(({ component }) => component === "sources")).toBe(false);
		expect(existsSync(join(snapshot, ".signet", "restore-receipt.json"))).toBe(false);
		expect(result.cleaned).toBe(true);
	});

	it("fails closed when transcript ordering or provenance changes", async () => {
		const root = workspace();
		writeFileSync(
			join(root, "transcripts/2026-01-01.jsonl"),
			`${JSON.stringify({
				role: "assistant",
				content: "tampered",
				timestamp: "2025-01-01T00:00:00Z",
				provenance: "other",
			})}\n`,
		);
		const result = await verifyRestore({
			root,
			expected,
			database: { snapshotConsistent: true },
			daemon: { ready: true },
		});
		expect(result.ok).toBe(false);
		expect(result.failures.some((failure) => failure.component === "transcripts")).toBe(true);
	});
});
