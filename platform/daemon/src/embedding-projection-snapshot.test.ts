import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProjectionSnapshotArtifact } from "./embedding-projection-snapshot";
import {
	PROJECTION_MAX_ROWS,
	PROJECTION_SNAPSHOT_MAX_BYTES,
	type ProjectionPrincipal,
	type ProjectionRequest,
} from "./embedding-projection-contract";

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
			agent_id TEXT, project TEXT, visibility TEXT DEFAULT 'private', is_deleted INTEGER DEFAULT 0, superseded_by TEXT, stale_at TEXT
		);
		CREATE TABLE embeddings (source_type TEXT, source_id TEXT, vector BLOB, dimensions INTEGER);
	`);
	const vector = vectorBytes(768);
	const content = "a".repeat(1_000);
	db.query(
		"INSERT INTO memories (id, content, who, importance, type, tags, pinned, source_type, source_id, created_at, agent_id, project, is_deleted, superseded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)",
	).run(
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
	db.query(
		"INSERT INTO memories (id, content, who, importance, type, tags, pinned, source_type, source_id, created_at, agent_id, project, is_deleted, superseded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)",
	).run(
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

test("applies the row cap and deterministic recency sampling contract", () => {
	const directory = mkdtempSync(join(tmpdir(), "signet-projection-sampling-test-"));
	directories.push(directory);
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE memories (
			id TEXT PRIMARY KEY, content TEXT, who TEXT, importance REAL, type TEXT, tags TEXT,
			pinned INTEGER, source_type TEXT, source_id TEXT, created_at TEXT,
			agent_id TEXT, project TEXT, visibility TEXT DEFAULT 'private', is_deleted INTEGER DEFAULT 0, superseded_by TEXT, stale_at TEXT
		);
		CREATE TABLE embeddings (source_type TEXT, source_id TEXT, vector BLOB, dimensions INTEGER);
	`);
	const vector = vectorBytes(64);
	const insertMemory = db.query(
		"INSERT INTO memories (id, content, pinned, source_type, source_id, created_at, agent_id, project, is_deleted, superseded_by) VALUES (?, ?, 0, 'memory', ?, ?, 'agent-a', 'project-a', 0, NULL)",
	);
	const insertEmbedding = db.query("INSERT INTO embeddings VALUES ('memory', ?, ?, 64)");
	for (let index = 0; index <= PROJECTION_MAX_ROWS; index += 1) {
		const id = `row-${String(index).padStart(4, "0")}`;
		insertMemory.run(id, id, id, "2026-01-01T00:00:00.000Z");
		insertEmbedding.run(id, vector);
	}

	const principal: ProjectionPrincipal = { agentId: "agent-a", project: "project-a" };
	const first = createProjectionSnapshotArtifact(db, principal, request(), directory);
	const second = createProjectionSnapshotArtifact(db, principal, request(), directory);
	const firstRows = (JSON.parse(readFileSync(first.path, "utf8")) as { rows: Array<{ id: string }> }).rows;
	const secondRows = (JSON.parse(readFileSync(second.path, "utf8")) as { rows: Array<{ id: string }> }).rows;

	expect(first.total).toBe(PROJECTION_MAX_ROWS + 1);
	expect(first.count).toBe(PROJECTION_MAX_ROWS);
	expect(first.limit).toBe(PROJECTION_MAX_ROWS);
	expect(first.hasMore).toBe(true);
	expect(first.sampled).toBe(true);
	expect(first.sizeBytes).toBeLessThanOrEqual(PROJECTION_SNAPSHOT_MAX_BYTES);
	expect(firstRows.map((row) => row.id)).toEqual(secondRows.map((row) => row.id));
	expect(firstRows[0]?.id).toBe("row-1000");
	expect(firstRows.at(-1)?.id).toBe("row-0001");

	const tail = createProjectionSnapshotArtifact(
		db,
		principal,
		{ ...request(), offset: PROJECTION_MAX_ROWS },
		directory,
	);
	const tailRows = (JSON.parse(readFileSync(tail.path, "utf8")) as { rows: Array<{ id: string }> }).rows;
	expect(tail.count).toBe(1);
	expect(tail.hasMore).toBe(false);
	expect(tail.sampled).toBe(false);
	expect(tailRows[0]?.id).toBe("row-0000");
	db.close();
});

test("excludes archived and stale memories from the projection snapshot lifecycle scope", () => {
	const directory = mkdtempSync(join(tmpdir(), "signet-projection-lifecycle-test-"));
	directories.push(directory);
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE memories (
			id TEXT PRIMARY KEY, content TEXT, who TEXT, importance REAL, type TEXT, tags TEXT,
			pinned INTEGER, source_type TEXT, source_id TEXT, created_at TEXT, visibility TEXT,
			agent_id TEXT, project TEXT, is_deleted INTEGER DEFAULT 0, superseded_by TEXT, stale_at TEXT
		);
		CREATE TABLE embeddings (source_type TEXT, source_id TEXT, vector BLOB, dimensions INTEGER);
	`);
	const insertMemory = db.prepare(
		"INSERT INTO memories (id, content, created_at, visibility, agent_id, project, stale_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	const insertEmbedding = db.prepare(
		"INSERT INTO embeddings (source_type, source_id, vector, dimensions) VALUES ('memory', ?, ?, 2)",
	);
	const vector = vectorBytes(2);
	for (const [id, visibility, staleAt] of [
		["active", "private", null],
		["archived", "archived", null],
		["stale", "private", "2026-08-30T00:00:00.000Z"],
	] as const) {
		insertMemory.run(id, id, "2026-08-31T00:00:00.000Z", visibility, "agent-a", null, staleAt);
		insertEmbedding.run(id, vector);
	}

	const descriptor = createProjectionSnapshotArtifact(
		db,
		{ agentId: "agent-a", project: null },
		{ dimensions: 2, limit: 100, offset: 0, filters: {} },
		directory,
	);
	const wire = JSON.parse(readFileSync(descriptor.path, "utf8")) as { rows: Array<{ id: string }> };

	expect(descriptor.total).toBe(1);
	expect(wire.rows.map((row) => row.id)).toEqual(["active"]);
	db.close();
});
