import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitImport, scanInbox, type ImportLedger, type ImportRow } from "./import-inbox";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "signet-inbox-"));
	roots.push(root);
	return root;
}
function ledger(): ImportLedger & { rows: Map<string, ImportRow> } {
	const rows = new Map<string, ImportRow>();
	return {
		rows,
		upsert: (row) => {
			rows.set(row.key, row);
			return row;
		},
		find: (key) => rows.get(key),
	};
}

describe("durable import inbox admission", () => {
	test("retains exact bytes and is idempotent for upload retries", async () => {
		const root = await fixture();
		const l = ledger();
		const bytes = new Uint8Array([0, 1, 255, 10]);
		const first = await admitImport({ root, fileName: "note.bin", bytes, ledger: l, idempotencyKey: "k1" });
		const second = await admitImport({ root, fileName: "note.bin", bytes, ledger: l, idempotencyKey: "k1" });
		expect(first).toEqual(second);
		expect(first.status).toBe("pending");
		expect(await Bun.file(first.originalPath).arrayBuffer()).toEqual(bytes.buffer);
	});

	test("bounded scan ignores temp files and rejects symlinks", async () => {
		const root = await fixture();
		const inbox = join(root, "files");
		await Bun.write(join(inbox, ".part"), "x");
		await writeFile(join(inbox, "ok.txt"), "ok");
		await symlink("/etc/passwd", join(inbox, "escape.txt"));
		const result = await scanInbox({ root, ledger: ledger(), maxFiles: 10 });
		expect(result.map((x) => x.status).sort()).toEqual(["pending", "quarantined"].sort());
		expect(result.find((x) => x.status === "pending")?.fileName).toBe("ok.txt");
	});

	test("temp entries do not consume the bounded scan budget", async () => {
		const root = await fixture();
		const inbox = join(root, "files");
		await Bun.write(join(inbox, ".hidden"), "x");
		await Bun.write(join(inbox, "valid.txt"), "ok");
		const result = await scanInbox({ root, ledger: ledger(), maxFiles: 1 });
		expect(result).toHaveLength(1);
		expect(result[0]?.fileName).toBe("valid.txt");
	});
});
