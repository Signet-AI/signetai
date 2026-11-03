import { describe, expect, it } from "bun:test";
import type { DaemonClient, DaemonFetchResult } from "./daemon-client.js";
import { createWakeWaiter } from "./wake-waiter.js";

type Step = DaemonFetchResult<unknown> | "block";

function fakeClient(steps: Step[]) {
	const calls: Array<{ path: string; body: Record<string, unknown>; timeout?: number }> = [];
	let aborted = 0;
	const client: DaemonClient = {
		async post() {
			return null;
		},
		postResult<T>(path: string, body: unknown, timeout?: number, signal?: AbortSignal): Promise<DaemonFetchResult<T>> {
			calls.push({ path, body: body as Record<string, unknown>, timeout });
			const step = steps.shift() ?? "block";
			if (step !== "block") return Promise.resolve(step as DaemonFetchResult<T>);
			return new Promise((resolve) => {
				signal?.addEventListener("abort", () => {
					aborted += 1;
					resolve({ ok: false, reason: "offline" });
				});
			});
		},
	};
	return { client, calls, aborted: () => aborted };
}

async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
	expect(check()).toBe(true);
}

const fast = { defaultRetryMs: 5, minLoopMs: 0 };

describe("createWakeWaiter", () => {
	it("delivers wake injects as follow-ups and keeps looping", async () => {
		const fake = fakeClient([
			{ ok: true, data: { wake: true, inject: "hello" } },
			{ ok: true, data: { wake: false, reason: "timeout" } },
			{ ok: true, data: { wake: true, inject: "again" } },
		]);
		const delivered: string[] = [];
		const waiter = createWakeWaiter({
			client: fake.client,
			harness: "pi",
			agentId: "a1",
			deliver: (text) => delivered.push(text),
			...fast,
		});
		waiter.start({ sessionKey: "s1", project: "/p" });
		await until(() => fake.calls.length >= 4);
		expect(delivered).toEqual(["hello", "again"]);
		expect(fake.calls[0]).toEqual({
			path: "/api/cross-agent/wake",
			body: { harness: "pi", sessionKey: "s1", agentId: "a1", project: "/p", waitMs: 25000 },
			timeout: 35000,
		});
		waiter.stop();
		await until(() => fake.aborted() === 1);
		expect(waiter.running).toBe(false);
	});

	it("stops itself on superseded and backs off on errors", async () => {
		const fake = fakeClient([
			{ ok: false, reason: "offline" },
			{ ok: true, data: { wake: false, reason: "closed", retryAfterMs: 5 } },
			{ ok: true, data: { wake: false, reason: "superseded" } },
			{ ok: true, data: { wake: true, inject: "never" } },
		]);
		const delivered: string[] = [];
		const waiter = createWakeWaiter({
			client: fake.client,
			harness: "pi",
			agentId: undefined,
			deliver: (text) => delivered.push(text),
			...fast,
		});
		waiter.start({ sessionKey: "s1" });
		await until(() => !waiter.running);
		expect(fake.calls).toHaveLength(3);
		expect(delivered).toEqual([]);
	});

	it("runs one loop per session and restarts on a new session key", async () => {
		const fake = fakeClient([]);
		const waiter = createWakeWaiter({
			client: fake.client,
			harness: "pi",
			agentId: undefined,
			deliver: () => undefined,
			...fast,
		});
		waiter.start({ sessionKey: "s1" });
		waiter.start({ sessionKey: "s1" });
		await until(() => fake.calls.length === 1);
		waiter.start({ sessionKey: "s2" });
		await until(() => fake.calls.length === 2);
		expect(fake.calls.map((c) => c.body.sessionKey)).toEqual(["s1", "s2"]);
		expect(fake.aborted()).toBe(1);
		waiter.stop();
		await until(() => fake.aborted() === 2);
	});

	it("does not busy-loop on immediate timeouts", async () => {
		const steps: Step[] = Array.from({ length: 50 }, () => ({ ok: true, data: { wake: false, reason: "timeout" } }));
		const fake = fakeClient(steps);
		const waiter = createWakeWaiter({
			client: fake.client,
			harness: "pi",
			agentId: undefined,
			deliver: () => undefined,
			minLoopMs: 200,
		});
		waiter.start({ sessionKey: "s1" });
		await new Promise((r) => setTimeout(r, 100));
		waiter.stop();
		expect(fake.calls.length).toBeLessThanOrEqual(2);
	});

	it("releases claimed messages when deliver throws", async () => {
		const fake = fakeClient([
			{ ok: true, data: { wake: true, inject: "boom", messageIds: ["m1", "m2"] } },
			{ ok: true, data: { released: 2 } },
			{ ok: true, data: { wake: false, reason: "superseded" } },
		]);
		const waiter = createWakeWaiter({
			client: fake.client,
			harness: "pi",
			agentId: "a1",
			deliver: () => {
				throw new Error("nope");
			},
			...fast,
		});
		waiter.start({ sessionKey: "s1", project: "/p" });
		await until(() => !waiter.running);
		const release = fake.calls.find((c) => c.path === "/api/cross-agent/wake/release");
		expect(release?.body).toEqual({ harness: "pi", sessionKey: "s1", agentId: "a1", messageIds: ["m1", "m2"] });
	});

	it("stops after consecutive refusals, releasing each claim, and re-arms on restart", async () => {
		const wakeStep = { ok: true, data: { wake: true, inject: "x", messageIds: ["m1"] } } as const;
		const fake = fakeClient([
			wakeStep,
			{ ok: true, data: { released: 1 } },
			wakeStep,
			{ ok: false, reason: "offline" },
			{ ok: true, data: { released: 1 } },
			wakeStep,
			{ ok: true, data: { released: 1 } },
			wakeStep,
		]);
		const exhausted: number[] = [];
		let attempts = 0;
		const waiter = createWakeWaiter({
			client: fake.client,
			harness: "pi",
			agentId: "a1",
			deliver: () => {
				attempts += 1;
				throw new Error("busy");
			},
			onExhausted: (n) => exhausted.push(n),
			...fast,
		});
		waiter.start({ sessionKey: "s1" });
		await until(() => !waiter.running);
		expect(attempts).toBe(3);
		expect(exhausted).toEqual([3]);
		expect(fake.calls.filter((c) => c.path.endsWith("/release")).length).toBe(4);
		const before = fake.calls.length;
		waiter.start({ sessionKey: "s1" });
		expect(waiter.running).toBe(true);
		await until(() => fake.calls.length > before);
		waiter.stop();
	});

	it("resets the refusal counter after a delivery and does not count network failures", async () => {
		const w = { ok: true, data: { wake: true, inject: "x", messageIds: ["m"] } } as const;
		const rel = { ok: true, data: {} } as const;
		const off = { ok: false, reason: "offline" } as const;
		const fake = fakeClient([
			off,
			off,
			off,
			off,
			w,
			rel,
			w,
			rel,
			w,
			w,
			rel,
			w,
			rel,
			{ ok: true, data: { wake: false, reason: "superseded" } },
		]);
		const outcomes = [false, false, true, false, false];
		const waiter = createWakeWaiter({
			client: fake.client,
			harness: "pi",
			agentId: undefined,
			deliver: () => outcomes.shift() ?? true,
			...fast,
		});
		waiter.start({ sessionKey: "s1" });
		await until(() => fake.calls.filter((c) => c.path.endsWith("/release")).length >= 4);
		expect(outcomes.length).toBe(0);
		waiter.stop();
	});
});
