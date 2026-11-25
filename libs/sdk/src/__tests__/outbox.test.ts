import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, readdir, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DurableOutbox, LoginStore, NodeTransport, resolveTarget } from "../node.js";
import { SignetUnauthorizedError, SignetApiError, SignetTimeoutError } from "../errors.js";
let home: string;
let env: Record<string, string>;
const servers: ReturnType<typeof Bun.serve>[] = [];
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "sdk-outbox-"));
	env = { HOME: home, APPDATA: join(home, "AppData", "Roaming") };
});
afterEach(async () => {
	for (const s of servers) s.stop(true);
	await rm(home, { recursive: true, force: true });
});
const keyring = {
	get: async () => ({ state: "unavailable" as const }),
	set: async (_v: string) => ({ state: "unavailable" as const }),
};
function daemon(fetch: (req: Request) => Response | Promise<Response>) {
	const s = Bun.serve({ port: 0, fetch });
	servers.push(s);
	return s.url.origin;
}

test("expired login rotates once across concurrent clients and persists the new refresh token", async () => {
	let refreshes = 0;
	const origin = daemon(async (req) => {
		if (new URL(req.url).pathname === "/api/auth/refresh") {
			refreshes++;
			expect(await req.json()).toEqual({ refreshToken: "old-refresh" });
			await Bun.sleep(20);
			return Response.json({
				accessToken: "new-access",
				refreshToken: "new-refresh",
				accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
				refreshExpiresAt: new Date(Date.now() + 120_000).toISOString(),
			});
		}
		return req.headers.get("authorization") === "Bearer new-access"
			? Response.json({ ok: true })
			: Response.json({ reason: "expired" }, { status: 401 });
	});
	const store = new LoginStore(origin, { env, keyring });
	await store.save({
		accessToken: "old-access",
		refreshToken: "old-refresh",
		accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
		refreshExpiresAt: new Date(Date.now() + 120_000).toISOString(),
	});
	const targets = await Promise.all([
		resolveTarget({ env, flagUrl: origin, keyring }),
		resolveTarget({ env, flagUrl: origin, keyring }),
	]);
	await Promise.all(targets.map((target) => new NodeTransport(target, { env }).get("/protected")));
	expect(refreshes).toBe(1);
	expect((await store.load())?.credential.refreshToken).toBe("new-refresh");
});

test("401 expired refreshes an unexpired cached token but revoked is never refreshed", async () => {
	let refreshes = 0;
	const origin = daemon(async (req) => {
		if (new URL(req.url).pathname === "/api/auth/refresh") {
			refreshes++;
			return Response.json({ reason: "refresh_reuse", error: "reused" }, { status: 401 });
		}
		return Response.json({ reason: new URL(req.url).pathname === "/revoked" ? "revoked" : "expired" }, { status: 401 });
	});
	const store = new LoginStore(origin, { env, keyring });
	await store.save({
		accessToken: "cached",
		refreshToken: "refresh",
		accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
		refreshExpiresAt: new Date(Date.now() + 120_000).toISOString(),
	});
	const transport = new NodeTransport(await resolveTarget({ flagUrl: origin, env, keyring }), { env });
	await expect(transport.get("/revoked")).rejects.toMatchObject({ reason: "revoked" });
	expect(refreshes).toBe(0);
	await expect(transport.get("/expired")).rejects.toMatchObject({ reason: "refresh_reuse" });
	expect(refreshes).toBe(1);
});

test("session end rejected with 401 is durable and replayed with current credentials and the same idempotency key", async () => {
	let credential: string | null = null;
	const received: { key: string | null; body: unknown }[] = [];
	const origin = daemon(async (req) => {
		if (req.headers.get("authorization") !== "Bearer valid")
			return Response.json({ reason: "expired" }, { status: 401 });
		if (new URL(req.url).pathname === "/api/hooks/session-end")
			received.push({ key: req.headers.get("idempotency-key"), body: await req.json() });
		return Response.json({ ok: true });
	});
	const target = {
		url: origin,
		origin,
		remote: true,
		credential: { source: "env" as const, get: async () => credential },
	};
	const transport = new NodeTransport(target, { env });
	await expect(transport.post("/api/hooks/session-end", { transcript: "evidence" })).rejects.toBeInstanceOf(
		SignetUnauthorizedError,
	);
	const queued = await transport.outbox.entries();
	expect(queued).toHaveLength(1);
	expect(queued[0]?.body).toEqual({ transcript: "evidence" });
	expect((await transport.outbox.status()).pending).toBe(1);
	credential = "valid";
	await transport.get("/authenticated");
	expect(received).toEqual([{ key: queued[0]?.idempotencyKey, body: { transcript: "evidence" } }]);
	expect((await transport.outbox.status()).pending).toBe(0);
});

test("outbox evicts oldest durably at count and byte bounds and records permanent rejection", async () => {
	const outbox = new DurableOutbox("https://org.example", { env });
	for (let i = 0; i < 201; i++) await outbox.enqueue({ method: "POST", path: "/api/hooks/session-end", body: { i } });
	expect((await outbox.status()).pending).toBe(200);
	expect((await outbox.status()).evicted).toBe(1);
	expect((await outbox.entries())[0]?.body).toEqual({ i: 1 });
	const reopened = new DurableOutbox("https://org.example", { env });
	expect((await reopened.status()).evicted).toBe(1);
	await reopened.flush(
		async () => {
			throw Object.assign(new Error("denied"), { status: 403 });
		},
		{ timeoutMs: 30_000 },
	);
	expect((await reopened.status()).dropped).toBe(200);
	expect((await reopened.status()).pending).toBe(0);
	await expect(
		outbox.enqueue({ method: "POST", path: "/api/hooks/session-end", body: "x".repeat(64 * 1024 * 1024) }),
	).rejects.toThrow("64 MiB");
	for (let i = 0; i < 3; i++)
		await outbox.enqueue({ method: "POST", path: "/api/hooks/session-end", body: "x".repeat(24 * 1024 * 1024) });
	const status = await outbox.status();
	expect(status.bytes).toBeLessThanOrEqual(64 * 1024 * 1024);
	expect(status.pending).toBe(2);
	expect(status.evicted).toBe(2);
}, 60_000);

test("outbox replay stops on temporary errors and honors deadline without deleting evidence", async () => {
	const outbox = new DurableOutbox("https://org.example", { env });
	await outbox.enqueue({ method: "POST", path: "/api/hooks/session-end", body: {} });
	const busy = Object.assign(new Error("busy"), { status: 429 });
	await expect(
		outbox.flush(async () => {
			throw busy;
		}),
	).rejects.toBe(busy);
	expect((await outbox.entries())[0]?.attempts).toBe(1);
	expect((await outbox.entries())[0]?.lastError).toContain("429");
	await expect(
		outbox.flush(async () => {
			throw new Error("Replay ignored backoff");
		}),
	).resolves.toEqual({ pending: 1 });
	await expect(
		outbox.flush(
			async (_entry, control) => {
				await new Promise((_resolve, reject) =>
					control.signal?.addEventListener("abort", () => reject(control.signal?.reason), { once: true }),
				);
			},
			{ timeoutMs: 20, force: true },
		),
	).rejects.toBeInstanceOf(SignetTimeoutError);
	expect((await outbox.status()).pending).toBe(1);
});

test("failed automatic replay remains observable until a complete flush", async () => {
	let available = false;
	const origin = daemon((req) =>
		new URL(req.url).pathname === "/api/hooks/session-end" && !available
			? Response.json({ error: "busy" }, { status: 503 })
			: Response.json({ ok: true }),
	);
	const transport = new NodeTransport(await resolveTarget({ flagUrl: origin, flagKey: "fixture", env }), {
		env,
		retries: 0,
	});
	await transport.outbox.enqueue({ method: "POST", path: "/api/hooks/session-end", body: { transcript: "pending" } });
	expect(await transport.get<{ ok: boolean }>("/success")).toEqual({ ok: true });
	expect(transport.lastReplayError).toBeInstanceOf(SignetApiError);
	expect(transport.lastReplayError).toMatchObject({ status: 503 });
	expect(await transport.flush()).toEqual({ pending: 1 });
	expect(transport.lastReplayError).toMatchObject({ status: 503 });
	available = true;
	expect(await transport.flush({ force: true })).toEqual({ pending: 0 });
	expect(transport.lastReplayError).toBeNull();
	expect((await transport.outbox.status()).pending).toBe(0);
});

test("durable replay restores captured scope instead of current fixed headers", async () => {
	let authorized = false;
	const seen: { headers: Record<string, string>; body: unknown }[] = [];
	const origin = daemon(async (req) => {
		seen.push({ headers: Object.fromEntries(req.headers), body: await req.json() });
		return Response.json({ ok: true }, { status: authorized ? 200 : 401 });
	});
	const target = await resolveTarget({ flagUrl: origin, flagKey: "fixture", env });
	const original = new NodeTransport(target, {
		env,
		headers: { "x-signet-agent-id": "alpha", "x-signet-runtime-path": "/original", "x-signet-harness": "hermes" },
	});
	await expect(
		original.post("/api/hooks/session-end", {
			agentId: "alpha",
			harness: "hermes",
			sessionKey: "session",
			transcript: "evidence",
		}),
	).rejects.toMatchObject({ status: 401 });
	const entry = (await original.outbox.entries())[0];
	expect(entry).toMatchObject({
		origin: target.origin,
		headers: { "x-signet-agent-id": "alpha", "x-signet-runtime-path": "/original", "x-signet-harness": "hermes" },
	});
	authorized = true;
	const replay = new NodeTransport(target, {
		env,
		headers: {
			"x-signet-agent-id": "beta",
			"x-signet-session-key": "wrong",
			"x-signet-runtime-path": "/different",
			"x-signet-harness": "codex",
		},
	});
	expect(await replay.flush({ force: true })).toEqual({ pending: 0 });
	expect(seen[1]).toEqual(seen[0]);
	authorized = false;
	const withoutHeaders = new NodeTransport(target, { env });
	await expect(
		withoutHeaders.post("/api/hooks/session-end", {
			agentId: "alpha",
			harness: "hermes",
			sessionKey: "second",
			transcript: "evidence",
		}),
	).rejects.toMatchObject({ status: 401 });
	authorized = true;
	expect(await replay.flush({ force: true })).toEqual({ pending: 0 });
	expect(seen[3]).toEqual(seen[2]);
});

test("foreign-origin entries are left untouched instead of replayed", async () => {
	const first = new DurableOutbox("https://first.example", { env });
	const second = new DurableOutbox("https://second.example", { env });
	const entry = await first.enqueue({ method: "POST", path: "/api/hooks/session-end", body: {} });
	await second.status();
	await import("node:fs/promises").then((fs) =>
		fs.copyFile(join(first.directory, `${entry.id}.json`), join(second.directory, `${entry.id}.json`)),
	);
	let sent = false;
	expect(
		await second.flush(async () => {
			sent = true;
		}),
	).toEqual({ pending: 1 });
	expect(sent).toBe(false);
	expect((await second.entries())[0]).toEqual(entry);
});

test("failed replacement admission preserves all queued evidence", async () => {
	const moduleUrl = new URL("../node.ts", import.meta.url).href;
	const script = `import * as fs from 'node:fs/promises'; import {mock} from 'bun:test'; import {basename,dirname} from 'node:path'; const original={...fs}; let fail=false; let crash=false; let directory=''; mock.module('node:fs/promises',()=>({...original,rename:async(from,to)=>{if(fail&&dirname(String(to))===directory&&/^[a-f0-9-]{36}\\.json$/.test(basename(String(to))))throw Object.assign(new Error('disk full'),{code:'ENOSPC'});const result=await original.rename(from,to);if(crash&&basename(String(to))==='.status.json'&&JSON.parse(await original.readFile(to,'utf8')).evicted>0)process.exit(0);return result}})); const {DurableOutbox}=await import(${JSON.stringify(moduleUrl)}); const box=new DurableOutbox('https://admission.example');directory=box.directory;for(let i=0;i<200;i++)await box.enqueue({method:'POST',path:'/api/hooks/session-end',body:{i}});fail=true;try{await box.enqueue({method:'POST',path:'/api/hooks/session-end',body:{replacement:true}});throw new Error('expected admission failure')}catch(error){if(error.code!=='ENOSPC')throw error}fail=false; console.log(JSON.stringify({status:await box.status(),bodies:(await box.entries()).map(e=>e.body)}));crash=true;await box.enqueue({method:'POST',path:'/api/hooks/session-end',body:{replacement:true}});throw new Error('expected simulated exit');`;
	const child = Bun.spawn([process.execPath, "--eval", script], {
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(child.stdout).text();
	const stderr = await new Response(child.stderr).text();
	expect(await child.exited, stderr).toBe(0);
	expect(JSON.parse(stdout)).toMatchObject({
		status: { pending: 200, evicted: 0 },
		bodies: Array.from({ length: 200 }, (_, i) => ({ i })),
	});
	const recovered = new DurableOutbox("https://admission.example", { env });
	expect(await recovered.status()).toMatchObject({ pending: 200, evicted: 1 });
	expect((await recovered.entries()).at(-1)?.body).toEqual({ replacement: true });
	expect(await recovered.status()).toMatchObject({ pending: 200, evicted: 1 });
}, 60000);

test("cross-process enqueue is serialized and dead stale locks recover", async () => {
	const moduleUrl = new URL("../node.ts", import.meta.url).href;
	const script = `import { DurableOutbox } from ${JSON.stringify(moduleUrl)}; const box = new DurableOutbox('https://org.example'); for(let i=0;i<8;i++) await box.enqueue({method:'POST',path:'/api/hooks/session-end',body:{pid:process.pid,i}});`;
	const children = Array.from({ length: 4 }, () =>
		Bun.spawn([process.execPath, "--eval", script], {
			env: { ...process.env, ...env },
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	for (const child of children) {
		const stderr = await new Response(child.stderr).text();
		expect(await child.exited, stderr).toBe(0);
	}
	const outbox = new DurableOutbox("https://org.example", { env });
	expect((await outbox.status()).pending).toBe(32);
	const files = await readdir(outbox.directory);
	for (const name of files.filter((n) => n.endsWith(".json")))
		if (process.platform !== "win32") expect((await stat(join(outbox.directory, name))).mode & 0o777).toBe(0o600);
	await Bun.write(join(outbox.directory, ".lock"), JSON.stringify({ pid: 2147483647, token: "dead", createdAt: 0 }));
	await import("node:fs/promises").then((fs) => fs.chmod(join(outbox.directory, ".lock"), 0o600));
	await utimes(join(outbox.directory, ".lock"), new Date(0), new Date(0));
	expect((await outbox.status()).pending).toBe(32);
});

test("a failed proactive refresh is not mistaken for a daemon 401 and attempted twice", async () => {
	let refreshes = 0;
	const origin = daemon(() => {
		refreshes++;
		return Response.json({ error: "busy" }, { status: 503 });
	});
	const store = new LoginStore(origin, { env, keyring });
	await store.save({
		accessToken: "expired",
		refreshToken: "refresh",
		accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
		refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
	});
	const transport = new NodeTransport(await resolveTarget({ flagUrl: origin, env, keyring }), { env });
	await expect(transport.get("/protected")).rejects.toMatchObject({
		status: 401,
		reason: "expired",
		cause: { status: 503 },
	});
	expect(refreshes).toBe(1);
});

test("credential source reports protected-file fallback after refresh cannot save to the keychain", async () => {
	let native: string | undefined;
	let available = true;
	const keyring = {
		get: async () => (native ? { state: "found" as const, value: native } : { state: "missing" as const }),
		set: async (value: string) => {
			if (!available) return { state: "unavailable" as const };
			native = value;
			return { state: "found" as const };
		},
	};
	const origin = daemon((req) =>
		new URL(req.url).pathname === "/api/auth/refresh"
			? Response.json({
					accessToken: "new",
					refreshToken: "rotated",
					accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
					refreshExpiresAt: new Date(Date.now() + 120_000).toISOString(),
				})
			: Response.json({ ok: true }),
	);
	const store = new LoginStore(origin, { env, keyring });
	await store.save({
		accessToken: "old",
		refreshToken: "refresh",
		accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
		refreshExpiresAt: new Date(Date.now() + 120_000).toISOString(),
	});
	const target = await resolveTarget({ env, flagUrl: origin, keyring });
	expect(target.credential.source).toBe("keychain");
	available = false;
	await new NodeTransport(target, { env }).get("/protected");
	expect(target.credential.source).toBe("login-file");
	expect((await store.load())?.credential.refreshToken).toBe("rotated");
});

test("delivery admission respects cancellation while another process holds the outbox lock", async () => {
	let requests = 0;
	const origin = daemon(() => {
		requests++;
		return Response.json({ reason: "expired" }, { status: 401 });
	});
	const transport = new NodeTransport(
		{ url: origin, origin, remote: true, credential: { source: "none", get: async () => null } },
		{ env },
	);
	await transport.outbox.status();
	const lock = join(transport.outbox.directory, ".lock");
	await Bun.write(lock, JSON.stringify({ pid: process.pid, token: "held", createdAt: Date.now() }));
	await import("node:fs/promises").then((fs) => fs.chmod(lock, 0o600));
	const release = new Promise<void>((resolve) =>
		setTimeout(() => {
			void rm(lock, { force: true }).then(resolve);
		}, 200),
	);
	const start = Date.now();
	try {
		await expect(
			transport.post("/api/hooks/session-end", { transcript: "evidence" }, { timeoutMs: 25 }),
		).rejects.toMatchObject({ code: "outbox_admission_failed" });
		expect(Date.now() - start).toBeLessThan(120);
		expect(requests).toBe(0);
	} finally {
		await release;
	}
});

test("stale reaper ownership is recovered as well as the primary lock", async () => {
	const outbox = new DurableOutbox("https://org.example", { env });
	await outbox.status();
	for (const name of [".lock", ".lock.reap"]) {
		const path = join(outbox.directory, name);
		await Bun.write(path, JSON.stringify({ pid: 2147483647, token: "dead", createdAt: 0 }));
		await import("node:fs/promises").then((fs) => fs.chmod(path, 0o600));
		await utimes(path, new Date(0), new Date(0));
	}
	const release = new Promise<void>((resolve) =>
		setTimeout(() => {
			void rm(join(outbox.directory, ".lock.reap"), { force: true }).then(resolve);
		}, 250),
	);
	const start = Date.now();
	try {
		expect((await outbox.status()).pending).toBe(0);
		expect(Date.now() - start).toBeLessThan(180);
	} finally {
		await release;
	}
});

test("a committed mutation still returns its result if automatic replay cannot read the outbox", async () => {
	let mutations = 0;
	const origin = daemon(() => Response.json({ receipt: ++mutations }));
	const target = {
		url: origin,
		origin,
		remote: true,
		credential: { source: "env" as const, get: async () => "valid" },
	};
	const transport = new NodeTransport(target, { env });
	await transport.outbox.status();
	const corrupt = join(transport.outbox.directory, "00000000-0000-4000-8000-000000000000.json");
	await Bun.write(corrupt, "broken");
	await import("node:fs/promises").then((fs) => fs.chmod(corrupt, 0o600));
	expect(await transport.post("/non-idempotent", {})).toEqual({ receipt: 1 });
	expect(mutations).toBe(1);
	expect(transport.lastReplayError).toBeInstanceOf(Error);
	await expect(transport.flush()).rejects.toThrow();
});

test("delivery is durable before dispatch and survives the sending process exiting", async () => {
	const keys: string[] = [];
	let reached: (() => void) | undefined;
	const ready = new Promise<void>((resolve) => {
		reached = resolve;
	});
	const origin = daemon((req) => {
		if (new URL(req.url).pathname === "/api/hooks/session-end") {
			keys.push(req.headers.get("idempotency-key") ?? "");
			if (keys.length === 1) {
				reached?.();
				return new Promise<Response>(() => {});
			}
		}
		return Response.json({ ok: true });
	});
	const moduleUrl = new URL("../node.ts", import.meta.url).href;
	const script = `import { NodeTransport, resolveTarget } from ${JSON.stringify(moduleUrl)}; const target=await resolveTarget({flagUrl:${JSON.stringify(origin)},flagKey:'valid'}); await new NodeTransport(target).post('/api/hooks/session-end',{transcript:'durable before dispatch'});`;
	const child = Bun.spawn([process.execPath, "--eval", script], {
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		await Promise.race([
			ready,
			Bun.sleep(2000).then(() => {
				throw new Error("Child did not dispatch");
			}),
		]);
	} finally {
		child.kill("SIGKILL");
		await child.exited;
	}
	const box = new DurableOutbox(origin, { env });
	await utimes(join(box.directory, ".lock"), new Date(0), new Date(0));
	expect((await box.entries())[0]?.body).toEqual({ transcript: "durable before dispatch" });
	const transport = new NodeTransport(await resolveTarget({ flagUrl: origin, flagKey: "valid", env }), { env });
	await transport.get("/authenticated");
	expect(keys).toHaveLength(2);
	expect(keys[1]).toBe(keys[0]);
	expect((await box.status()).pending).toBe(0);
}, 10_000);

test("invalid idempotency keys cannot poison durable delivery records", async () => {
	const box = new DurableOutbox("https://org.example", { env });
	await expect(
		box.enqueue({ method: "POST", path: "/api/hooks/session-end", body: {}, idempotencyKey: "" }),
	).rejects.toThrow("idempotency");
	expect((await box.status()).pending).toBe(0);
});

test("delivery snapshots the payload before asynchronous durable admission", async () => {
	const received: unknown[] = [];
	const origin = daemon(async (req) => {
		received.push(await req.json());
		return Response.json({ ok: true });
	});
	const transport = new NodeTransport(await resolveTarget({ flagUrl: origin, flagKey: "valid", env }), { env });
	const body = { transcript: "original evidence" };
	const request = transport.post("/api/hooks/session-end", body);
	body.transcript = "later mutation";
	await request;
	expect(received).toEqual([{ transcript: "original evidence" }]);
});

test("cross-process refresh remains serialized while recovering abandoned lock generations", async () => {
	let refreshes = 0;
	const origin = daemon(async (req) => {
		if (new URL(req.url).pathname === "/api/auth/refresh") {
			refreshes++;
			if (refreshes !== 1) return Response.json({ reason: "refresh_reuse" }, { status: 401 });
			await Bun.sleep(60);
			return Response.json({
				accessToken: "new",
				refreshToken: "rotated",
				accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
				refreshExpiresAt: new Date(Date.now() + 120_000).toISOString(),
			});
		}
		return req.headers.get("authorization") === "Bearer new"
			? Response.json({ ok: true })
			: Response.json({ reason: "expired" }, { status: 401 });
	});
	const store = new LoginStore(origin, { env, keyring });
	await store.save({
		accessToken: "old",
		refreshToken: "first",
		accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
		refreshExpiresAt: new Date(Date.now() + 120_000).toISOString(),
	});
	for (const suffix of [".lock", ".lock.reap"]) {
		const path = store.path + suffix;
		await Bun.write(path, JSON.stringify({ pid: 2147483647, token: "dead", createdAt: 0 }));
		await import("node:fs/promises").then((fs) => fs.chmod(path, 0o600));
		await utimes(path, new Date(0), new Date(0));
	}
	const moduleUrl = new URL("../node.ts", import.meta.url).href;
	const script = `import { NodeTransport, resolveTarget } from ${JSON.stringify(moduleUrl)}; const keyring={get:async()=>({state:'unavailable'}),set:async()=>({state:'unavailable'})}; await new NodeTransport(await resolveTarget({flagUrl:${JSON.stringify(origin)},keyring})).get('/protected');`;
	const children = Array.from({ length: 12 }, () =>
		Bun.spawn([process.execPath, "--eval", script], {
			env: { ...process.env, ...env },
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	try {
		for (const child of children) {
			const stderr = await new Response(child.stderr).text();
			expect(await child.exited, stderr).toBe(0);
		}
	} finally {
		for (const child of children) {
			child.kill();
			await child.exited;
		}
	}
	expect(refreshes).toBe(1);
	expect((await store.load())?.credential.refreshToken).toBe("rotated");
}, 20_000);

test("refresh authentication failure retains the server policy reason and original HTTP error", async () => {
	const origin = daemon(() =>
		Response.json({ error: "policy denied refresh", reason: "org_policy", required: "operator" }, { status: 403 }),
	);
	await new LoginStore(origin, { env, keyring }).save({
		accessToken: "old",
		refreshToken: "refresh",
		accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
		refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
	});
	const transport = new NodeTransport(await resolveTarget({ flagUrl: origin, env, keyring }), { env });
	await expect(transport.get("/protected")).rejects.toMatchObject({
		status: 401,
		reason: "org_policy",
		cause: { status: 403, reason: "org_policy", required: "operator" },
	});
});

test("a refresh 401 retains the original typed rejection as its cause", async () => {
	const origin = daemon(() => Response.json({ reason: "refresh_reuse", error: "already used" }, { status: 401 }));
	await new LoginStore(origin, { env, keyring }).save({
		accessToken: "old",
		refreshToken: "refresh",
		accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
		refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
	});
	const target = await resolveTarget({ flagUrl: origin, env, keyring });
	await expect(new NodeTransport(target, { env }).get("/protected")).rejects.toMatchObject({
		status: 401,
		reason: "refresh_reuse",
		cause: { status: 401, reason: "refresh_reuse", body: { error: "already used" } },
	});
});
