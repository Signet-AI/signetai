import { expect, test } from "bun:test";
import process from "node:process";
import { organizationLogs } from "./organization-logs.js";

const connected = { type: "connected", redacted: true, maxDurationMs: 60_000, maxEvents: 2 };
const entry = {
	timestamp: "2026-11-26T00:00:00.000Z",
	level: "info",
	category: "daemon",
	message: "[content omitted in organization mode]",
	redacted: true,
};
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;

test("organization logs decode split SSE frames and release signal handlers", async () => {
	const listeners = process.listenerCount("SIGINT");
	const output: string[] = [];
	const bytes = new TextEncoder().encode(frame(connected) + frame(entry));
	let path = "";
	let signal: AbortSignal | null | undefined;
	await organizationLogs(
		async (target, options) => {
			path = target;
			signal = options?.signal;
			return {
				ok: true,
				response: new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
							controller.close();
						},
					}),
				),
			};
		},
		{ follow: true, json: true, lines: "2", level: "info" },
		(value) => output.push(value),
	);
	expect(path).toBe("/api/logs/stream?limit=2&level=info");
	expect(output.map((value) => JSON.parse(value))).toEqual([connected, entry]);
	expect(signal?.aborted).toBe(true);
	expect(process.listenerCount("SIGINT")).toBe(listeners);
});

test("organization logs cancel malformed, oversized, and excess-event responses without echoing bodies", async () => {
	for (const payload of [
		frame(connected) + frame({ ...entry, message: "secret-request-body" }),
		frame(connected) + `data: ${"x".repeat(8193)}`,
		frame(connected) + frame(entry) + frame(entry) + frame(entry),
	]) {
		let cancelled = false;
		const output: string[] = [];
		const listeners = process.listenerCount("SIGINT");
		await expect(
			organizationLogs(
				async () => ({
					ok: true,
					response: new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode(payload));
							},
							cancel() {
								cancelled = true;
							},
						}),
					),
				}),
				{ follow: true, json: true, lines: "2" },
				(value) => output.push(value),
			),
		).rejects.toThrow();
		expect(cancelled).toBe(true);
		expect(output.join("\n")).not.toContain("secret-request-body");
		expect(process.listenerCount("SIGINT")).toBe(listeners);
	}
});

test("organization logs reject invalid filters before requesting and preserve transport denials", async () => {
	let calls = 0;
	const denied = new Error("Requires the admin role");
	const fetchStream = async (): Promise<never> => {
		calls++;
		throw denied;
	};
	await expect(organizationLogs(fetchStream, { lines: "501" })).rejects.toThrow("--lines");
	expect(calls).toBe(0);
	await expect(organizationLogs(fetchStream, { follow: true })).rejects.toBe(denied);
	expect(calls).toBe(1);
});
