import { createHash } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveDefaultBasePath } from "@signet/core";
import { withTranscriptFileLock } from "./transcript-jsonl";

export interface TranscriptLifecycleIntent {
	readonly seq: number;
	readonly action: "start" | "end";
	readonly at: string;
}

interface IntentJournal {
	readonly seq: number;
	readonly intents: readonly TranscriptLifecycleIntent[];
}

async function readJournal(path: string): Promise<IntentJournal> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { seq: 0, intents: [] };
		throw error;
	}
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
}

async function writeJournal(path: string, journal: IntentJournal): Promise<void> {
	const tmp = `${path}.tmp`;
	const file = await open(tmp, "w", 0o600);
	try {
		await file.writeFile(JSON.stringify(journal));
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

export async function withTranscriptLifecycleIntents<T>(
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
			const journal = await readJournal(path);
			const intents = [...journal.intents];
			const seq = journal.seq + Number(input.action !== "status");
			if (input.action !== "status") {
				if (intents.length >= 1024)
					throw new Error("Transcript lifecycle intent journal is full; retry after owner recovery");
				intents.push({ seq, action: input.action, at: new Date().toISOString() });
				await writeJournal(path, { seq, intents });
			}
			const result = await apply(intents);
			if (intents.length > 0) await writeJournal(path, { seq, intents: [] });
			return result;
		},
		{ timeoutMs: 250 },
	);
}
