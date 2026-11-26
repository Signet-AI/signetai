import "../../../../tests/support/connector-safety.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { createHookFetch } from "../lib/hook-transport.js";
import {
	ConnectorRegistry,
	DurableOutbox,
	NodeTransport,
	resolveTarget,
	writeKeyFile,
} from "../../../../libs/sdk/src/node.js";

for (const kind of ["oversized", "missing"] as const) {
	test(`remote ${kind} transcript capture retains a retryable file reference`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "transcript-deferred-"));
		const transcriptPath = join(directory, "transcript.jsonl");
		if (kind === "oversized") await writeFile(transcriptPath, "x".repeat(4 * 1024 * 1024 + 1));
		const requests: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				requests.push(new URL(request.url).pathname);
				return Response.json({ ok: true });
			},
		});
		const harness = `test-${crypto.randomUUID()}`;
		const keyFile = await writeKeyFile(server.url.origin, harness, "fixture-credential");
		await new ConnectorRegistry().set(harness, { url: server.url.origin, keyFile });
		try {
			const fetch = await createHookFetch(harness);
			const result = await fetch("/api/hooks/session-end", {
				method: "POST",
				body: JSON.stringify({ harness, sessionKey: "deferred", transcriptPath }),
			});
			expect(result).toMatchObject({ ok: false });
			const box = new DurableOutbox(server.url.origin, { harness });
			expect((await box.status()).pending).toBe(1);
			expect((await box.entries())[0]?.body).toMatchObject({ transcriptPath, sessionKey: "deferred" });
			await new NodeTransport(await resolveTarget({ harness })).flush({ force: true });
			expect((await box.status()).pending).toBe(1);
			expect((await box.entries())[0]?.attempts).toBeGreaterThanOrEqual(2);
			expect(requests).not.toContain("/api/hooks/session-end");
		} finally {
			server.stop(true);
			await new ConnectorRegistry().remove(harness);
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("remote capture errors exit one with JSON reason instead of a crash", async () => {
	const directory = await mkdtemp(join(tmpdir(), "transcript-error-exit-"));
	const transcriptPath = join(directory, "transcript.jsonl");
	await writeFile(transcriptPath, "x".repeat(4 * 1024 * 1024 + 1));
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
	const harness = `test-${crypto.randomUUID()}`;
	const keyFile = await writeKeyFile(server.url.origin, harness, "fixture-credential");
	await new ConnectorRegistry().set(harness, { url: server.url.origin, keyFile });
	try {
		const code = `import {Command} from ${JSON.stringify(import.meta.resolve("commander"))};
		import {registerHookCommands} from ${JSON.stringify(new URL("./hook.ts", import.meta.url).href)};
		import {createHookFetch} from ${JSON.stringify(new URL("../lib/hook-transport.ts", import.meta.url).href)};
		const program = new Command(); registerHookCommands(program, {AGENTS_DIR: process.env.HOME, createHookFetch, fetchDaemonResult: async()=>({ok:false,reason:'offline'}),readStaticIdentity:()=>null});
		await program.parseAsync(['node','signet','hook','--json','session-end','--harness',${JSON.stringify(harness)}]);`;
		const child = Bun.spawn([process.execPath, "--eval", code], {
			stdin: Buffer.from(JSON.stringify({ session_id: "capture-error", transcript_path: transcriptPath })),
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		});
		const stderr = await new Response(child.stderr).text();
		expect(await child.exited).toBe(1);
		expect(stderr.trim()).toMatch(/^\{.*\}$/);
		expect(JSON.parse(stderr)).toMatchObject({ reason: "transcript_capture_deferred", status: 0 });
	} finally {
		server.stop(true);
		await new ConnectorRegistry().remove(harness);
		await rm(directory, { recursive: true, force: true });
	}
});

test("session-end 401 retains evidence in the harness outbox", async () => {
	const directory = await mkdtemp(join(tmpdir(), "transcript-capture-"));
	const transcriptPath = join(directory, "transcript.jsonl");
	await writeFile(transcriptPath, "durable evidence");
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const payload = await request.json();
			expect(payload.transcript).toBe("durable evidence");
			expect(payload.transcriptPath).toBeUndefined();
			expect(request.headers.get("authorization")).toBe("Bearer scoped-credential");
			expect(request.headers.has("x-signet-actor")).toBe(false);
			return Response.json({ error: "expired", reason: "expired" }, { status: 401 });
		},
	});
	const harness = `test-${crypto.randomUUID()}`;
	const keyFile = await writeKeyFile(server.url.origin, harness, "scoped-credential");
	await new ConnectorRegistry().set(harness, { url: server.url.origin, keyFile });
	try {
		const fetch = await createHookFetch(harness);
		const result = await fetch("/api/hooks/session-end", {
			method: "POST",
			body: JSON.stringify({ sessionKey: "conversation", harness, transcriptPath }),
		});
		expect(result).toMatchObject({ ok: false, status: 401, body: { reason: "expired" } });
		expect((await new DurableOutbox(server.url.origin, { harness }).status()).pending).toBe(1);
	} finally {
		server.stop(true);
		await new ConnectorRegistry().remove(harness);
		await rm(directory, { recursive: true, force: true });
	}
});
