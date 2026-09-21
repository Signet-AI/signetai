import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneTranscriptAudit, writeTranscriptAudit } from "./transcript-audit";

describe("transcript audit references", () => {
	it("writes bounded metadata instead of a second raw transcript", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-audit-"));
		try {
			const result = await writeTranscriptAudit({
				basePath: root,
				agentId: "default",
				sourceIdentity: "file:codex:/sessions/one.jsonl",
				sourcePath: "/sessions/one.jsonl",
				sourceSha256: "a".repeat(64),
				sourceSizeBytes: 400 * 1024 * 1024,
				sourceFormat: "jsonl",
				sessionId: "sess-1",
				sessionKey: "sess-1",
				preview: "x".repeat(10 * 1024 * 1024),
				capturedAt: "2026-08-07T00:00:00.000Z",
			});
			expect(existsSync(result.latestPath)).toBe(true);
			expect(statSync(result.latestPath).size).toBeLessThan(70 * 1024);
			const record = JSON.parse(readFileSync(result.latestPath, "utf8")) as Record<string, unknown>;
			expect(record.source_path).toBe("/sessions/one.jsonl");
			expect(record.source_size_bytes).toBe(400 * 1024 * 1024);
			expect(String(record.preview)).toContain("audit preview omitted");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("coalesces repeated observations into one audit record", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-audit-"));
		try {
			const params = {
				basePath: root,
				agentId: "default",
				sourceIdentity: "file:codex:/sessions/one.jsonl",
				sourcePath: "/sessions/one.jsonl",
				sourceSha256: "b".repeat(64),
				sourceSizeBytes: 12,
				sourceFormat: "jsonl",
				sessionId: "sess-1",
				sessionKey: "sess-1",
			} as const;
			const first = await writeTranscriptAudit({ ...params, preview: "first" });
			const second = await writeTranscriptAudit({ ...params, preview: "second" });
			expect(second.latestPath).toBe(first.latestPath);
			expect(readdirSync(join(root, ".daemon", "logs", "transcripts"))).toHaveLength(1);
			expect(readFileSync(second.latestPath, "utf8")).toContain("second");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("provides bounded age/size cleanup", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-audit-"));
		try {
			const result = await pruneTranscriptAudit(root);
			expect(result).toEqual({ removedFiles: 0, removedBytes: 0 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
