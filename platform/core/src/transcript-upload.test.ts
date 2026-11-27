import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	MAX_INLINE_TRANSCRIPT_BYTES,
	MAX_TRANSCRIPT_UPLOAD_BYTES,
	TRANSCRIPT_UPLOAD_TAIL_BYTES,
	TranscriptUploadError,
	type TranscriptSource,
	type TranscriptUploadStatus,
	sha256Hex,
	transcriptSourceEnd,
	transcriptUploadEnd,
	transcriptUploadRanges,
	transcriptUploadPlan,
	uploadTranscript,
} from "./transcript-upload";

function bytes(value: string): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(value);
}

function sha(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

interface ReadSource extends TranscriptSource {
	readonly reads: { start: number; end: number }[];
}

function source(value: string): ReadSource {
	const all = bytes(value);
	const reads: { start: number; end: number }[] = [];
	return {
		size: all.byteLength,
		reads,
		async read(start: number, end: number) {
			reads.push({ start, end });
			return all.slice(start, end);
		},
	};
}

test("uses 4 MiB inline, 1 MiB ranges and a 64 KiB tail", () => {
	expect(MAX_INLINE_TRANSCRIPT_BYTES).toBe(4194304);
	expect(MAX_TRANSCRIPT_UPLOAD_BYTES).toBe(1048576);
	expect(TRANSCRIPT_UPLOAD_TAIL_BYTES).toBe(65536);
});

test("hashes bytes as lowercase hex SHA-256", async () => {
	expect(await sha256Hex(bytes("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	expect(await sha256Hex(bytes(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("ends the upload after the last newline", () => {
	expect(transcriptUploadEnd(bytes('{"a":1}\n{"b"'))).toBe(8);
	expect(transcriptUploadEnd(bytes('{"a":1}\n'))).toBe(8);
	expect(transcriptUploadEnd(bytes('{"a":1}\n{"b":2}\n'))).toBe(16);
	expect(transcriptUploadEnd(bytes("no newline"))).toBe(0);
	expect(transcriptUploadEnd(bytes(""))).toBe(0);
});

test("splits an upload into ranges of at most 1 MiB", () => {
	expect(transcriptUploadRanges(0, 0)).toEqual([]);
	expect(transcriptUploadRanges(8, 8)).toEqual([]);
	expect(transcriptUploadRanges(9, 8)).toEqual([]);
	expect(transcriptUploadRanges(0, 10)).toEqual([{ start: 0, end: 10 }]);
	expect(transcriptUploadRanges(100, 1048676)).toEqual([{ start: 100, end: 1048676 }]);
	expect(transcriptUploadRanges(100, 1048677)).toEqual([
		{ start: 100, end: 1048676 },
		{ start: 1048676, end: 1048677 },
	]);
	expect(transcriptUploadRanges(0, 2097157)).toEqual([
		{ start: 0, end: 1048576 },
		{ start: 1048576, end: 2097152 },
		{ start: 2097152, end: 2097157 },
	]);
});

test("starts a first upload at generation 0", async () => {
	const state = { committedOffset: 0, generation: null, tailSha256: null };
	const result = await transcriptUploadPlan(state, source('{"a":1}\n{"b"'));
	expect(result).toEqual({ generation: 0, offset: 0, end: 8 });
});

test("resumes when the committed tail still matches", async () => {
	const tailHash = sha('{"a":1}\n');
	const state = { committedOffset: 8, generation: 3, tailSha256: tailHash };
	const result = await transcriptUploadPlan(state, source('{"a":1}\n{"b":2}\n'));
	expect(result).toEqual({ generation: 3, offset: 8, end: 16 });
});

test("restarts with the next generation when the committed tail changed", async () => {
	const tailHash = sha('{"z":9}\n');
	const state = { committedOffset: 8, generation: 3, tailSha256: tailHash };
	const result = await transcriptUploadPlan(state, source('{"a":1}\n{"b":2}\n'));
	expect(result).toEqual({ generation: 4, offset: 0, end: 16 });
});

test("keeps a committed partial line and restarts when the file is shorter", async () => {
	const tailHash1 = sha('{"a":1}\n{"b"');
	const state1 = { committedOffset: 12, generation: 3, tailSha256: tailHash1 };
	const result1 = await transcriptUploadPlan(state1, source('{"a":1}\n{"b"'));
	expect(result1).toEqual({ generation: 3, offset: 12, end: 12 });

	const tailHash2 = sha('{"a":1}\n');
	const state2 = { committedOffset: 20, generation: 3, tailSha256: tailHash2 };
	const result2 = await transcriptUploadPlan(state2, source('{"a":1}\n'));
	expect(result2).toEqual({ generation: 4, offset: 0, end: 8 });
});

test("reads only the tail before the committed offset and the bytes after it", async () => {
	const file = source(`${"x".repeat(199999)}\n`);
	const tailHash1 = sha("x".repeat(65536));
	const state1 = { committedOffset: 150000, generation: 1, tailSha256: tailHash1 };
	const result1 = await transcriptUploadPlan(state1, file);
	expect(result1).toEqual({ generation: 1, offset: 150000, end: 200000 });
	expect(file.reads).toEqual([
		{ start: 84464, end: 150000 },
		{ start: 150000, end: 200000 },
	]);

	const tailHash2 = sha("x".repeat(150000));
	const state2 = { committedOffset: 150000, generation: 1, tailSha256: tailHash2 };
	const result2 = await transcriptUploadPlan(state2, file);
	expect(result2).toEqual({ generation: 2, offset: 0, end: 200000 });
});

test("finds the end after the last newline reading back to the floor", async () => {
	expect(await transcriptSourceEnd(source('{"a":1}\n{"b"'), 0)).toBe(8);
	expect(await transcriptSourceEnd(source("no newline"), 0)).toBe(0);
	expect(await transcriptSourceEnd(source(""), 0)).toBe(0);

	const file = source(`${"a".repeat(10)}\n${"b".repeat(200000)}`);
	expect(await transcriptSourceEnd(file, 0)).toBe(11);
	expect(file.reads).toEqual([
		{ start: 134475, end: 200011 },
		{ start: 68939, end: 134475 },
		{ start: 3403, end: 68939 },
		{ start: 0, end: 3403 },
	]);

	const floored = source(`${"a".repeat(10)}\n${"b".repeat(200000)}`);
	expect(await transcriptSourceEnd(floored, 100000)).toBe(100000);
	expect(floored.reads).toEqual([
		{ start: 134475, end: 200011 },
		{ start: 100000, end: 134475 },
	]);

	const tail = source(`${"a".repeat(200000)}\n{"b"`);
	expect(await transcriptSourceEnd(tail, 0)).toBe(200001);
	expect(tail.reads).toEqual([{ start: 134469, end: 200005 }]);
});

interface Sent {
	readonly method: string;
	readonly url: URL;
	readonly headers: Headers;
	readonly body: Uint8Array<ArrayBuffer> | null;
}

class FakeDaemon {
	generation: number | null = null;
	content: Uint8Array<ArrayBuffer> = new Uint8Array(0);
	readonly sent: Sent[] = [];
	readonly patchAnswers: Response[] = [];
	readonly getAnswers: Response[] = [];

	seed(generation: number, value: string): void {
		this.generation = generation;
		this.content = bytes(value);
	}

	async status(): Promise<TranscriptUploadStatus> {
		const end = this.content.byteLength;
		return {
			committedOffset: end,
			generation: this.generation,
			tailSha256: this.generation === null ? null : await sha256Hex(this.content.subarray(Math.max(0, end - 65536))),
		};
	}

	patches(): Sent[] {
		return this.sent.filter((request) => request.method === "PATCH");
	}

	text(): string {
		return new TextDecoder().decode(this.content);
	}

	readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
		const method = init.method ?? "GET";
		const headers = new Headers(init.headers);
		const body = init.body instanceof Uint8Array ? new Uint8Array(init.body) : null;
		this.sent.push({ method, url: new URL(input), headers, body });
		if (method === "GET") return this.getAnswers.shift() ?? Response.json(await this.status());
		const answer = this.patchAnswers.shift();
		if (answer) return answer;
		const generation = Number(headers.get("Upload-Generation"));
		const offset = Number(headers.get("Upload-Offset"));
		const sameGeneration = generation === this.generation && offset === this.content.byteLength;
		const nextGeneration = offset === 0 && (this.generation === null || generation > this.generation);
		if (!body || (!sameGeneration && !nextGeneration)) {
			return Response.json({ error: "offset_mismatch", ...(await this.status()) }, { status: 409 });
		}
		expect(headers.get("Upload-Checksum")).toBe(await sha256Hex(body));
		const kept = sameGeneration ? this.content : new Uint8Array(0);
		const next = new Uint8Array(kept.byteLength + body.byteLength);
		next.set(kept);
		next.set(body, kept.byteLength);
		this.generation = generation;
		this.content = next;
		return Response.json({ ...(await this.status()), jobId: "job-1" });
	};

	client() {
		return {
			baseUrl: "http://127.0.0.1:3850/",
			headers: { Authorization: "Bearer test-token" },
			fetch: this.fetch,
			retryDelayMs: 0,
		};
	}
}

const target = { harness: "claude-code", sessionKey: "session-1", agentId: "agent-1", cwd: "/repo" };

async function failure(promise: Promise<unknown>): Promise<TranscriptUploadError> {
	const error = await promise.then(
		() => undefined,
		(err: unknown) => err,
	);
	if (!(error instanceof TranscriptUploadError)) throw new Error(`expected a TranscriptUploadError, got ${error}`);
	return error;
}

test("uploads a new transcript up to its last newline", async () => {
	const daemon = new FakeDaemon();
	const outcome = await uploadTranscript(daemon.client(), target, source('{"a":1}\n{"b"'));
	expect(outcome).toEqual({ status: "uploaded", committedOffset: 8, generation: 0 });
	expect(daemon.text()).toBe('{"a":1}\n');
	expect(daemon.sent.map((request) => request.method)).toEqual(["GET", "PATCH"]);
	for (const request of daemon.sent) {
		expect(`${request.url.origin}${request.url.pathname}`).toBe("http://127.0.0.1:3850/api/hooks/transcript-upload");
		expect(Object.fromEntries(request.url.searchParams)).toEqual({
			harness: "claude-code",
			sessionKey: "session-1",
			agentId: "agent-1",
			cwd: "/repo",
		});
		expect(request.headers.get("Authorization")).toBe("Bearer test-token");
	}
	const patch = daemon.patches()[0];
	expect(patch?.headers.get("Upload-Generation")).toBe("0");
	expect(patch?.headers.get("Upload-Offset")).toBe("0");
	expect(patch?.headers.get("Upload-Checksum")).toBe(sha('{"a":1}\n'));
	expect(patch?.headers.get("Content-Type")).toBe("application/octet-stream");
});

test("leaves out the agent and cwd when the target has none", async () => {
	const daemon = new FakeDaemon();
	await uploadTranscript(daemon.client(), { harness: "codex", sessionKey: "session-2" }, source("x\n"));
	expect(Object.fromEntries(daemon.sent[0]?.url.searchParams ?? [])).toEqual({
		harness: "codex",
		sessionKey: "session-2",
	});
});

test("sends a transcript over 1 MiB in ranges of at most 1 MiB", async () => {
	const daemon = new FakeDaemon();
	const text = `${"x".repeat(1048585)}\n`;
	const outcome = await uploadTranscript(daemon.client(), target, source(text));
	expect(outcome).toEqual({ status: "uploaded", committedOffset: 1048586, generation: 0 });
	expect(daemon.patches().map((request) => request.headers.get("Upload-Offset"))).toEqual(["0", "1048576"]);
	expect(daemon.patches().map((request) => request.body?.byteLength)).toEqual([1048576, 10]);
	expect(daemon.text()).toBe(text);
});

test("continues from the committed offset and reads only the tail", async () => {
	const daemon = new FakeDaemon();
	const text = `${"x".repeat(149999)}\n${"y".repeat(49999)}\n`;
	daemon.seed(2, text.slice(0, 150000));
	const file = source(text);
	const outcome = await uploadTranscript(daemon.client(), target, file);
	expect(outcome).toEqual({ status: "uploaded", committedOffset: 200000, generation: 2 });
	expect(daemon.patches().map((request) => request.headers.get("Upload-Offset"))).toEqual(["150000"]);
	expect(daemon.text()).toBe(text);
	expect(Math.min(...file.reads.map((read) => read.start))).toBe(84464);
});

test("starts the next generation when the committed tail changed", async () => {
	const daemon = new FakeDaemon();
	daemon.seed(2, "zzzzzzz\n");
	const outcome = await uploadTranscript(daemon.client(), target, source('{"a":1}\n'));
	expect(outcome).toEqual({ status: "uploaded", committedOffset: 8, generation: 3 });
	expect(daemon.patches()[0]?.headers.get("Upload-Generation")).toBe("3");
	expect(daemon.patches()[0]?.headers.get("Upload-Offset")).toBe("0");
	expect(daemon.text()).toBe('{"a":1}\n');
});

test("sends nothing when no new line was written", async () => {
	const daemon = new FakeDaemon();
	daemon.seed(1, '{"a":1}\n');
	const outcome = await uploadTranscript(daemon.client(), target, source('{"a":1}\n{"b"'));
	expect(outcome).toEqual({ status: "unchanged" });
	expect(daemon.patches()).toEqual([]);
});

test("sends nothing for a transcript with no complete line", async () => {
	const daemon = new FakeDaemon();
	const outcome = await uploadTranscript(daemon.client(), target, source('{"a"'));
	expect(outcome).toEqual({ status: "unchanged" });
	expect(daemon.patches()).toEqual([]);
});

test("plans again from the state a conflict returns", async () => {
	const daemon = new FakeDaemon();
	daemon.seed(0, '{"a":1}\n');
	daemon.getAnswers.push(Response.json({ committedOffset: 0, generation: null, tailSha256: null }));
	const outcome = await uploadTranscript(daemon.client(), target, source('{"a":1}\n{"b":2}\n'));
	expect(outcome).toEqual({ status: "uploaded", committedOffset: 16, generation: 0 });
	expect(daemon.patches().map((request) => request.headers.get("Upload-Offset"))).toEqual(["0", "8"]);
	expect(daemon.text()).toBe('{"a":1}\n{"b":2}\n');
});

test("fails after three conflicting plans", async () => {
	const daemon = new FakeDaemon();
	for (let i = 0; i < 3; i++) {
		daemon.patchAnswers.push(
			Response.json(
				{ error: "offset_mismatch", committedOffset: 0, generation: null, tailSha256: null },
				{ status: 409 },
			),
		);
	}
	const error = await failure(uploadTranscript(daemon.client(), target, source("x\n")));
	expect(error.status).toBe(409);
	expect(daemon.patches().length).toBe(3);
});

test("retries a busy daemon", async () => {
	const daemon = new FakeDaemon();
	daemon.patchAnswers.push(
		Response.json({ error: "busy" }, { status: 503 }),
		Response.json({ error: "busy" }, { status: 503 }),
	);
	const outcome = await uploadTranscript(daemon.client(), target, source("x\n"));
	expect(outcome).toEqual({ status: "uploaded", committedOffset: 2, generation: 0 });
	expect(daemon.patches().length).toBe(3);
});

test("waits as long as the daemon asks before retrying", async () => {
	const daemon = new FakeDaemon();
	daemon.patchAnswers.push(Response.json({ error: "busy" }, { status: 503, headers: { "Retry-After": "0" } }));
	const outcome = await uploadTranscript({ ...daemon.client(), retryDelayMs: 600000 }, target, source("x\n"));
	expect(outcome).toEqual({ status: "uploaded", committedOffset: 2, generation: 0 });
	expect(daemon.patches().length).toBe(2);
});

test("fails after three busy answers", async () => {
	const daemon = new FakeDaemon();
	for (let i = 0; i < 3; i++) daemon.patchAnswers.push(Response.json({ error: "busy" }, { status: 503 }));
	const error = await failure(uploadTranscript(daemon.client(), target, source("x\n")));
	expect(error.status).toBe(503);
	expect(daemon.patches().length).toBe(3);
});

test("retries a busy daemon when reading the state", async () => {
	const daemon = new FakeDaemon();
	daemon.getAnswers.push(Response.json({ error: "busy" }, { status: 503 }));
	const outcome = await uploadTranscript(daemon.client(), target, source("x\n"));
	expect(outcome).toEqual({ status: "uploaded", committedOffset: 2, generation: 0 });
	expect(daemon.sent.map((request) => request.method)).toEqual(["GET", "GET", "PATCH"]);
});

test("fails with 502 when the daemon sends an invalid state", async () => {
	const daemon = new FakeDaemon();
	daemon.getAnswers.push(Response.json({ committedOffset: "0" }));
	const error = await failure(uploadTranscript(daemon.client(), target, source("x\n")));
	expect(error.status).toBe(502);
	expect(error.message).toBe("the daemon sent an invalid transcript upload state");
	expect(daemon.patches()).toEqual([]);
});

test("reports a daemon without the upload route", async () => {
	const daemon = new FakeDaemon();
	daemon.getAnswers.push(new Response("Not Found", { status: 404 }));
	const outcome = await uploadTranscript(daemon.client(), target, source("x\n"));
	expect(outcome).toEqual({ status: "unsupported" });
	expect(daemon.patches()).toEqual([]);
});

test("stops when the daemon bypasses the session", async () => {
	const daemon = new FakeDaemon();
	daemon.patchAnswers.push(Response.json({ bypassed: true }));
	const outcome = await uploadTranscript(daemon.client(), target, source(`${"x".repeat(1048585)}\n`));
	expect(outcome).toEqual({ status: "bypassed" });
	expect(daemon.patches().length).toBe(1);
});

test("fails when the daemon refuses the upload", async () => {
	const daemon = new FakeDaemon();
	daemon.patchAnswers.push(
		Response.json({ error: "session transcript is outside the project scope" }, { status: 403 }),
	);
	const error = await failure(uploadTranscript(daemon.client(), target, source("x\n")));
	expect(error.status).toBe(403);
	expect(error.message).toContain("session transcript is outside the project scope");
});

test("fails when the state request fails", async () => {
	const daemon = new FakeDaemon();
	daemon.getAnswers.push(Response.json({ error: "agentId is required" }, { status: 400 }));
	const error = await failure(uploadTranscript(daemon.client(), target, source("x\n")));
	expect(error.status).toBe(400);
	expect(daemon.patches()).toEqual([]);
});
