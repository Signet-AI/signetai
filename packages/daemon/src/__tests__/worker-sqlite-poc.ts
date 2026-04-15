import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { findSqliteVecExtension } from "@signet/core";

type InitMessage = {
	type: "init";
	dbPath: string;
	vecExtensionPath: string;
};

type CheckResult = {
	readonly check: 1 | 2 | 3 | 4;
	readonly pass: boolean;
	readonly message: string;
};

type WorkerMessage = {
	type: "results";
	results: readonly CheckResult[];
};

const CHECK_LABELS: Record<CheckResult["check"], string> = {
	1: "Database opened",
	2: "sqlite-vec extension loaded",
	3: "Basic query succeeded",
	4: "vec_version() returned version",
};

function configurePragmas(db: Database): void {
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA temp_store = MEMORY");
}

function resolveDbPath(): string {
	const signetPath = process.env.SIGNET_PATH?.trim();
	const root = signetPath && signetPath.length > 0 ? signetPath : join(homedir(), ".agents");
	return join(root, "memory", "memories.db");
}

function getParentPort(): NonNullable<typeof parentPort> {
	if (!parentPort) {
		throw new Error("Worker parentPort unavailable");
	}
	return parentPort;
}

function runWorkerChecks(dbPath: string, vecExtensionPath: string): readonly CheckResult[] {
	const results: CheckResult[] = [];
	let db: Database | null = null;

	try {
		db = new Database(dbPath);
		results.push({ check: 1, pass: true, message: "Database opened" });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		results.push({ check: 1, pass: false, message: msg });
		return results;
	}

	try {
		configurePragmas(db);
		db.loadExtension(vecExtensionPath);
		results.push({ check: 2, pass: true, message: "loadExtension succeeded" });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		results.push({ check: 2, pass: false, message: msg });
		return [...results, { check: 3, pass: false, message: "Skipped: extension load failed" }, { check: 4, pass: false, message: "Skipped: extension load failed" }];
	}

	try {
		db.prepare("SELECT 1").get();
		results.push({ check: 3, pass: true, message: "SELECT 1 returned a row" });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		results.push({ check: 3, pass: false, message: msg });
		return [...results, { check: 4, pass: false, message: "Skipped: basic query failed" }];
	}

	try {
		const row = db.prepare("SELECT vec_version() AS version").get() as
			| { version?: unknown }
			| undefined;
		const version = row?.version;
		if (typeof version === "string" && version.trim().length > 0) {
			results.push({ check: 4, pass: true, message: `vec_version=${version}` });
		} else {
			results.push({ check: 4, pass: false, message: "vec_version() returned empty or non-string value" });
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		results.push({ check: 4, pass: false, message: msg });
	}

	db.close();
	return results;
}

function renderCheck(result: CheckResult): string {
	const status = result.pass ? "PASS" : "FAIL";
	const label = CHECK_LABELS[result.check];
	return `CHECK ${result.check}: ${status} - ${label}${result.message ? ` (${result.message})` : ""}`;
}

function writeEvidence(fileName: string, lines: readonly string[]): void {
	const evidenceDir = join(import.meta.dir, "..", "..", "..", "..", ".sisyphus", "evidence");
	mkdirSync(evidenceDir, { recursive: true });
	writeFileSync(join(evidenceDir, fileName), `${lines.join("\n")}\n`, "utf8");
}

async function waitForWorkerResults(worker: Worker): Promise<readonly CheckResult[]> {
	return await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error("Worker timed out after 15s waiting for message"));
		}, 15_000);

		const cleanup = (): void => {
			clearTimeout(timer);
			worker.removeAllListeners("message");
			worker.removeAllListeners("error");
			worker.removeAllListeners("exit");
		};

		worker.on("message", (msg: unknown) => {
			const payload = msg as WorkerMessage;
			if (payload?.type === "results" && Array.isArray(payload.results)) {
				cleanup();
				resolve(payload.results);
			}
		});

		worker.on("error", (err) => {
			cleanup();
			reject(err);
		});

		worker.on("exit", (code) => {
			if (code !== 0) {
				cleanup();
				reject(new Error(`Worker exited with code ${code}`));
			}
		});
	});
}

function printFallback(): void {
	console.error("RECOMMENDED FALLBACK STRATEGY:");
	console.error("A: Use Bun native Worker API and keep bun:sqlite + sqlite-vec in worker-owned process path.");
	console.error("B: Use Bun.spawn IPC with a dedicated SQLite helper process and pass requests over stdio.");
}

async function runMain(): Promise<void> {
	const dbPath = resolveDbPath();
	if (!existsSync(dbPath)) {
		const lines = [
			`FAIL: Check 1 failed: Database file not found at ${dbPath}`,
			"CHECK 1: FAIL - Database opened (Database file missing)",
		];
		for (const line of lines) console.error(line);
		printFallback();
		writeEvidence("task-1-poc-fail.txt", [...lines, "RECOMMENDED FALLBACK STRATEGY:", "A: Bun native Worker", "B: Bun.spawn IPC"]);
		return;
	}

	const vecExtensionPath = findSqliteVecExtension();
	if (!vecExtensionPath) {
		const line = "FAIL: Check 2 failed: sqlite-vec extension path not found via findSqliteVecExtension()";
		console.error(line);
		printFallback();
		writeEvidence("task-1-poc-fail.txt", [line, "RECOMMENDED FALLBACK STRATEGY:", "A: Bun native Worker", "B: Bun.spawn IPC"]);
		return;
	}

	const worker = new Worker(fileURLToPath(import.meta.url));
	worker.postMessage({ type: "init", dbPath, vecExtensionPath } satisfies InitMessage);

	let results: readonly CheckResult[];
	try {
		results = await waitForWorkerResults(worker);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const line = `FAIL: Check 1 failed: ${msg}`;
		console.error(line);
		printFallback();
		writeEvidence("task-1-poc-fail.txt", [line, "RECOMMENDED FALLBACK STRATEGY:", "A: Bun native Worker", "B: Bun.spawn IPC"]);
		await worker.terminate().catch(() => {});
		return;
	}

	const checkLines = results.map(renderCheck);
	for (const line of checkLines) {
		const isPass = line.includes(" PASS ");
		if (isPass) {
			console.log(line);
		} else {
			console.error(line);
		}
	}

	const failed = results.find((item) => !item.pass);
	if (failed) {
		const failLine = `FAIL: Check ${failed.check} failed: ${failed.message}`;
		console.error(failLine);
		printFallback();
		writeEvidence("task-1-poc-fail.txt", [...checkLines, failLine, "RECOMMENDED FALLBACK STRATEGY:", "A: Bun native Worker", "B: Bun.spawn IPC"]);
		await worker.terminate().catch(() => {});
		return;
	}

	console.log("ALL CHECKS PASSED");
	writeEvidence("task-1-poc-pass.txt", [...checkLines, "ALL CHECKS PASSED"]);
	await worker.terminate().catch(() => {});
}

if (!isMainThread) {
	const port = getParentPort();
	port.on("message", (msg: unknown) => {
		const payload = msg as InitMessage;
		if (payload?.type !== "init") return;
		const results = runWorkerChecks(payload.dbPath, payload.vecExtensionPath);
		port.postMessage({ type: "results", results } satisfies WorkerMessage);
	});
} else {
	runMain().catch(console.error);
}
