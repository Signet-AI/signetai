import "../../../../tests/support/connector-safety.js";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DurableOutbox } from "../node.js";

test("legacy evidence is visible but needs explicit harness attribution", async () => {
	const home = await mkdtemp(join(tmpdir(), "sdk-legacy-"));
	const box = new DurableOutbox("https://remote.example", { env: { HOME: home }, harness: "hermes" });
	const root = dirname(box.directory);
	const legacy = {
		origin: box.origin,
		id: randomUUID(),
		idempotencyKey: randomUUID(),
		method: "POST",
		path: "/api/hooks/session-end",
		body: { original: true },
		headers: { "x-signet-agent-id": "original" },
		createdAt: new Date().toISOString(),
		attempts: 2,
		lastError: "http_401",
	};
	try {
		await mkdir(root, { recursive: true, mode: 0o700 });
		await writeFile(join(root, `${legacy.id}.json`), JSON.stringify(legacy), { mode: 0o600 });
		const status = await box.status();
		expect(status).toMatchObject({ pending: 0, quarantined: 1 });
		const quarantined = status.quarantine.find((item) => item.reason === "legacy_unattributed");
		expect(quarantined).toBeDefined();
		const file = quarantined?.file ?? "missing";
		let sent = 0;
		await box.flush(
			async () => {
				sent++;
			},
			{ force: true },
		);
		expect(sent).toBe(0);
		await expect(box.recoverLegacy(file, "claude")).rejects.toThrow("harness");
		await box.recoverLegacy(file, "hermes");
		expect(await box.entries()).toEqual([{ ...legacy, version: 1, harness: "hermes" }]);
		expect(
			(
				await box.flush(
					async (entry) => {
						expect(entry.idempotencyKey).toBe(legacy.idempotencyKey);
						expect(entry.headers).toEqual(legacy.headers);
						sent++;
					},
					{ force: true },
				)
			).state,
		).toBe("complete");
		expect(sent).toBe(1);
	} finally {
		await rm(home, { force: true, recursive: true });
	}
});

test("purge of shared legacy evidence requires explicit opt in", async () => {
	const home = await mkdtemp(join(tmpdir(), "sdk-legacy-purge-"));
	const box = new DurableOutbox("https://remote.example", { env: { HOME: home }, harness: "hermes" });
	try {
		await mkdir(dirname(box.directory), { recursive: true, mode: 0o700 });
		await writeFile(join(dirname(box.directory), `${randomUUID()}.json`), "{", { mode: 0o600 });
		await box.status();
		await box.purge();
		expect((await box.status()).quarantined).toBe(1);
		await box.purge({ includeLegacy: true });
		expect((await box.status()).quarantined).toBe(0);
	} finally {
		await rm(home, { force: true, recursive: true });
	}
});
