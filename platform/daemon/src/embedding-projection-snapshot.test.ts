import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProjectionSnapshotArtifact } from "./embedding-projection-snapshot";
import type { ProjectionPrincipal, ProjectionRequest } from "./embedding-projection-contract";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function request(): ProjectionRequest {
	return { dimensions: 2, limit: 1_000, offset: 0, filters: {} };
}

function vectorBytes(length: number): Uint8Array {
	const vector = new Float32Array(length);
	vector[0] = 1;
	return new Uint8Array(vector.buffer);
}

test("creates a scoped bounded artifact from one owner-side query boundary", () => {
	const directory = mkdtempSync(join(tmpdir(), "signet-projection-snapshot-test-"));
	directories.push(directory);
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE memories (
			id TEXT PRIMARY KEY, content TEXT, who TEXT, importance REAL, type TEXT, tags TEXT,
			pinned INTEGER, source_type TEXT, source_id TEXT, created_at TEXT,
			agent_id TEXT, project TEXT, is_deleted INTEGER DEFAULT 0, superseded_by TEXT
		);
		CREATE TABLE embeddings (source_type TEXT, source_id TEXT, vector BLOB, dimensions INTEGER);
	`);
	const vector = vectorBytes(768);
	const content = "a".repeat(1_000);
	db.query("INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)").run(
		"agent-a-row",
		content,
		"nicholai",
		0.5,
		"note",
		"tag",
		0,
		"memory",
		"agent-a-row",
		"2026-01-02T00:00:00.000Z",
		"agent-a",
		"project-a",
	);
	db.query("INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)").run(
		"agent-b-row",
		"other",
		"other",
		0.5,
		"note",
		"tag",
		0,
		"memory",
		"agent-b-row",
		"2026-01-03T00:00:00.000Z",
		"agent-b",
		"project-a",
	);
	db.query("INSERT INTO embeddings VALUES (?, ?, ?, ?)").run("memory", "agent-a-row", vector, 768);
	db.query("INSERT INTO embeddings VALUES (?, ?, ?, ?)").run("memory", "agent-b-row", vector, 768);

	const principal: ProjectionPrincipal = { agentId: "agent-a", project: "project-a" };
	const descriptor = createProjectionSnapshotArtifact(db, principal, request(), directory);
	const wire = JSON.parse(readFileSync(descriptor.path, "utf8")) as {
		rows: Array<{ id: string; content: string; vectorHex: string }>;
	};

	expect(descriptor.total).toBe(1);
	expect(descriptor.count).toBe(1);
	expect(wire.rows).toHaveLength(1);
	expect(wire.rows[0]?.id).toBe("agent-a-row");
	expect(wire.rows[0]?.content).toHaveLength(256);
	expect(wire.rows[0]?.vectorHex).toHaveLength(64 * 8);
	expect(statSync(descriptor.path).mode & 0o777).toBe(0o600);
	db.close();
});
