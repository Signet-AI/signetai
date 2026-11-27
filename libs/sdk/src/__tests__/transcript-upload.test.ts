import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignetApiError } from "../errors.js";
import { SignetClient } from "../index.js";
import { SignetTransport } from "../transport.js";

interface Upload {
	readonly method: string;
	readonly query: Record<string, string>;
	readonly authorization: string | null;
	readonly offset: string | null;
	readonly body: string;
}

const servers: ReturnType<typeof Bun.serve>[] = [];
const dirs: string[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function transcriptFile(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-sdk-upload-"));
	dirs.push(dir);
	const path = join(dir, "session.jsonl");
	writeFileSync(path, content);
	return path;
}

function daemon(routeMissing = false, refused = false): { readonly client: SignetClient; readonly uploads: Upload[] } {
	const uploads: Upload[] = [];
	let committed = 0;
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname !== "/api/hooks/transcript-upload" || routeMissing) {
				return new Response("Not Found", { status: 404 });
			}
			const body = req.method === "PATCH" ? await req.text() : "";
			uploads.push({
				method: req.method,
				query: Object.fromEntries(url.searchParams),
				authorization: req.headers.get("authorization"),
				offset: req.headers.get("upload-offset"),
				body,
			});
			if (req.method === "PATCH" && refused) {
				return Response.json({ error: "session transcript is outside the project scope" }, { status: 403 });
			}
			if (req.method === "PATCH") committed += new TextEncoder().encode(body).byteLength;
			return Response.json({
				committedOffset: committed,
				generation: req.method === "PATCH" || committed > 0 ? 0 : null,
				tailSha256: null,
			});
		},
	});
	servers.push(server);
	return { client: new SignetClient({ daemonUrl: `http://127.0.0.1:${server.port}`, token: "sdk-token" }), uploads };
}

test("uploads the complete lines of a transcript file", async () => {
	const { client, uploads } = daemon();
	const outcome = await client.uploadTranscript({
		transcriptPath: transcriptFile('{"a":1}\n{"b":2}\n{"c"'),
		harness: "openclaw",
		sessionKey: "sdk-session",
		agentId: "sdk-agent",
		cwd: "/work",
	});
	expect(outcome).toEqual({ status: "uploaded", committedOffset: 16, generation: 0 });
	expect(uploads.map((upload) => upload.method)).toEqual(["GET", "PATCH"]);
	expect(uploads[1]).toEqual({
		method: "PATCH",
		query: { harness: "openclaw", sessionKey: "sdk-session", agentId: "sdk-agent", cwd: "/work" },
		authorization: "Bearer sdk-token",
		offset: "0",
		body: '{"a":1}\n{"b":2}\n',
	});
});

test("raises a refused upload as an API error", async () => {
	const { client } = daemon(false, true);
	const upload = client.uploadTranscript({
		transcriptPath: transcriptFile('{"a":1}\n'),
		harness: "openclaw",
		sessionKey: "sdk-session",
	});
	await expect(upload).rejects.toBeInstanceOf(SignetApiError);
	await expect(upload).rejects.toMatchObject({
		status: 403,
		message: "transcript upload failed with HTTP 403: session transcript is outside the project scope",
	});
});

test("lets request headers win over configured headers", async () => {
	const server = Bun.serve({
		port: 0,
		fetch: (req) =>
			Response.json({ type: req.headers.get("content-type"), authorization: req.headers.get("authorization") }),
	});
	servers.push(server);
	const transport = new SignetTransport({
		baseUrl: `http://127.0.0.1:${server.port}`,
		headers: { "Content-Type": "application/json", Authorization: "Bearer configured" },
	});
	const response = await transport.fetch(`http://127.0.0.1:${server.port}/echo`, {
		method: "PATCH",
		headers: { "Content-Type": "application/octet-stream" },
		body: new Uint8Array([1]),
	});
	expect(await response.json()).toEqual({ type: "application/octet-stream", authorization: "Bearer configured" });
});

test("reports a daemon without the upload route", async () => {
	const { client, uploads } = daemon(true);
	const outcome = await client.uploadTranscript({
		transcriptPath: transcriptFile('{"a":1}\n'),
		harness: "openclaw",
		sessionKey: "sdk-session",
	});
	expect(outcome).toEqual({ status: "unsupported" });
	expect(uploads).toEqual([]);
});
