import { describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import { parseAuthConfig } from "./auth/config";
import { createAuthMiddleware } from "./auth/middleware";
import { createToken, generateSecret } from "./auth/tokens";
import { admissionKey, createConcurrencyAdmission } from "./concurrency-admission";

describe("concurrency admission", () => {
	it("waits at capacity and grants an idempotent release", async () => {
		const admission = createConcurrencyAdmission(2);
		const first = await admission.acquire("local");
		const second = await admission.acquire("local");
		if (typeof first !== "function" || typeof second !== "function") throw new Error("expected grants");
		let granted = false;
		const waiting = admission.acquire("local").then((result) => {
			granted = true;
			return result;
		});
		await Promise.resolve();
		expect(granted).toBe(false);
		expect(admission.inFlight()).toBe(2);
		first();
		first();
		const third = await waiting;
		expect(typeof third).toBe("function");
		expect(admission.inFlight()).toBe(2);
		second();
		if (typeof third === "function") third();
		expect(admission.inFlight()).toBe(0);
	});
	it("bounds the queue and removes aborted waiters immediately", async () => {
		const admission = createConcurrencyAdmission(1, { maxWaiters: 1 });
		const release = await admission.acquire("a");
		if (typeof release !== "function") throw new Error("expected grant");
		const controller = new AbortController();
		const waiting = admission.acquire("b", controller.signal);
		expect(await admission.acquire("c")).toEqual({ reason: "admission", retryAfter: 1 });
		controller.abort();
		expect(await waiting).toMatchObject({ reason: "admission" });
		const replacement = admission.acquire("c");
		release();
		const next = await replacement;
		if (typeof next !== "function") throw new Error("aborted waiter retained queue space");
		next();
		expect(admission.inFlight()).toBe(0);
		expect(await admission.acquire("a", controller.signal)).toMatchObject({ reason: "admission" });
		expect(admission.inFlight()).toBe(0);
	});

	it("defaults to 64 waiters and a two-second wait deadline", async () => {
		const admission = createConcurrencyAdmission(1);
		const release = await admission.acquire("a");
		if (typeof release !== "function") throw new Error("expected grant");
		const controller = new AbortController();
		const waiters = Array.from({ length: 64 }, () => admission.acquire("b", controller.signal));
		expect(await admission.acquire("c")).toMatchObject({ reason: "admission" });
		controller.abort();
		for (const result of await Promise.all(waiters)) expect(typeof result).toBe("object");
		const started = performance.now();
		expect(await admission.acquire("c")).toMatchObject({ reason: "admission" });
		expect(performance.now() - started).toBeGreaterThanOrEqual(1_900);
		release();
	});

	it("never grants expired work before its delayed timer fires", async () => {
		const admission = createConcurrencyAdmission(1, { maxWaitMs: 5 });
		const release = await admission.acquire("a");
		if (typeof release !== "function") throw new Error("expected grant");
		const pending = admission.acquire("b");
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
		release();
		const result = await pending;
		if (typeof result === "function") result();
		expect(result).toMatchObject({ reason: "admission" });
		expect(admission.inFlight()).toBe(0);
	});

	it("times out queued work and allows replacement work", async () => {
		const admission = createConcurrencyAdmission(1, { maxWaiters: 1, maxWaitMs: 20 });
		const release = await admission.acquire("a");
		if (typeof release !== "function") throw new Error("expected grant");
		const started = performance.now();
		expect(await admission.acquire("b")).toMatchObject({ reason: "admission" });
		expect(performance.now() - started).toBeGreaterThanOrEqual(15);
		const replacement = admission.acquire("c");
		release();
		const next = await replacement;
		if (typeof next !== "function") throw new Error("timed out waiter retained queue space");
		next();
	});

	it("admits a second principal on the next release despite 50 flooding waiters", async () => {
		for (const capacity of [1, 8]) {
			const admission = createConcurrencyAdmission(capacity);
			const releases = await Promise.all(Array.from({ length: capacity }, () => admission.acquire("flood")));
			const controller = new AbortController();
			const flood = Array.from({ length: 50 }, () => admission.acquire("flood", controller.signal));
			const other = admission.acquire("other");
			const first = releases.shift();
			if (typeof first !== "function") throw new Error("expected grant");
			first();
			let admitted = false;
			void other.then((result) => {
				admitted = typeof result === "function";
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(admitted).toBe(true);
			controller.abort();
			const granted = await other;
			if (typeof granted === "function") granted();
			for (const result of releases) if (typeof result === "function") result();
			for (const result of await Promise.all(flood)) if (typeof result === "function") result();
			expect(admission.inFlight()).toBe(0);
		}
	});

	it("rotates across keys and enforces the half-cap while competitors wait", async () => {
		const admission = createConcurrencyAdmission(4);
		const initial = await Promise.all(Array.from({ length: 4 }, () => admission.acquire("a")));
		const controller = new AbortController();
		const order: string[] = [];
		const pending = ["a", "a", "b", "b", "b", "c", "c", "c"].map((key) =>
			admission.acquire(key, controller.signal).then((result) => {
				if (typeof result === "function") order.push(key);
				return result;
			}),
		);
		for (const release of initial) {
			if (typeof release === "function") release();
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(order).toEqual(["b", "c", "a", "b"]);
		controller.abort();
		for (const release of await Promise.all(pending)) if (typeof release === "function") release();
		expect(admission.inFlight()).toBe(0);
	});

	it("does not grant above the per-key cap while another key waits", async () => {
		const admission = createConcurrencyAdmission(4);
		const initial = await Promise.all([
			admission.acquire("a"),
			admission.acquire("a"),
			admission.acquire("a"),
			admission.acquire("b"),
		]);
		const controller = new AbortController();
		const order: string[] = [];
		const pending = ["a", "a", "b", "b", "b"].map((key) =>
			admission.acquire(key, controller.signal).then((result) => {
				if (typeof result === "function") order.push(key);
				return result;
			}),
		);
		const b = initial.pop();
		if (typeof b !== "function") throw new Error("expected grant");
		b();
		const a = initial.pop();
		if (typeof a !== "function") throw new Error("expected grant");
		a();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(order).toEqual(["b", "b"]);
		controller.abort();
		for (const release of initial) if (typeof release === "function") release();
		for (const release of await Promise.all(pending)) if (typeof release === "function") release();
		expect(admission.inFlight()).toBe(0);
	});

	it("estimates Retry-After from queue position and clamps it to 1..30 seconds", async () => {
		let now = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		try {
			for (const [maxWaiters, expected] of [
				[0, 6],
				[1, 12],
				[8, 30],
			]) {
				if (maxWaiters === undefined || expected === undefined) throw new Error("invalid case");
				const admission = createConcurrencyAdmission(2, { maxWaiters });
				const sample = await admission.acquire("a");
				if (typeof sample !== "function") throw new Error("expected grant");
				now += 12_000;
				sample();
				const held = await Promise.all([admission.acquire("a"), admission.acquire("a")]);
				const controller = new AbortController();
				const pending = Array.from({ length: maxWaiters }, () => admission.acquire("a", controller.signal));
				try {
					expect(await admission.acquire("b")).toEqual({ reason: "admission", retryAfter: expected });
				} finally {
					controller.abort();
					await Promise.all(pending);
					for (const release of held) if (typeof release === "function") release();
				}
			}
		} finally {
			clock.mockRestore();
		}
		const cold = createConcurrencyAdmission(0);
		expect(await cold.acquire("a")).toEqual({ reason: "admission", retryAfter: 1 });
	});

	it("bases Retry-After on recent slot hold duration", async () => {
		const admission = createConcurrencyAdmission(1, { maxWaiters: 0 });
		const release = await admission.acquire("a");
		if (typeof release !== "function") throw new Error("expected grant");
		await new Promise((resolve) => setTimeout(resolve, 1_050));
		release();
		const next = await admission.acquire("a");
		if (typeof next !== "function") throw new Error("expected grant");
		expect(await admission.acquire("b")).toEqual({ reason: "admission", retryAfter: 2 });
		next();
	});

	it("tries immediate admission without queuing or bypassing waiting requests", async () => {
		const admission = createConcurrencyAdmission(1);
		const first = admission.tryAcquire("worker");
		if (!first) throw new Error("expected immediate grant");
		expect(admission.tryAcquire("worker")).toBeNull();
		const waiting = admission.acquire("request");
		expect(admission.tryAcquire("worker")).toBeNull();
		first();
		const next = await waiting;
		if (typeof next !== "function") throw new Error("expected queued grant");
		expect(admission.tryAcquire("worker")).toBeNull();
		next();
		expect(admission.inFlight()).toBe(0);
		const last = admission.tryAcquire("worker");
		if (!last) throw new Error("failed tryAcquire queued hidden work");
		last();
		last();
		expect(admission.inFlight()).toBe(0);
		expect(createConcurrencyAdmission(0).tryAcquire("worker")).toBeNull();
	});

	it("supports a disabled capacity and rejects invalid limits", async () => {
		expect(await createConcurrencyAdmission(0).acquire("local")).toMatchObject({ reason: "admission" });
		for (const value of [-1, 1.5, Infinity]) {
			expect(() => createConcurrencyAdmission(value)).toThrow("non-negative integer");
			expect(() => createConcurrencyAdmission(1, { maxWaiters: value })).toThrow("non-negative integer");
			expect(() => createConcurrencyAdmission(1, { maxWaitMs: value })).toThrow("non-negative integer");
		}
	});

	it("leaves no timer keeping an idle process alive", async () => {
		const source = new URL("./concurrency-admission.ts", import.meta.url).href;
		const script = `const {createConcurrencyAdmission}=await import(${JSON.stringify(source)});
		const admission=createConcurrencyAdmission(1,{maxWaitMs:60000});
		const first=await admission.acquire("a");
		if(typeof first!=="function") throw Error("grant missing");
		const controller=new AbortController();
		const cancelled=admission.acquire("b",controller.signal);
		controller.abort(); await cancelled;
		const pending=admission.acquire("c"); first();
		const second=await pending;
		if(typeof second!=="function") throw Error("grant missing");
		second();`;
		const { spawn } = await import("node:child_process");
		const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", timeout: 1_500 });
		const code = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", resolve);
		});
		expect(code).toBe(0);
	});

	it("groups two credential subjects by their shared user scope", async () => {
		const app = new Hono();
		const secret = generateSecret();
		app.use("*", createAuthMiddleware(parseAuthConfig({ mode: "team" }, process.env.HOME ?? "."), secret));
		app.get("/bucket", (c) => c.text(admissionKey(c)));
		const keys = await Promise.all(
			["token-one", "token-two"].map(async (sub) => {
				const token = createToken(secret, { sub, scope: { user: "alice" }, role: "agent" }, 60);
				const response = await app.request("/bucket", { headers: { authorization: `Bearer ${token}` } });
				expect(response.status).toBe(200);
				return response.text();
			}),
		);
		expect(keys).toEqual(["alice", "alice"]);
	});

	it("never mixes an unidentified authenticated credential into the local bucket", async () => {
		const app = new Hono();
		app.get("/authenticated", (c) => {
			c.set("auth", { authenticated: true, claims: null });
			return c.text(admissionKey(c));
		});
		app.get("/loopback", (c) => {
			c.set("auth", { authenticated: false, claims: null, trustedLocal: true });
			return c.text(admissionKey(c));
		});
		expect(await (await app.request("/authenticated")).text()).toBe("anonymous-credential");
		expect(await (await app.request("/loopback")).text()).toBe("local");
	});

	it("uses authenticated subjects, not request headers or agent scope, as keys", async () => {
		const app = new Hono();
		app.get("/local", (c) => c.text(admissionKey(c)));
		app.get("/user", (c) => {
			c.set("auth", {
				authenticated: true,
				claims: { sub: "alice", role: "agent", scope: { agent: "shared" }, iat: 0, exp: 1 },
			});
			return c.text(admissionKey(c));
		});
		expect(await (await app.request("/local", { headers: { "x-signet-actor": "mallory" } })).text()).toBe("local");
		expect(await (await app.request("/user")).text()).toBe("alice");
	});
});
