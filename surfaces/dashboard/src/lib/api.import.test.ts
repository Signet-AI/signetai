import { afterEach, expect, test, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { api } from "./api";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

for (const scenario of ["deadline", "lost-ack", "network", "exhausted", "denied", "generation"] as const) {
	test(`dashboard upload retries reconcile durable state: ${scenario}`, async () => {
		const bytes = Buffer.alloc(64 * 1024, 97);
		const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
		let patches = 0,
			reads = 0,
			finalized = false;
		const mocked = spyOn(globalThis, "fetch").mockImplementation((async (_path, opts) => {
			if (opts?.method === "POST") {
				finalized = true;
				return Response.json({});
			}
			if (opts?.method === "PATCH") {
				patches++;
				expect(new Headers(opts.headers).get("upload-offset")).toBe("0");
				expect(Buffer.from(opts.body as ArrayBuffer)).toEqual(bytes);
				if (patches === 1 && scenario === "network") throw new TypeError("connection closed");
				return patches === 1 || scenario === "exhausted"
					? Response.json({ error: "DB_OWNER_DEADLINE" }, { status: scenario === "denied" ? 403 : 503 })
					: Response.json({ offset: bytes.length });
			}
			reads++;
			return Response.json({
				files: [
					{
						id: "file",
						state: "staging",
						upload_size: bytes.length,
						upload_generation: reads > 1 && scenario === "generation" ? 1 : 0,
						upload_offset: reads > 1 && scenario === "lost-ack" ? bytes.length : 0,
						upload_digest: reads > 1 && scenario === "lost-ack" ? hash(`:${hash(bytes)}:${bytes.length}`) : "",
					},
				],
			});
		}) as typeof fetch);
		restore = () => mocked.mockRestore();
		const result = await api.uploadSourceImportFile("a", "job", "file", new File([bytes], "upload.jsonl"));
		expect(finalized).toBe(["deadline", "lost-ack", "network"].includes(scenario));
		expect(result.error === null).toBe(finalized);
		expect(patches).toBe(scenario === "exhausted" ? 4 : finalized ? 2 : 1);
		expect(reads).toBe(scenario === "exhausted" ? 4 : scenario === "denied" ? 1 : 2);
	});
}

test("dashboard retries finalization after a transient owner failure", async () => {
	const bytes = Buffer.alloc(64 * 1024, 97);
	let reads = 0,
		finalizations = 0;
	const mocked = spyOn(globalThis, "fetch").mockImplementation((async (_path, opts) => {
		if (opts?.method === "PATCH") return Response.json({ offset: bytes.length });
		if (opts?.method === "POST") {
			finalizations++;
			return finalizations === 1
				? Response.json({ error: "DB_OWNER_DEADLINE" }, { status: 503 })
				: Response.json({ state: "ready" });
		}
		reads++;
		return Response.json({
			files: [
				{
					id: "file",
					state: "staging",
					upload_size: bytes.length,
					upload_generation: 0,
					upload_offset: reads > 1 ? bytes.length : 0,
					upload_digest: "",
				},
			],
		});
	}) as typeof fetch);
	restore = () => mocked.mockRestore();
	const result = await api.uploadSourceImportFile("a", "job", "file", new File([bytes], "upload.jsonl"));
	expect(result.error).toBeNull();
	expect(reads).toBe(2);
	expect(finalizations).toBe(2);
});

test("dashboard retries transient reconciliation status reads", async () => {
	const bytes = Buffer.alloc(64 * 1024, 97);
	let reads = 0,
		patches = 0;
	const mocked = spyOn(globalThis, "fetch").mockImplementation((async (_path, opts) => {
		if (opts?.method === "PATCH") {
			patches++;
			return patches === 1
				? Response.json({ error: "DB_OWNER_DEADLINE" }, { status: 503 })
				: Response.json({ offset: bytes.length });
		}
		if (opts?.method === "POST") return Response.json({ state: "ready" });
		reads++;
		if (reads === 2) return Response.json({ error: "busy" }, { status: 503 });
		return Response.json({
			files: [
				{
					id: "file",
					state: "staging",
					upload_size: bytes.length,
					upload_generation: 0,
					upload_offset: 0,
					upload_digest: "",
				},
			],
		});
	}) as typeof fetch);
	restore = () => mocked.mockRestore();
	const result = await api.uploadSourceImportFile("a", "job", "file", new File([bytes], "upload.jsonl"));
	expect(result.error).toBeNull();
	expect(reads).toBe(3);
	expect(patches).toBe(2);
});
