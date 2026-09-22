import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startManualInboxWorker, type ManualInboxAdmission, type ManualInboxRow } from "./manual-inbox-worker";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
async function root() {
	const r = await mkdtemp(join(tmpdir(), "signet-manual-inbox-"));
	roots.push(r);
	return r;
}
function admission(): ManualInboxAdmission & { rows: Map<string, ManualInboxRow>; calls: string[]; enabled: boolean } {
	const rows = new Map();
	const calls: string[] = [];
	return {
		rows,
		calls,
		enabled: false,
		async isEnabled() {
			return this.enabled;
		},
		async enable() {
			this.enabled = true;
		},
		async claim(input) {
			calls.push(`claim:${input.fileName}`);
			const row = {
				key: input.key,
				fileName: input.fileName,
				originalPath: input.originalPath,
				bytes: input.bytes,
				status: "processing" as const,
			};
			this.rows.set(input.key, row);
			return row;
		},
		async record(row) {
			this.rows.set(row.key, row);
		},
	};
}

describe("manual inbox worker", () => {
	test("does not ingest pre-existing files until explicitly enabled", async () => {
		const r = await root();
		await Bun.write(join(r, "files", "old.md"), "old");
		const a = admission();
		const w = startManualInboxWorker({ root: r, admission: a, pollMs: 10 });
		await w.nudge();
		await new Promise((x) => setTimeout(x, 30));
		await w.stop();
		expect(a.calls).toEqual([]);
		expect(await Bun.file(join(r, "files", "old.md")).exists()).toBe(true);
	});
	test("enables a fresh empty inbox and dispatches documents with durable claim before removal", async () => {
		const r = await root();
		const a = admission();
		const dispatched: string[] = [];
		const w = startManualInboxWorker({
			root: r,
			admission: a,
			pollMs: 10,
			settleMs: 0,
			dispatchDocument: async (row) => {
				dispatched.push(row.fileName);
				if (!row.bytes) throw new Error("expected retained bytes");
				expect(new TextDecoder().decode(row.bytes)).toBe("hello");
				return { status: "imported", sourceId: "import:note" };
			},
		});
		await new Promise((x) => setTimeout(x, 20));
		await Bun.write(join(r, "files", "note.md"), "hello");
		await w.nudge();
		await new Promise((x) => setTimeout(x, 50));
		await w.stop();
		expect(dispatched).toEqual(["note.md"]);
		expect(a.calls).toEqual(["claim:note.md"]);
		expect(await Bun.file(join(r, "files", "note.md")).exists()).toBe(false);
		expect([...a.rows.values()][0]).toMatchObject({ status: "imported", sourceId: "import:note" });
	});
	test("keeps a claimed inbox file retryable when document dispatch fails", async () => {
		const r = await root();
		const a = admission();
		const w = startManualInboxWorker({
			root: r,
			admission: a,
			pollMs: 1000,
			settleMs: 0,
			dispatchDocument: async () => {
				throw new Error("index unavailable");
			},
		});
		await new Promise((x) => setTimeout(x, 20));
		await Bun.write(join(r, "files", "retry.md"), "retry");
		w.nudge();
		await new Promise((x) => setTimeout(x, 40));
		await w.stop();
		expect(await Bun.file(join(r, "files", "retry.md")).exists()).toBe(true);
		expect([...a.rows.values()][0]).toMatchObject({ status: "failed", error: "index unavailable" });
	});
	test("keeps incomplete temporary files untouched", async () => {
		const r = await root();
		const a = admission();
		await Bun.write(join(r, "files", "x.md.part"), "x");
		const w = startManualInboxWorker({ root: r, admission: a, pollMs: 10 });
		await w.nudge();
		await new Promise((x) => setTimeout(x, 20));
		await w.stop();
		expect(a.calls).toEqual([]);
		expect(await Bun.file(join(r, "files", "x.md.part")).exists()).toBe(true);
	});
});
