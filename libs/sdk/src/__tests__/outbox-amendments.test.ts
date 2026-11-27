import "../../../../tests/support/connector-safety.js";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, stat, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DurableOutbox, NodeTransport } from "../node.js";
import { SignetForbiddenError } from "../errors.js";

async function fixture(run: (home: string) => Promise<void>) {
	const home = await mkdtemp(join(tmpdir(), "sdk-amended-outbox-"));
	try {
		await run(home);
	} finally {
		await rm(home, { force: true, recursive: true });
	}
}
const request = {
	method: "POST",
	path: "/api/hooks/session-end",
	body: { agentId: "original", reason: "session_shutdown" },
};
test("outbox partitions the same origin by harness", async () =>
	fixture(async (home) => {
		const a = new NodeTransport(
			{
				url: "https://remote.example",
				origin: "https://remote.example",
				harness: "hermes",
				remote: true,
				credential: { source: "none", get: async () => null },
			},
			{ env: { HOME: home } },
		);
		const b = new NodeTransport(
			{
				url: "https://remote.example",
				origin: "https://remote.example",
				harness: "claude",
				remote: true,
				credential: { source: "none", get: async () => null },
			},
			{ env: { HOME: home } },
		);
		await a.outbox.enqueue(request);
		expect(a.outbox.directory).not.toBe(b.outbox.directory);
		expect((await b.outbox.status()).pending).toBe(0);
	}));
test("403 scope denial quarantines evidence instead of dropping", async () =>
	fixture(async (home) => {
		const box = new DurableOutbox("https://remote.example", { env: { HOME: home } });
		await box.enqueue(request);
		await box.flush(
			async () => {
				throw new SignetForbiddenError("agent_not_permitted");
			},
			{ force: true },
		);
		expect(await box.status()).toMatchObject({ pending: 0, quarantined: 1, dropped: 0 });
		await box.purge();
		expect(await box.status()).toMatchObject({ pending: 0, quarantined: 0 });
	}));
test("healthy GET does not create an outbox", async () =>
	fixture(async (home) => {
		const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
		const url = `http://127.0.0.1:${server.port}`;
		try {
			const client = new NodeTransport(
				{ url, origin: url, remote: false, credential: { source: "flag", get: async () => "fixture" } },
				{ env: { HOME: home } },
			);
			await client.get("/health");
			expect(
				await stat(join(home, ".config")).then(
					() => true,
					() => false,
				),
			).toBe(false);
		} finally {
			server.stop(true);
		}
	}));
test("empty explicit flush does not create a lock or directories", async () =>
	fixture(async (home) => {
		const box = new DurableOutbox("https://remote.example", { env: { HOME: home } });
		expect(
			await box.flush(async () => {
				throw new Error("not empty");
			}),
		).toMatchObject({ state: "complete", pending: 0 });
		expect(
			await stat(box.directory).then(
				() => true,
				() => false,
			),
		).toBe(false);
	}));
test("network send releases the outbox lock before enqueue", async () =>
	fixture(async (home) => {
		const box = new DurableOutbox("https://remote.example", { env: { HOME: home } });
		await box.enqueue(request);
		let enter: () => void = () => {};
		let release: () => void = () => {};
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const flush = box.flush(
			async () => {
				enter();
				await gate;
			},
			{ force: true },
		);
		await entered;
		try {
			await box.enqueue({ ...request, body: { second: true } }, { timeoutMs: 200 });
		} finally {
			release();
			await flush;
		}
		expect((await box.status()).pending).toBe(1);
	}));
for (const kind of ["attempts", "age"])
	test(`poison ${kind} quarantines without dispatch`, async () =>
		fixture(async (home) => {
			const box = new DurableOutbox("https://remote.example", { env: { HOME: home } });
			const entry = await box.enqueue(request);
			await writeFile(
				join(box.directory, `${entry.id}.json`),
				JSON.stringify({
					...entry,
					attempts: kind === "attempts" ? 20 : 0,
					createdAt: kind === "age" ? "2020-01-01T00:00:00Z" : entry.createdAt,
				}),
				{ mode: 0o600 },
			);
			let calls = 0;
			await box.flush(
				async () => {
					calls++;
				},
				{ force: true },
			);
			expect(calls).toBe(0);
			expect(await box.status()).toMatchObject({ pending: 0, quarantined: 1 });
		}));
for (const kind of ["parse", "version", "mode", "origin", "headers"])
	test(`bad ${kind} file quarantines and remains purgeable`, async () =>
		fixture(async (home) => {
			const box = new DurableOutbox("https://remote.example", { env: { HOME: home } });
			const entry = await box.enqueue(request);
			await writeFile(
				join(box.directory, `${entry.id}.json`),
				kind === "parse"
					? "{"
					: JSON.stringify({
							...entry,
							version: kind === "version" ? 999 : 1,
							origin: kind === "origin" ? "file:///invalid" : entry.origin,
							headers: kind === "headers" ? { unsupported: "value" } : entry.headers,
						}),
				{ mode: 0o600 },
			);
			if (kind === "mode")
				await import("node:fs/promises").then((fs) => fs.chmod(join(box.directory, `${entry.id}.json`), 0o644));
			let calls = 0;
			await box.flush(
				async () => {
					calls++;
				},
				{ force: true },
			);
			expect(calls).toBe(0);
			expect(await box.status()).toMatchObject({ quarantined: 1 });
			await box.purge();
			expect((await box.status()).quarantined).toBe(0);
		}));
test("purge scans malformed records without parsing them", async () =>
	fixture(async (home) => {
		const box = new DurableOutbox("https://remote.example", { env: { HOME: home } });
		const entry = await box.enqueue(request);
		await writeFile(join(box.directory, `${entry.id}.json`), "{", { mode: 0o600 });
		await box.purge();
		expect((await box.status()).pending).toBe(0);
	}));
test("stale temporary files are reaped under the lock", async () =>
	fixture(async (home) => {
		const box = new DurableOutbox("https://remote.example", { env: { HOME: home } });
		await box.enqueue(request);
		const path = join(box.directory, `${randomUUID()}.tmp`);
		await writeFile(path, "temporary", { mode: 0o600 });
		await utimes(path, 0, 0);
		await box.entries();
		expect(await readdir(box.directory)).not.toContain(path.split("/").at(-1));
	}));

test("only a transport for the captured harness can replay", async () =>
	fixture(async (home) => {
		let sent = 0;
		const server = Bun.serve({
			port: 0,
			fetch: (req) => {
				if (req.method === "POST" && new URL(req.url).pathname === request.path) sent++;
				return Response.json({ ok: true });
			},
		});
		const url = `http://127.0.0.1:${server.port}`;
		try {
			const credential = { source: "flag" as const, get: async () => "fixture" };
			const original = new NodeTransport(
				{ url, origin: url, remote: false, harness: "hermes", credential },
				{ env: { HOME: home } },
			);
			const other = new NodeTransport(
				{ url, origin: url, remote: false, harness: "claude", credential },
				{ env: { HOME: home } },
			);
			await original.outbox.enqueue(request);
			await other.flush({ force: true });
			expect(sent).toBe(0);
			expect((await original.outbox.status()).pending).toBe(1);
			await original.flush({ force: true });
			expect(sent).toBe(1);
			expect((await original.outbox.status()).pending).toBe(0);
		} finally {
			server.stop(true);
		}
	}));
