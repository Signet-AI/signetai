import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import {
	type Dirent,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
	redactTranscriptFileBatch,
	type TranscriptFileBatch,
	type TranscriptFileCheckpoint,
} from "./session-transcript-files";

const AGENT = "agent-a";
const KEY = "target-session";
const BATCH = 4 * 1024 * 1024;
const REL = "transcripts/session.jsonl";

let root = "";
let path = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "transcript-files-"));
	mkdirSync(join(root, "transcripts"));
	path = join(root, REL);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function record(agent: string, key: string, filler: number, index: number): string {
	return `${JSON.stringify({ agent_id: agent, session_key: key, session_id: key, index, content: "x".repeat(filler) })}\n`;
}

function step(checkpoint: TranscriptFileCheckpoint | null): Promise<TranscriptFileBatch> {
	return redactTranscriptFileBatch({
		basePath: root,
		path: REL,
		agentId: AGENT,
		sessionKey: KEY,
		generation: 1,
		checkpoint,
	});
}

async function drain(
	start: TranscriptFileCheckpoint | null = null,
	limit = 40,
): Promise<TranscriptFileCheckpoint | null> {
	let checkpoint = start;
	for (let i = 0; i < limit; i++) {
		const before = checkpoint?.offset ?? 0;
		const result = await step(checkpoint);
		if (result.checkpoint && result.checkpoint.inode === checkpoint?.inode)
			expect(result.checkpoint.offset - before).toBeLessThanOrEqual(BATCH);
		checkpoint = result.checkpoint;
		if (result.done) return checkpoint;
	}
	throw new Error("cleanup did not finish");
}

function tmpFiles(): string[] {
	return readdirSync(join(root, "transcripts")).filter((name) => name.includes(".delete-"));
}

function mixed(): { readonly content: string; readonly expected: string } {
	let content = "";
	let expected = "";
	for (let i = 0; i < 6000; i++) {
		const target = i % 3 === 0;
		const line = record(AGENT, target ? KEY : "other-session", 900, i);
		content += line;
		if (!target) expected += line;
	}
	return { content, expected };
}

async function firstBatch(): Promise<{ readonly checkpoint: TranscriptFileCheckpoint; readonly expected: string }> {
	const data = mixed();
	writeFileSync(path, data.content);
	const result = await step(null);
	expect(result.done).toBe(false);
	if (!result.checkpoint) throw new Error("missing checkpoint");
	expect(result.checkpoint.ready).toBe(false);
	return { checkpoint: result.checkpoint, expected: data.expected };
}

test("unrelated directory entries cannot exhaust the replacement budget", async () => {
	writeFileSync(path, record(AGENT, KEY, 20, 1) + record(AGENT, "keep", 20, 2));
	for (let i = 0; i < 2048; i++) writeFileSync(join(root, "transcripts", `unrelated-${i}`), "keep");
	const ready = await step(null);
	expect(ready.checkpoint?.ready).toBe(true);
	const opendir = fs.opendir;
	const scan = spyOn(fs, "opendir").mockImplementation(
		async (...args: Parameters<typeof fs.opendir>): ReturnType<typeof fs.opendir> => {
			const directory = await opendir(...args);
			const entries = directory[Symbol.asyncIterator].bind(directory);
			directory[Symbol.asyncIterator] = async function* (): AsyncGenerator<Dirent, undefined> {
				for await (const entry of entries()) {
					await Bun.sleep(300);
					yield entry;
				}
				return undefined;
			};
			return directory;
		},
	);
	try {
		expect((await step(ready.checkpoint)).done).toBe(true);
	} finally {
		scan.mockRestore();
	}
	expect(readFileSync(path, "utf8")).toBe(record(AGENT, "keep", 20, 2));
	expect(readdirSync(join(root, "transcripts")).filter((name) => name.startsWith("unrelated-"))).toHaveLength(2048);
});

test("a removed output temp restarts the file instead of padding it with zeros", async () => {
	const { checkpoint, expected } = await firstBatch();
	for (const name of tmpFiles()) rmSync(join(root, "transcripts", name));
	await drain(checkpoint);
	expect(readFileSync(path, "utf8")).toBe(expected);
	expect(tmpFiles()).toEqual([]);
});

test("a replaced output temp restarts the file instead of resuming into foreign bytes", async () => {
	const { checkpoint, expected } = await firstBatch();
	const [name] = tmpFiles();
	if (!name) throw new Error("missing temp");
	rmSync(join(root, "transcripts", name));
	writeFileSync(join(root, "transcripts", name), "F".repeat(checkpoint.bytes + 4096));
	await drain(checkpoint);
	expect(readFileSync(path, "utf8")).toBe(expected);
});

test("a shortened output temp restarts the file instead of extending it", async () => {
	const { checkpoint, expected } = await firstBatch();
	const [name] = tmpFiles();
	if (!name) throw new Error("missing temp");
	truncateSync(join(root, "transcripts", name), Math.floor(checkpoint.bytes / 2));
	await drain(checkpoint);
	expect(readFileSync(path, "utf8")).toBe(expected);
});

test("a ready checkpoint never renames a shortened or missing output temp", async () => {
	for (const damage of ["shorten", "remove"]) {
		rmSync(path, { force: true });
		const data = mixed();
		writeFileSync(path, data.content);
		let checkpoint: TranscriptFileCheckpoint | null = null;
		for (let i = 0; i < 10; i++) {
			const result = await step(checkpoint);
			checkpoint = result.checkpoint;
			if (checkpoint?.ready) break;
		}
		if (!checkpoint?.ready) throw new Error("never became ready");
		const [name] = tmpFiles();
		if (!name) throw new Error("missing temp");
		if (damage === "shorten") truncateSync(join(root, "transcripts", name), checkpoint.bytes - 10);
		if (damage === "remove") rmSync(join(root, "transcripts", name));
		await drain(checkpoint);
		expect(readFileSync(path, "utf8")).toBe(data.expected);
		expect(tmpFiles()).toEqual([]);
	}
});

test("a ready checkpoint ignores a temp of the right size but wrong identity", async () => {
	const data = mixed();
	writeFileSync(path, data.content);
	let checkpoint: TranscriptFileCheckpoint | null = null;
	for (let i = 0; i < 10; i++) {
		checkpoint = (await step(checkpoint)).checkpoint;
		if (checkpoint?.ready) break;
	}
	if (!checkpoint?.ready) throw new Error("never became ready");
	const [name] = tmpFiles();
	if (!name) throw new Error("missing temp");
	rmSync(join(root, "transcripts", name));
	writeFileSync(join(root, "transcripts", name), "F".repeat(checkpoint.bytes));
	await drain(checkpoint);
	expect(readFileSync(path, "utf8")).toBe(data.expected);
});

function giant(agent: string, key: string, size: number, metadata: "first" | "last"): string {
	const head = `"agent_id":${JSON.stringify(agent)},"session_key":${JSON.stringify(key)},"session_id":${JSON.stringify(key)}`;
	const body = `"content":"${"g".repeat(size)}"`;
	return metadata === "first" ? `{${head},${body}}\n` : `{${body},${head}}\n`;
}

test("a giant record from another session is preserved byte for byte", async () => {
	for (const metadata of ["first", "last"] as const) {
		const before = record(AGENT, KEY, 50, 1) + record(AGENT, "other", 50, 2);
		const after = record(AGENT, KEY, 50, 3) + record(AGENT, "other", 50, 4);
		const big = giant(AGENT, "other", 6 * 1024 * 1024, metadata);
		const foreign = giant("agent-b", KEY, 5 * 1024 * 1024, metadata);
		writeFileSync(path, before + big + foreign + after);
		const checkpoint = await drain();
		expect(readFileSync(path, "utf8")).toBe(
			record(AGENT, "other", 50, 2) + big + foreign + record(AGENT, "other", 50, 4),
		);
		expect(checkpoint?.records).toBe(2);
	}
});

test("a giant owned record is dropped even when its metadata follows the content", async () => {
	for (const metadata of ["first", "last"] as const) {
		const keep = record(AGENT, "other", 50, 2);
		writeFileSync(
			path,
			record(AGENT, KEY, 50, 1) +
				giant(AGENT, `session:${KEY}`, 9 * 1024 * 1024, metadata) +
				keep +
				giant(AGENT, KEY, 4 * 1024 * 1024, metadata),
		);
		const checkpoint = await drain();
		expect(readFileSync(path, "utf8")).toBe(keep);
		expect(checkpoint?.records).toBe(3);
		expect(tmpFiles()).toEqual([]);
	}
});

test("a giant record spanning many batches survives a checkpoint round trip", async () => {
	const keep = record(AGENT, "other", 50, 2);
	const big = giant(AGENT, KEY, 10 * 1024 * 1024, "last");
	writeFileSync(path, keep + big + keep);
	let checkpoint: TranscriptFileCheckpoint | null = null;
	for (let i = 0; i < 20; i++) {
		const result: TranscriptFileBatch = await step(checkpoint);
		checkpoint = result.checkpoint === null ? null : JSON.parse(JSON.stringify(result.checkpoint));
		if (result.done) break;
	}
	expect(readFileSync(path, "utf8")).toBe(keep + keep);
});

test("nested or escaped lookalike metadata does not claim a record", async () => {
	const decoys = [
		`${JSON.stringify({ meta: { agent_id: AGENT, session_key: KEY }, agent_id: "agent-b", session_key: KEY })}\n`,
		`${JSON.stringify({ content: `"agent_id":"${AGENT}","session_key":"${KEY}"`, agent_id: AGENT, session_key: "other" })}\n`,
		`${JSON.stringify({ list: [{ agent_id: AGENT }], agent_id: AGENT, session_key: 7, session_id: KEY })}\n`,
		"not json at all\n",
		"\n",
	];
	const owned = `{"agent_id":"agent\\u002da","session\\u005fkey":null,"session_id":"session:${KEY}"}\n`;
	writeFileSync(path, decoys.join("") + owned);
	const checkpoint = await drain();
	expect(readFileSync(path, "utf8")).toBe(decoys.join(""));
	expect(checkpoint?.records).toBe(1);
});

test("a legacy markdown artifact with only session_id and agent_id is removed", async () => {
	const artifact = join(root, "transcripts", "legacy.md");
	writeFileSync(artifact, `---\nagent_id: ${AGENT}\nsession_id: ${KEY}\n---\nbody\n`);
	const result = await redactTranscriptFileBatch({
		basePath: root,
		path: "transcripts/legacy.md",
		agentId: AGENT,
		sessionKey: KEY,
		generation: 1,
		checkpoint: null,
	});
	expect(result.done).toBe(true);
	expect(existsSync(artifact)).toBe(false);
});

test("a legacy markdown artifact owned by another agent or key is left alone", async () => {
	const artifact = join(root, "transcripts", "legacy.md");
	for (const front of [
		`agent_id: agent-b\nsession_id: ${KEY}`,
		`agent_id: ${AGENT}\nsession_id: other`,
		`session_id: ${KEY}`,
	]) {
		writeFileSync(artifact, `---\n${front}\n---\nbody\n`);
		await expect(
			redactTranscriptFileBatch({
				basePath: root,
				path: "transcripts/legacy.md",
				agentId: AGENT,
				sessionKey: KEY,
				generation: 1,
				checkpoint: null,
			}),
		).rejects.toThrow("ownership");
		expect(existsSync(artifact)).toBe(true);
	}
});

function sha(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function collect(): Promise<TranscriptFileCheckpoint | null> {
	let checkpoint: TranscriptFileCheckpoint | null = null;
	for (let i = 0; i < 60; i++) {
		const result: TranscriptFileBatch = await step(checkpoint);
		checkpoint = result.checkpoint === null ? null : JSON.parse(JSON.stringify(result.checkpoint));
		if (result.done) return checkpoint;
	}
	throw new Error("cleanup did not finish");
}

test("a giant canonical record contributes once to the positional prefix", async () => {
	const content = "g".repeat(9 * 1024 * 1024);
	const known = sha(content);
	const owned = `{"agent_id":"${AGENT}","session_key":"${KEY}","content":"${content}","source_sha256":"${known}","role":"user"}\n`;
	const decoys =
		`${JSON.stringify({ agent_id: AGENT, session_key: "other", source_sha256: sha("foreign") })}\n` +
		`${JSON.stringify({ agent_id: "agent-b", session_key: KEY, source_sha256: sha("agent-b") })}\n`;
	const nested =
		`${JSON.stringify({ agent_id: AGENT, session_key: KEY, meta: { source_sha256: sha("nested") }, content: `"source_sha256":"${sha("quoted")}"`, source_sha256: { value: sha("object") } })}\n` +
		`${JSON.stringify({ agent_id: AGENT, session_key: KEY, content: "no hash here" })}\n` +
		`${JSON.stringify({ agent_id: AGENT, session_key: KEY, source_sha256: "not-a-hash" })}\n`;
	writeFileSync(path, decoys + owned + nested);
	const checkpoint = await collect();
	const leaf = createHash("sha256")
		.update(JSON.stringify(["user", known]))
		.digest();
	expect(checkpoint?.prefixCount).toBe(1);
	expect(checkpoint?.prefixHash).toBe(createHash("sha256").update(Buffer.alloc(32)).update(leaf).digest("hex"));
	expect(readFileSync(path, "utf8")).toBe(decoys);
});

test("a positional prefix preserves record order and multiplicity across cleanup", async () => {
	const total = 700;
	let expected = Buffer.alloc(32);
	let content = "";
	let kept = "";
	for (let i = 0; i < total; i++) {
		const hash = sha(`record-${i}`);
		const leaf = createHash("sha256")
			.update(JSON.stringify(["user", hash]))
			.digest();
		expected = createHash("sha256").update(expected).update(leaf).digest();
		content += `${JSON.stringify({ agent_id: AGENT, session_key: KEY, index: i, role: "user", source_sha256: hash })}\n`;
		if (i % 50 === 0) {
			const other = record(AGENT, "other", 20, i);
			content += other;
			kept += other;
		}
	}
	writeFileSync(path, content);
	const checkpoint = await collect();
	expect(checkpoint?.prefixCount).toBe(total);
	expect(checkpoint?.prefixHash).toBe(expected.toString("hex"));
	expect(readFileSync(path, "utf8")).toBe(kept);
});
