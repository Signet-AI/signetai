import { z } from "zod";
import process from "node:process";
import type { createDaemonClient } from "../lib/daemon.js";
import type { LogOptions } from "./shared.js";

const omitted = "[content omitted in organization mode]";
const entry = z
	.object({
		timestamp: z.string().datetime(),
		level: z.enum(["debug", "info", "warn", "error"]),
		category: z.string().regex(/^[a-z][a-z-]{0,63}$/),
		message: z.literal(omitted),
		redacted: z.literal(true),
	})
	.strict();
const connected = z
	.object({
		type: z.literal("connected"),
		redacted: z.literal(true),
		maxDurationMs: z.number().int().min(1).max(60_000),
		maxEvents: z.number().int().min(1).max(500),
	})
	.strict();
const event = z.union([connected, entry]);
const snapshot = z
	.object({ logs: z.array(entry).max(500), count: z.number().int().min(0).max(500), redacted: z.literal(true) })
	.strict();
const filters = z.object({
	limit: z.coerce.number().int().min(1).max(500),
	level: z.enum(["debug", "info", "warn", "error"]).optional(),
	category: z
		.string()
		.regex(/^[a-z][a-z-]{0,63}$/)
		.optional(),
});
function json(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("Invalid organization log response");
	}
}
export async function organizationLogs(
	fetchStream: ReturnType<typeof createDaemonClient>["fetchDaemonStream"],
	options: LogOptions,
	print: (value: string) => void = console.log,
): Promise<void> {
	const parsed = filters.safeParse({ limit: options.lines ?? "50", level: options.level, category: options.category });
	if (!parsed.success) throw new Error("Logs require --lines 1..500 and a valid level/category");
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(parsed.data)) if (value !== undefined) query.set(key, String(value));
	const controller = new AbortController();
	let interrupted = false;
	const interrupt = () => {
		interrupted = true;
		controller.abort();
	};
	process.once("SIGINT", interrupt);
	const timeout = options.follow ? 65_000 : 10_000;
	const timer = setTimeout(() => controller.abort(new DOMException("Log deadline exceeded", "TimeoutError")), timeout);
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let failed = false;
	let failure: unknown;
	try {
		const response = await fetchStream(`/api/logs${options.follow ? "/stream" : ""}?${query}`, {
			signal: controller.signal,
			timeout,
		});
		if (!response.ok) throw new Error("Organization log request failed");
		const body = response.response.body;
		if (!body) throw new Error("Organization log response has no body");
		reader = body.getReader();
		const decoder = new TextDecoder("utf-8", { fatal: true });
		let bytes = 0;
		let pending = "";
		let events = 0;
		let established = false;
		const emit = (frame: string) => {
			if (frame.length > 8192) throw new Error("Organization log frame exceeds its limit");
			const data = frame
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (!data) return;
			const decoded = event.safeParse(json(data));
			if (!decoded.success) throw new Error("Invalid organization log response");
			if ("type" in decoded.data) {
				if (established) throw new Error("Invalid organization log handshake");
				established = true;
				print(
					options.json ? JSON.stringify(decoded.data) : "Connected to organization logs (redacted; up to 60 seconds).",
				);
			} else {
				if (!established) throw new Error("Organization log stream has no handshake");
				if (++events > parsed.data.limit) throw new Error("Organization log event limit exceeded");
				print(
					options.json
						? JSON.stringify(decoded.data)
						: `${decoded.data.timestamp} ${decoded.data.level.toUpperCase()} [${decoded.data.category}] ${omitted}`,
				);
			}
		};
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > 1_048_576) throw new Error("Organization log response exceeds its byte limit");
			pending += decoder.decode(chunk.value, { stream: true });
			if (options.follow) {
				pending = pending.replaceAll("\r\n", "\n");
				let boundary = pending.indexOf("\n\n");
				while (boundary >= 0) {
					emit(pending.slice(0, boundary));
					pending = pending.slice(boundary + 2);
					boundary = pending.indexOf("\n\n");
				}
				if (pending.length > 8192) throw new Error("Organization log frame exceeds its limit");
			}
		}
		pending += decoder.decode();
		if (options.follow) {
			if (!established) throw new Error("Organization log stream closed before connection");
			if (pending.trim()) throw new Error("Organization log stream ended with an incomplete frame");
		} else {
			const decoded = snapshot.safeParse(json(pending));
			if (!decoded.success || decoded.data.count !== decoded.data.logs.length)
				throw new Error("Invalid organization log response");
			if (options.json) print(JSON.stringify(decoded.data));
			else
				for (const log of decoded.data.logs)
					print(`${log.timestamp} ${log.level.toUpperCase()} [${log.category}] ${omitted}`);
		}
	} catch (error) {
		if (!interrupted) {
			failed = true;
			failure = error;
		}
	} finally {
		clearTimeout(timer);
		process.off("SIGINT", interrupt);
		controller.abort();
		try {
			await reader?.cancel();
		} catch (error) {
			if (!failed && !(error instanceof Error && error.name === "AbortError")) {
				failed = true;
				failure = error;
			}
		} finally {
			reader?.releaseLock();
		}
	}
	if (failed) throw failure;
}
