#!/usr/bin/env node
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { redact } from "../lib/common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const MAX_LINE = 64 * 1024;
const HIDDEN = new Set(["jobSeed", "gold", "token", "guardKey", "guard_key", "secretsDir"]);
const strip = (value, depth = 0) => {
	if (depth > 12) return "[depth limit]";
	if (Array.isArray(value)) return value.slice(0, 1024).map((v) => strip(v, depth + 1));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(([k]) => !HIDDEN.has(k))
				.map(([k, v]) => [k, strip(v, depth + 1)]),
		);
	return value;
};
function sanitize(line) {
	try {
		return redact(strip(JSON.parse(line)));
	} catch {
		return { src: "viewer", type: "unparseable_line" };
	}
}
async function jsonFile(path) {
	try {
		const file = await open(path, "r");
		try {
			if ((await file.stat()).size > 1024 * 1024) throw new Error("viewer document exceeds limit");
			return JSON.parse(await file.readFile("utf8"));
		} finally {
			await file.close();
		}
	} catch (e) {
		if (e.code === "ENOENT") return null;
		throw e;
	}
}
export function startViewer(runDir, { port = 0 } = {}) {
	const dir = resolve(runDir);
	const html = readFileSync(join(here, "index.html"));
	const streams = new Set();
	let closing;
	const headers = {
		"x-content-type-options": "nosniff",
		"cache-control": "no-store",
		"content-security-policy":
			"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
	};
	const server = createServer(async (req, res) => {
		if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? ""))
			return void res.writeHead(403).end("forbidden host");
		if (req.method !== "GET") return void res.writeHead(405).end("read-only viewer");
		const path = new URL(req.url, "http://localhost").pathname;
		try {
			if (path === "/")
				return void res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" }).end(html);
			if (["/grade", "/status", "/inputs"].includes(path)) {
				let body;
				if (path === "/grade") body = await jsonFile(join(dir, "grade.json"));
				if (path === "/inputs")
					body = {
						prompts: await jsonFile(join(dir, "prompts.json")),
						case: await jsonFile(join(dir, "case.public.json")),
					};
				if (path === "/status") {
					const p = await jsonFile(join(dir, "prepared.json"));
					body =
						p &&
						Object.fromEntries(
							[
								"runId",
								"caseId",
								"phase",
								"promptsSha256",
								"graderSha256",
								"harnessSha256",
								"bootstrap",
								"distractorsSeeded",
							].map((k) => [k, p[k] ?? null]),
						);
				}
				return void res
					.writeHead(200, { ...headers, "content-type": "application/json" })
					.end(JSON.stringify(redact(strip(body))));
			}
			if (path !== "/events") return void res.writeHead(404).end("not found");
			if (streams.size >= 8) return void res.writeHead(429).end("viewer connection limit");
			res.writeHead(200, { ...headers, "content-type": "text/event-stream", connection: "keep-alive" });
			streams.add(res);
			let offset = 0,
				carry = "",
				dropping = false,
				busy = false;
			let decoder = new StringDecoder("utf8");
			const send = (event) => {
				if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
			};
			const pump = async () => {
				if (busy || res.destroyed || res.writableEnded || res.writableNeedDrain) return;
				busy = true;
				let file;
				try {
					file = await open(join(dir, "events.jsonl"), "r");
					const size = (await file.stat()).size;
					if (size < offset) {
						offset = 0;
						carry = "";
						dropping = false;
						decoder = new StringDecoder("utf8");
					}
					if (size === offset) return;
					const buf = Buffer.alloc(Math.min(MAX_LINE, size - offset));
					const { bytesRead } = await file.read(buf, 0, buf.length, offset);
					offset += bytesRead;
					const parts = (carry + decoder.write(buf.subarray(0, bytesRead))).split("\n");
					carry = parts.pop() ?? "";
					for (const line of parts) {
						if (dropping) {
							dropping = false;
							continue;
						}
						if (line.length > MAX_LINE) send({ src: "viewer", type: "oversized_event" });
						else if (line.trim()) send(sanitize(line));
					}
					if (carry.length > MAX_LINE) {
						carry = "";
						dropping = true;
						send({ src: "viewer", type: "oversized_event" });
					}
				} catch (e) {
					if (e.code !== "ENOENT") send({ src: "viewer", type: "read_error" });
				} finally {
					if (file) await file.close().catch(() => send({ src: "viewer", type: "read_error" }));
					busy = false;
				}
			};
			const timer = setInterval(() => {
				void pump();
				if (!res.writableNeedDrain && !res.destroyed) res.write(": keepalive\n\n");
			}, 250);
			res.once("close", () => {
				clearInterval(timer);
				streams.delete(res);
			});
			void pump();
		} catch {
			if (!res.headersSent) res.writeHead(503, headers);
			res.end("viewer data unavailable");
		}
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () =>
			resolve({
				server,
				url: `http://127.0.0.1:${server.address().port}/`,
				close: () =>
					(closing ??= new Promise((done) => {
						for (const res of streams) res.end();
						server.close(done);
						server.closeAllConnections();
					})),
			}),
		);
	});
}
if (import.meta.url === `file://${process.argv[1]}`) {
	if (!process.argv[2]) throw new Error("usage: server.mjs <run-dir>");
	console.log(`viewer: ${(await startViewer(process.argv[2])).url}`);
}
