/** Regression smoke for Dreaming finalization in compiled native binaries (#1824). */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runMigrations } from "../platform/core/src/migrations";

const root = join(import.meta.dir, "..");
const enabled = process.env.SIGNET_DB_OWNER_SMOKE === "1";
const tempDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const SMOKE_TIMEOUT_MS = 30_000;

function nativeSmokeBinary(): string {
	const override = process.env.SIGNET_NATIVE_SMOKE_BINARY;
	if (override) return resolve(root, override);
	const key = `${process.platform}-${process.arch}`;
	const name = `signet-${key}`;
	return join(root, "dist", "native", key.startsWith("win32-") ? `${name}.exe` : name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function waitForJsonEvent(
	output: () => string,
	stderr: () => string,
	child: ChildProcessWithoutNullStreams,
	processError: () => Error | null,
	predicate: (event: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + SMOKE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		for (const line of output().split("\n")) {
			if (line.length === 0) continue;
			try {
				const event: unknown = JSON.parse(line);
				if (isRecord(event) && predicate(event)) return event;
			} catch {}
		}
		const error = processError();
		if (error !== null) throw error;
		if (child.exitCode !== null) {
			throw new Error(`native DB-owner child exited with ${child.exitCode}: ${stderr()}`);
		}
		await Bun.sleep(10);
	}
	throw new Error(`native DB-owner event did not arrive within ${SMOKE_TIMEOUT_MS}ms: ${stderr()}`);
}

afterEach(() => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill("SIGKILL");
	}
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("compiled native Dreaming finalization", () => {
	const smoke = enabled ? test : test.skip;

	smoke(
		"completes dreaming_pass_finalize through the embedded DB owner (#1824)",
		async () => {
			const binary = nativeSmokeBinary();
			if (!existsSync(binary)) {
				throw new Error(`native binary not found at ${binary}; build it first (bun run build:native-bun)`);
			}
			const directory = mkdtempSync(join(tmpdir(), "signet-native-dreaming-finalize-"));
			tempDirs.push(directory);
			const dbPath = join(directory, "memory.db");
			const database = new Database(dbPath);
			runMigrations(database as unknown as Parameters<typeof runMigrations>[0]);
			database
				.prepare("INSERT INTO dreaming_passes (id, agent_id, mode, status) VALUES (?, ?, ?, ?)")
				.run("native-dreaming-finalize-pass", "native-smoke", "incremental", "running");
			database.close();

			const child = spawn(binary, [], {
				env: { ...process.env, SIGNET_DB_OWNER_DB_PATH: dbPath, SIGNET_TELEMETRY_OPTOUT: "1" },
				stdio: ["pipe", "pipe", "pipe"],
			});
			children.push(child);
			let output = "";
			let stderr = "";
			let processError: Error | null = null;
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				output += chunk;
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.once("error", (error) => {
				processError = error;
			});
			const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
				child.once("close", (code, signal) => resolve({ code, signal }));
			});

			await waitForJsonEvent(outputText, stderrText, child, processErrorText, (event) => event.type === "ready");

			const submit = (id: string, lane: "read" | "write", request: unknown): void => {
				const now = Date.now();
				child.stdin.write(
					`${JSON.stringify({
						type: "submit",
						job: {
							id,
							operation: `smoke.${id}`,
							lane,
							workloadClass: lane === "write" ? "foreground" : undefined,
							enqueuedAt: now,
							deadlineAt: now + SMOKE_TIMEOUT_MS,
							estimatedWorkUnits: 500,
							cancellation: "pending",
							request,
						},
					})}\n`,
				);
			};

			submit("native-dreaming-finalize", "write", {
				kind: "dreaming_pass_finalize",
				input: {
					passId: "native-dreaming-finalize-pass",
					mode: "incremental",
					agentId: "native-smoke",
					scopes: [],
					transcriptManifestEntries: [],
					tokensConsumed: 0,
					inputTokens: null,
					outputTokens: null,
					cacheReadTokens: null,
					cacheCreationTokens: null,
					totalCost: null,
					applied: 0,
					failed: 0,
					summary: "native smoke",
					rejectedEvidence: [],
					memoryHeadResult: null,
					hasBacklogByScope: [],
					nextWatermarkByScope: [],
				},
			});
			const finalized = await waitForJsonEvent(
				outputText,
				stderrText,
				child,
				processErrorText,
				(event) => event.type === "result" && event.jobId === "native-dreaming-finalize",
			);
			expect(finalized).toMatchObject({
				type: "result",
				jobId: "native-dreaming-finalize",
				outcome: "completed",
				result: null,
			});

			submit("native-dreaming-finalize-readback", "read", {
				kind: "query",
				statement: {
					sql: "SELECT status FROM dreaming_passes WHERE id = ?",
					params: ["native-dreaming-finalize-pass"],
					result: "all",
				},
			});
			const readback = await waitForJsonEvent(
				outputText,
				stderrText,
				child,
				processErrorText,
				(event) => event.type === "result" && event.jobId === "native-dreaming-finalize-readback",
			);
			expect(readback).toMatchObject({
				type: "result",
				jobId: "native-dreaming-finalize-readback",
				outcome: "completed",
				result: [{ status: "completed" }],
			});

			child.stdin.write('{"type":"shutdown"}\n');
			expect(await closed).toEqual({ code: 0, signal: null });

			function outputText(): string {
				return output;
			}

			function stderrText(): string {
				return stderr;
			}

			function processErrorText(): Error | null {
				return processError;
			}
		},
		60_000,
	);
});
