import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTranscriptLifecycleIntents } from "./transcript-lifecycle-intents";
import { logger } from "./logger";

let root = "";
let directory = "";
const previous = process.env.SIGNET_PATH;
beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "transcript-intents-"));
	directory = join(root, ".daemon", "transcript-lifecycle-intents");
	mkdirSync(directory, { recursive: true });
	process.env.SIGNET_PATH = root;
});
afterAll(() => {
	if (previous === undefined) delete process.env.SIGNET_PATH;
	else process.env.SIGNET_PATH = previous;
	rmSync(root, { recursive: true, force: true });
});
const files = (): string[] => readdirSync(directory).filter((name) => name.endsWith(".json"));
beforeEach(() => {
	for (const file of readdirSync(directory)) rmSync(join(directory, file));
});

test.each(["{", JSON.stringify({ seq: 0, intents: [{ action: "invalid" }] })])(
	"corrupt journal is discarded once without blocking owner contact: %s",
	async (corrupt) => {
		const input = { agentId: "a", sessionKey: "corrupt" };
		const token = createHash("sha256")
			.update(JSON.stringify([input.agentId, input.sessionKey]))
			.digest("hex");
		writeFileSync(join(directory, `${token}.json`), corrupt);
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			for (const action of ["status", "start", "end"] as const) {
				let attempted = false;
				await withTranscriptLifecycleIntents({ ...input, action }, async (intents) => {
					attempted = true;
					expect(intents.map((intent) => intent.action)).toEqual(action === "status" ? [] : [action]);
					expect(files()).toEqual([]);
				});
				expect(attempted).toBe(true);
			}
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledWith("transcripts", expect.stringContaining("discarded"), {
				keyHash: token,
				removed: true,
			});
			expect(readdirSync(directory).filter((name) => name !== ".seq")).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	},
);

test("owner success never writes an intent file; failure persists ordered intents until acknowledged", async () => {
	const input = { agentId: "a", sessionKey: "outbox", action: "end" as const };
	await expect(
		withTranscriptLifecycleIntents(input, async () => {
			expect(files()).toEqual([]);
			throw new Error("owner unavailable");
		}),
	).rejects.toThrow("owner unavailable");
	expect(files()).toHaveLength(1);
	const file = files()[0];
	if (!file) throw new Error("Missing outbox");
	expect(JSON.parse(readFileSync(join(directory, file), "utf8")).intents).toMatchObject([{ action: "end" }]);
	await withTranscriptLifecycleIntents({ ...input, action: "start" }, async (intents) => {
		expect(intents.map((intent) => intent.action)).toEqual(["end", "start"]);
		expect(files()).toHaveLength(1);
	});
	expect(files()).toEqual([]);
	await withTranscriptLifecycleIntents(input, async () => {
		expect(files()).toEqual([]);
	});
	expect(files()).toEqual([]);
	await expect(
		withTranscriptLifecycleIntents({ ...input, action: "status" }, async () => {
			throw new Error("still unavailable");
		}),
	).rejects.toThrow("still unavailable");
	expect(files()).toEqual([]);
});

test("orphan journal temps are reclaimed before failure-outbox admission", async () => {
	for (let i = 0; i < 256; i++) writeFileSync(join(directory, `orphan-${i}.json.tmp`), "partial");
	await expect(
		withTranscriptLifecycleIntents({ agentId: "a", sessionKey: "temp-recovery", action: "end" }, async () => {
			expect(readdirSync(directory).filter((name) => name.endsWith(".json.tmp"))).toHaveLength(256);
			expect(files()).toEqual([]);
			throw new Error("owner unavailable");
		}),
	).rejects.toThrow("owner unavailable");
	expect(readdirSync(directory).filter((name) => name.endsWith(".json.tmp"))).toEqual([]);
	expect(files()).toHaveLength(1);
});

test("orphan journal temps are reclaimed even when the outbox is full", async () => {
	for (let i = 0; i < 300; i++) writeFileSync(join(directory, `pending-${i}.json`), "fixture");
	for (let i = 0; i < 20; i++) writeFileSync(join(directory, `orphan-${i}.json.tmp`), "partial");
	await expect(
		withTranscriptLifecycleIntents({ agentId: "a", sessionKey: "full-temp", action: "end" }, async () => {
			throw new Error("owner unavailable");
		}),
	).rejects.toThrow("owner unavailable");
	expect(readdirSync(directory).filter((name) => name.endsWith(".json.tmp"))).toEqual([]);
});

test("an oversized outbox directory is scanned in bounded passes and fails closed", async () => {
	for (let i = 0; i < 1100; i++) writeFileSync(join(directory, `foreign-${i}.bin`), "x");
	const warn = spyOn(logger, "warn").mockImplementation(() => {});
	try {
		await expect(
			withTranscriptLifecycleIntents({ agentId: "a", sessionKey: "bounded", action: "end" }, async () => {
				throw new Error("owner unavailable");
			}),
		).rejects.toThrow("owner unavailable");
		expect(files()).toEqual([]);
		expect(warn).toHaveBeenCalledWith("transcripts", expect.stringContaining("outbox full"), expect.anything());
	} finally {
		warn.mockRestore();
	}
});

test("a full failure outbox rejects new files but still tries the owner", async () => {
	for (let i = 0; i < 256; i++) writeFileSync(join(directory, `pending-${i}.json`), "fixture");
	let attempted = false;
	try {
		await expect(
			withTranscriptLifecycleIntents({ agentId: "a", sessionKey: "overflow", action: "end" }, async () => {
				attempted = true;
				throw new Error("owner unavailable");
			}),
		).rejects.toThrow("owner unavailable");
		expect(attempted).toBe(true);
		expect(files()).toHaveLength(256);
	} finally {
		for (let i = 0; i < 256; i++) rmSync(join(directory, `pending-${i}.json`));
	}
});
