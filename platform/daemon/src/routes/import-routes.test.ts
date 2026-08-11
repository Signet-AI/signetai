import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSourcesConfig } from "@signet/core";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { IMPORT_MAX_BATCH_BYTES } from "../import-normalizer";
import { purgeSourceArtifactStructureInTx } from "../source-artifact-graph";
import { registerImportRoutes } from "./import-routes";

function formWithFile(file: File, duplicateMode = "skip"): FormData {
	const form = new FormData();
	form.append("files", file);
	form.set("duplicateMode", duplicateMode);
	return form;
}

describe("import routes", () => {
	let dir = "";
	let previousPath: string | undefined;
	let previousAgentId: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-import-routes-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		previousPath = process.env.SIGNET_PATH;
		previousAgentId = process.env.SIGNET_AGENT_ID;
		process.env.SIGNET_PATH = dir;
		process.env.SIGNET_AGENT_ID = "import-test-agent";
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (previousPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousPath;
		if (previousAgentId === undefined) Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		else process.env.SIGNET_AGENT_ID = previousAgentId;
		rmSync(dir, { recursive: true, force: true });
	});

	function app(): Hono {
		const instance = new Hono();
		registerImportRoutes(instance);
		return instance;
	}

	it("imports a JSON file and records durable source metadata", async () => {
		const response = await app().request("/api/sources/import", {
			method: "POST",
			body: formWithFile(
				new File(['{"messages":[{"role":"user","content":"hello"}]}'], "export.json", { type: "application/json" }),
			),
		});

		expect(response.status).toBe(201);
		const body = (await response.json()) as {
			imported: number;
			failed: number;
			files: Array<{
				status: string;
				sourceId?: string;
				extraction?: { documentEntityId: string | null; aspectsCreated: number; attributesCreated: number };
			}>;
		};
		expect(body.imported).toBe(1);
		expect(body.failed).toBe(0);
		expect(body.files[0]?.status).toBe("imported");
		expect(body.files[0]?.extraction).toEqual({
			documentEntityId: expect.any(String),
			aspectsCreated: expect.any(Number),
			attributesCreated: expect.any(Number),
		});
		expect(body.files[0]?.extraction?.aspectsCreated).toBeGreaterThan(0);
		expect(body.files[0]?.extraction?.attributesCreated).toBeGreaterThan(0);
		expect(loadSourcesConfig(dir).sources[0]?.kind).toBe("import");
		expect(loadSourcesConfig(dir).sources[0]?.providerSettings?.format).toBe("json");
		const artifacts = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT source_kind, source_path, source_meta_json FROM memory_artifacts ORDER BY source_path")
					.all() as Array<{ source_kind: string; source_path: string; source_meta_json: string }>,
		);
		expect(artifacts.map((row) => row.source_kind).sort()).toEqual(
			["source_import_json_canonical", "source_import_json_projection"].sort(),
		);
		const canonical = artifacts.find((row) => row.source_kind === "source_import_json_canonical");
		expect(JSON.parse(canonical?.source_meta_json ?? "{}")).toMatchObject({
			representation: "structured-json-canonical",
		});
		const projection = artifacts.find((row) => row.source_kind === "source_import_json_projection");
		expect(JSON.parse(projection?.source_meta_json ?? "{}")).toMatchObject({
			importExtraction: body.files[0]?.extraction,
		});
		const attention = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT subject_ref, kind FROM dreaming_attention").all() as Array<{
					subject_ref: string;
					kind: string;
				}>,
		);
		expect(attention).toContainEqual({ subject_ref: `source:${body.files[0]?.sourceId}`, kind: "hygiene" });
	});

	it("imports a selected local filesystem path and rejects remote path acquisition", async () => {
		const path = join(dir, "selected.json");
		writeFileSync(path, '{"selected":true}');
		const localForm = new FormData();
		localForm.append("paths", path);
		const localResponse = await app().request(
			"http://localhost/api/sources/import",
			{
				method: "POST",
				body: localForm,
			},
			{ incoming: { socket: { remoteAddress: "127.0.0.1" } } },
		);
		expect(localResponse.status).toBe(201);
		expect((await localResponse.json()).imported).toBe(1);

		const remoteForm = new FormData();
		remoteForm.append("paths", path);
		const remoteResponse = await app().request("https://remote.example/api/sources/import", {
			method: "POST",
			body: remoteForm,
		});
		expect(remoteResponse.status).toBe(400);
		expect(await remoteResponse.json()).toEqual({
			error: "Filesystem path imports are only available on a local daemon",
		});
	});

	it("reports duplicates without creating a second source", async () => {
		const file = new File(["name,email\nAda,ada@example.com\n"], "contacts.csv", { type: "text/csv" });
		const first = await app().request("/api/sources/import", { method: "POST", body: formWithFile(file) });
		const second = await app().request("/api/sources/import", {
			method: "POST",
			body: formWithFile(new File(["name,email\nAda,ada@example.com\n"], "contacts.csv", { type: "text/csv" })),
		});

		expect(first.status).toBe(201);
		const chunks = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT source_kind, source_meta_json FROM memory_artifacts WHERE source_kind = ?")
					.all("source_import_csv_chunk") as Array<{ source_kind: string; source_meta_json: string }>,
		);
		expect(chunks).toHaveLength(1);
		expect(JSON.parse(chunks[0]?.source_meta_json ?? "{}")).toMatchObject({
			representation: "table-row-range",
			rowStart: 1,
			rowEnd: 1,
		});
		expect(second.status).toBe(201);
		const body = (await second.json()) as {
			imported: number;
			failed: number;
			files: Array<{ fileName: string; status: string; sourceId: string }>;
		};
		expect(body).toMatchObject({
			imported: 0,
			failed: 0,
			files: [
				{
					fileName: "contacts.csv",
					status: "duplicate",
					sourceId: expect.any(String),
					extraction: {
						documentEntityId: expect.any(String),
						aspectsCreated: expect.any(Number),
						attributesCreated: expect.any(Number),
					},
				},
			],
		});
		expect(loadSourcesConfig(dir).sources).toHaveLength(1);
	});

	it("retries a default-skip duplicate after a crash leaves its artifact without a completion marker across restart", async () => {
		const content = "name,email\nAda,ada@example.com\n";
		const fileName = "contacts.csv";
		const first = await app().request("/api/sources/import", {
			method: "POST",
			body: formWithFile(new File([content], fileName, { type: "text/csv" })),
		});
		const firstBody = (await first.json()) as { files: Array<{ sourceId: string }> };
		const sourceId = firstBody.files[0]?.sourceId;
		const sourcePath = `imports/${sourceId}/${fileName}`;
		expect(first.status).toBe(201);
		expect(sourceId).toEqual(expect.any(String));

		getDbAccessor().withWriteTx((db) => {
			purgeSourceArtifactStructureInTx(db, {
				agentId: "import-test-agent",
				sourceId: sourceId ?? "",
				sourcePath,
			});
			const artifact = db
				.prepare(
					"SELECT source_meta_json FROM memory_artifacts WHERE agent_id = ? AND source_id = ? AND source_path = ?",
				)
				.get("import-test-agent", sourceId, sourcePath) as { source_meta_json: string | null };
			const { importExtraction: _, ...sourceMeta } = JSON.parse(artifact.source_meta_json ?? "{}") as Record<
				string,
				unknown
			>;
			db.prepare(
				"UPDATE memory_artifacts SET source_meta_json = ? WHERE agent_id = ? AND source_id = ? AND source_path = ?",
			).run(JSON.stringify(sourceMeta), "import-test-agent", sourceId, sourcePath);
		});
		const config = loadSourcesConfig(dir);
		writeFileSync(
			join(dir, "sources.json"),
			`${JSON.stringify({
				...config,
				sources: config.sources.map((source) => {
					const { lastIndexedAt: _, ...incomplete } = source;
					return incomplete;
				}),
			})}\n`,
		);
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));

		const retry = await app().request("/api/sources/import", {
			method: "POST",
			body: formWithFile(new File([content], fileName, { type: "text/csv" })),
		});

		expect(retry.status).toBe(201);
		expect(await retry.json()).toMatchObject({
			imported: 1,
			failed: 0,
			files: [{ fileName, status: "imported", sourceId, duplicate: true }],
		});
		expect(loadSourcesConfig(dir).sources).toEqual([
			expect.objectContaining({ id: sourceId, lastIndexedAt: expect.any(String) }),
		]);
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					(
						db
							.prepare("SELECT COUNT(*) AS count FROM memory_artifacts WHERE agent_id = ? AND source_id = ?")
							.get("import-test-agent", sourceId) as { count: number }
					).count,
			),
		).toBe(2);
	});

	it("indexes an existing duplicate for a different agent scope", async () => {
		const content = "name,email\nAda,ada@example.com\n";
		const first = await app().request("/api/sources/import", {
			method: "POST",
			body: formWithFile(new File([content], "contacts.csv", { type: "text/csv" })),
		});
		process.env.SIGNET_AGENT_ID = "second-import-test-agent";
		const second = await app().request("/api/sources/import", {
			method: "POST",
			body: formWithFile(new File([content], "contacts.csv", { type: "text/csv" })),
		});

		expect(first.status).toBe(201);
		expect(second.status).toBe(201);
		expect(await second.json()).toMatchObject({
			imported: 1,
			failed: 0,
			files: [{ fileName: "contacts.csv", status: "imported", duplicate: false }],
		});
		expect(loadSourcesConfig(dir).sources).toHaveLength(2);
	});

	it("does not replace another agent's imported source", async () => {
		const content = "name,email\nAda,ada@example.com\n";
		const first = await app().request("/api/sources/import", {
			method: "POST",
			body: formWithFile(new File([content], "old-name.csv", { type: "text/csv" })),
		});
		const firstBody = (await first.json()) as { files: Array<{ sourceId: string }> };
		process.env.SIGNET_AGENT_ID = "second-import-test-agent";
		const second = await app().request("/api/sources/import", {
			method: "POST",
			body: formWithFile(new File([content], "new-name.csv", { type: "text/csv" }), "replace"),
		});
		const secondBody = (await second.json()) as {
			imported: number;
			failed: number;
			files: Array<{ status: string; duplicate: boolean; sourceId: string }>;
		};

		expect(first.status).toBe(201);
		expect(second.status).toBe(201);
		expect(secondBody).toMatchObject({
			imported: 1,
			failed: 0,
			files: [{ status: "imported", duplicate: false }],
		});
		expect(secondBody.files[0]?.sourceId).not.toBe(firstBody.files[0]?.sourceId);
		expect(loadSourcesConfig(dir).sources).toHaveLength(2);
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT COUNT(*) AS count FROM memory_artifacts WHERE agent_id = ? AND source_id = ?")
						.get("import-test-agent", firstBody.files[0]?.sourceId) as { count: number },
			).count,
		).toBeGreaterThan(0);
	});

	it("stages replacement before removing the old source", async () => {
		const content = "name,email\nAda,ada@example.com\n";
		const first = await app().request("/api/sources/import", {
			method: "POST",
			body: formWithFile(new File([content], "old-name.csv", { type: "text/csv" })),
		});
		const second = await app().request("/api/sources/import", {
			method: "POST",
			body: formWithFile(new File([content], "new-name.csv", { type: "text/csv" }), "replace"),
		});

		expect(first.status).toBe(201);
		const firstBody = (await first.json()) as { files: Array<{ sourceId: string }> };
		expect(second.status).toBe(201);
		expect(await second.json()).toMatchObject({
			imported: 1,
			failed: 0,
			files: [{ fileName: "new-name.csv", status: "imported", duplicate: true }],
		});
		const lifecycle = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT status, reason FROM imported_source_lifecycle WHERE source_id = ?")
					.all(firstBody.files[0]?.sourceId) as Array<{
					status: string;
					reason: string;
				}>,
		);
		expect(lifecycle).toEqual([{ status: "unsupported", reason: "imported source replaced" }]);
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT COUNT(*) AS count FROM memory_artifacts WHERE source_id = ?")
						.get(firstBody.files[0]?.sourceId) as {
						count: number;
					},
			).count,
		).toBe(0);
		expect(loadSourcesConfig(dir).sources).toMatchObject([
			{ kind: "import", providerSettings: { fileName: "new-name.csv" } },
		]);
		expect(loadSourcesConfig(dir).sources).toHaveLength(1);
	});

	it("rejects a batch that exceeds the file-count boundary", async () => {
		const form = new FormData();
		for (let index = 0; index < 26; index++)
			form.append("files", new File(["x"], `file-${index}.txt`, { type: "text/plain" }));
		const response = await app().request("/api/sources/import", { method: "POST", body: form });

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "Import accepts at most 25 files" });
	});

	it("rejects oversized chunked request bodies before form-data buffering", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(IMPORT_MAX_BATCH_BYTES + 1 * 1024 * 1024 + 1));
				controller.close();
			},
		});
		const request = new Request("http://localhost/api/sources/import", {
			method: "POST",
			headers: { "Content-Type": "multipart/form-data; boundary=import-test" },
			body,
			duplex: "half",
		} as RequestInit & { duplex: "half" });

		const response = await app().request(request);

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "Import batch exceeds the 104857600 byte limit" });
	});
});
