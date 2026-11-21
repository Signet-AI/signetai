import { createHash } from "node:crypto";
import { open, readFile, rename, unlink, opendir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveDefaultBasePath } from "@signet/core";
import { logger } from "../../runtime/logging/logger";
import { withTranscriptFileLock } from "./jsonl";

export interface TranscriptLifecycleIntent {
	readonly seq: number;
	readonly action: "start" | "end";
	readonly at: string;
}

interface IntentJournal {
	readonly seq: number;
	readonly intents: readonly TranscriptLifecycleIntent[];
}

async function readJournal(path: string, keyHash: string): Promise<IntentJournal> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { seq: 0, intents: [] };
		throw error;
	}
	try {
		const value: unknown = JSON.parse(text);
		if (
			typeof value !== "object" ||
			value === null ||
			!("seq" in value) ||
			typeof value.seq !== "number" ||
			!Number.isSafeInteger(value.seq) ||
			!("intents" in value) ||
			!Array.isArray(value.intents) ||
			value.intents.length > 1024
		)
			throw new Error("Invalid transcript lifecycle intent journal");
		const intents: TranscriptLifecycleIntent[] = [];
		for (const entry of value.intents) {
			if (
				typeof entry !== "object" ||
				entry === null ||
				!("seq" in entry) ||
				typeof entry.seq !== "number" ||
				!Number.isSafeInteger(entry.seq) ||
				!("action" in entry) ||
				(entry.action !== "start" && entry.action !== "end") ||
				!("at" in entry) ||
				typeof entry.at !== "string" ||
				!Number.isFinite(Date.parse(entry.at))
			)
				throw new Error("Invalid transcript lifecycle intent");
			intents.push({ seq: entry.seq, action: entry.action, at: entry.at });
		}
		return { seq: value.seq, intents };
	} catch {
		const removed = await unlink(path).then(
			() => true,
			(error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
		);
		logger.warn("transcripts", "Corrupt lifecycle intent journal discarded; relying on TTL finalization", {
			keyHash,
			removed,
		});
		return { seq: 0, intents: [] };
	}
}

async function writeDurable(path: string, text: string): Promise<void> {
	const tmp = `${path}.tmp`;
	const file = await open(tmp, "w", 0o600);
	try {
		await file.writeFile(text);
		await file.sync();
	} finally {
		await file.close();
	}
	await rename(tmp, path);
	const directory = await open(dirname(path), "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

let ownerSequence = 0;

export function rememberTranscriptLifecycleSequence(seq: number): void {
	ownerSequence = Math.max(ownerSequence, seq);
}

async function readSequence(path: string): Promise<number> {
	try {
		const previous: unknown = JSON.parse(await readFile(path, "utf8"));
		if (
			typeof previous === "number" &&
			Number.isSafeInteger(previous) &&
			previous >= 0 &&
			previous < Number.MAX_SAFE_INTEGER
		)
			return previous;
		throw new Error("Invalid transcript lifecycle sequence");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
		const removed = await unlink(path).then(
			() => true,
			(cause: unknown) => cause instanceof Error && "code" in cause && cause.code === "ENOENT",
		);
		logger.warn("transcripts", "Corrupt lifecycle sequence discarded; relying on owner high-water and clock", {
			removed,
		});
		return 0;
	}
}

async function writeSequence(path: string, floor: number): Promise<number> {
	const seq = Math.max(await readSequence(path), floor, ownerSequence, Date.now() * 1024) + 1;
	await writeDurable(path, JSON.stringify(seq));
	return seq;
}

export async function withTranscriptLifecycleIntents<T extends { readonly lifecycleIntentSeq: number } | void>(
	input: { readonly agentId: string; readonly sessionKey: string; readonly action: "start" | "end" | "status" },
	apply: (intents: readonly TranscriptLifecycleIntent[]) => Promise<T>,
): Promise<T> {
	const token = createHash("sha256")
		.update(JSON.stringify([input.agentId, input.sessionKey]))
		.digest("hex");
	const path = join(resolveDefaultBasePath(), ".daemon", "transcript-lifecycle-intents", `${token}.json`);
	return withTranscriptFileLock(
		path,
		async () => {
			const journal = await readJournal(path, token);
			const intents = [...journal.intents];
			await readSequence(join(dirname(path), ".seq"));
			let result: T;
			try {
				result = await apply(intents);
				if (result) rememberTranscriptLifecycleSequence(result.lifecycleIntentSeq);
			} catch (error) {
				const action = input.action;
				if (action === "status") throw error;
				await withTranscriptFileLock(
					join(dirname(path), ".admission"),
					async () => {
						let count = 0;
						let examined = 0;
						let temporaryCount = 0;
						let existing = false;
						const directory = await opendir(dirname(path));
						for await (const entry of directory) {
							if (++examined > 1024) break;
							if (entry.name.endsWith(".json.tmp")) {
								await unlink(join(dirname(path), entry.name));
								temporaryCount++;
								continue;
							}
							if (!entry.name.endsWith(".json")) continue;
							count++;
							if (entry.name === `${token}.json`) existing = true;
						}
						if (temporaryCount > 0)
							logger.warn("transcripts", "Removed orphan lifecycle intent temporary files", { count: temporaryCount });
						if ((!existing && (count >= 256 || examined > 1024)) || intents.length >= 1024) {
							logger.warn("transcripts", "Lifecycle intent outbox full; relying on TTL finalization", {
								agentId: input.agentId,
								sessionKey: input.sessionKey,
							});
							return;
						}
						const seq = await writeSequence(join(dirname(path), ".seq"), journal.seq);
						intents.push({ seq, action, at: new Date().toISOString() });
						await writeDurable(path, JSON.stringify({ seq, intents }));
					},
					{ timeoutMs: 250 },
				);
				throw error;
			}
			await unlink(path).catch((error: unknown) => {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			});
			return result;
		},
		{ timeoutMs: 250 },
	);
}
