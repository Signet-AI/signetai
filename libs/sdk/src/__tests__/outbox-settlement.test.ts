import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DurableOutbox } from "../node.js";
import { SignetCredentialError } from "../errors.js";
import { withFileLock } from "../node/storage.js";

test("failed settlement cannot replace a terminal credential error", async () => {
	const home = await mkdtemp(join(tmpdir(), "sdk-settlement-error-"));
	const box = new DurableOutbox("https://remote.example", { env: { HOME: home } });
	let release: () => void = () => {};
	let entered: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let holder = Promise.resolve();
	const failure = new SignetCredentialError(new Error("Provider unavailable"));
	try {
		await expect(
			box.deliver(
				{ method: "POST", path: "/api/hooks/session-end", body: {} },
				async () => {
					holder = withFileLock(join(box.directory, ".lock"), async () => {
						entered();
						await gate;
					});
					await ready;
					throw failure;
				},
				{ timeoutMs: 250 },
			),
		).rejects.toBe(failure);
	} finally {
		release();
		await holder;
		await rm(home, { force: true, recursive: true });
	}
});

for (const operation of ["flush", "deliver"] as const) {
	test(`cancelled ${operation} does not wait for a contended settlement lock`, async () => {
		const home = await mkdtemp(join(tmpdir(), "sdk-settlement-"));
		const box = new DurableOutbox("https://remote.example", { env: { HOME: home } });
		const controller = new AbortController();
		let release: () => void = () => {};
		let entered: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let holder: Promise<void> = Promise.resolve();
		let abortedAt = 0;
		const request = { method: "POST", path: "/api/hooks/session-end", body: { durable: true } };
		const send = async () => {
			holder = withFileLock(join(box.directory, ".lock"), async () => {
				entered();
				await gate;
			});
			await ready;
			abortedAt = performance.now();
			controller.abort(new Error("cancelled"));
			throw controller.signal.reason;
		};
		const timer = setTimeout(release, 500);
		try {
			if (operation === "flush") {
				await box.enqueue(request);
				expect(await box.flush(send, { signal: controller.signal, force: true })).toMatchObject({ state: "failed" });
			} else {
				await expect(box.deliver(request, send, { signal: controller.signal })).rejects.toThrow("cancelled");
			}
			expect(performance.now() - abortedAt).toBeLessThan(150);
			expect((await readdir(join(box.directory, ".claims"))).filter((name) => name.endsWith(".json"))).toHaveLength(1);
		} finally {
			clearTimeout(timer);
			release();
			await holder;
			await rm(home, { force: true, recursive: true });
		}
	});
}
