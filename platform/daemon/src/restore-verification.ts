import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { computeProtectionDigests } from "@signet/core";
import { saveRestoreReceipt } from "./protection";
import { isAbsolute, join, relative, sep } from "node:path";

export interface ProtectionReceipt {
	readonly encryptedProvider?: "available" | "unavailable" | "unverified";
}

export interface RestoreExpectation {
	readonly files: readonly string[];
	readonly transcripts: readonly { path: string; roles: readonly string[]; provenance: readonly string[] }[];
	readonly sources: readonly { id: string; generation: number }[];
	readonly recall: { current: boolean; scope: string };
	readonly dreaming: { frontier: string; consumed: readonly string[] };
	readonly ontology: { history: number; evidenceLinks: number };
	readonly harness: { identity: string; skills: readonly string[] };
}

export interface RestoreVerificationInput {
	readonly root: string;
	readonly expected: RestoreExpectation;
	readonly database: { snapshotConsistent: boolean };
	readonly daemon: { ready: boolean };
	readonly protection?: ProtectionReceipt;
	readonly observed?: Partial<Pick<RestoreExpectation, "sources" | "recall" | "dreaming" | "ontology" | "harness">>;
}

export interface RestoreFailure {
	readonly component: string;
	readonly reason: string;
}
export interface RestoreReceipt {
	readonly schema: "signet.restore.v1";
	readonly ok: boolean;
	readonly components: readonly string[];
	readonly failures: readonly RestoreFailure[];
	readonly fileDigests: Readonly<Record<string, string>>;
	readonly protection: "available" | "unavailable" | "unverified";
}
export interface RestoreVerificationResult {
	readonly ok: boolean;
	readonly failures: readonly RestoreFailure[];
	readonly receipt: RestoreReceipt;
}

function failure(component: string, reason: string): RestoreFailure {
	return { component, reason };
}
function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
function digest(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function safePath(root: string, candidate: string): string | null {
	if (!candidate || isAbsolute(candidate)) return null;
	const resolved = join(root, candidate);
	const rel = relative(root, resolved);
	if (rel === ".." || rel.startsWith(`..${sep}`)) return null;
	try {
		if (lstatSync(resolved).isSymbolicLink()) return null;
		const realRoot = realpathSync(root);
		const realResolved = realpathSync(resolved);
		const realRelative = relative(realRoot, realResolved);
		if (realRelative === ".." || realRelative.startsWith(`..${sep}`)) return null;
	} catch {
		return resolved;
	}
	return resolved;
}

export async function verifyRestore(input: RestoreVerificationInput): Promise<RestoreVerificationResult> {
	const failures: RestoreFailure[] = [];
	const components = [
		"files",
		"database",
		"daemon",
		"sources",
		"transcripts",
		"recall",
		"dreaming",
		"ontology",
		"harness",
	];
	const fileDigests: Record<string, string> = {};
	for (const file of input.expected.files) {
		const path = safePath(input.root, file);
		if (!path) {
			failures.push(failure("files", `unsafe path ${file}`));
			continue;
		}
		if (!existsSync(path)) failures.push(failure("files", `missing ${file}`));
		else {
			try {
				fileDigests[file] = digest(path);
			} catch {
				failures.push(failure("files", `unreadable ${file}`));
			}
		}
	}
	if (!input.database.snapshotConsistent) failures.push(failure("database", "snapshot is inconsistent"));
	if (!input.daemon.ready) failures.push(failure("daemon", "daemon is not ready"));
	if (!input.observed?.sources) failures.push(failure("sources", "source identity was not observed"));
	else if (!sameJson(input.observed.sources, input.expected.sources))
		failures.push(failure("sources", "source id or generation mismatch"));
	for (const transcript of input.expected.transcripts) {
		const path = safePath(input.root, transcript.path);
		if (!path) {
			failures.push(failure("transcripts", `unsafe path ${transcript.path}`));
			continue;
		}
		try {
			const rows = readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const roles = rows.map((row) => row.role);
			const provenance = rows.map((row) => row.provenance);
			const timestamps = rows.map((row) => Date.parse(String(row.timestamp)));
			if (
				!sameJson(roles, transcript.roles) ||
				!sameJson(provenance, transcript.provenance) ||
				timestamps.some((value, i) => {
					const previous = timestamps[i - 1];
					return !Number.isFinite(value) || (previous !== undefined && value < previous);
				})
			)
				failures.push(failure("transcripts", `fidelity mismatch in ${transcript.path}`));
		} catch {
			failures.push(failure("transcripts", `unreadable ${transcript.path}`));
		}
	}
	if (!input.observed?.recall) failures.push(failure("recall", "recall was not observed"));
	else if (!sameJson(input.observed.recall, input.expected.recall))
		failures.push(failure("recall", "currentness or scope mismatch"));
	if (!input.observed?.dreaming) failures.push(failure("dreaming", "dreaming frontier was not observed"));
	else if (!sameJson(input.observed.dreaming, input.expected.dreaming))
		failures.push(failure("dreaming", "frontier or consumption mismatch"));
	if (!input.observed?.ontology) failures.push(failure("ontology", "ontology provenance was not observed"));
	else if (!sameJson(input.observed.ontology, input.expected.ontology))
		failures.push(failure("ontology", "history or evidence links mismatch"));
	if (!input.observed?.harness) failures.push(failure("harness", "harness identity was not observed"));
	else if (!sameJson(input.observed.harness, input.expected.harness))
		failures.push(failure("harness", "identity or skills discovery mismatch"));
	const protection = input.protection?.encryptedProvider ?? "unverified";
	if (protection !== "available")
		failures.push(
			failure(
				"protection",
				protection === "unavailable" ? "secret provider is unavailable" : "secret provider continuity is unverified",
			),
		);
	const receipt: RestoreReceipt = {
		schema: "signet.restore.v1",
		ok: failures.length === 0,
		components,
		failures,
		fileDigests,
		protection,
	};
	return { ok: receipt.ok, failures, receipt };
}

export interface DisposableRestoreInput {
	readonly snapshotRoot: string;
	readonly expected: RestoreExpectation;
	readonly daemon: { readonly binary: string; readonly args?: readonly string[] };
	readonly probe: (
		root: string,
		port: number,
	) => Promise<{
		readonly database: { snapshotConsistent: boolean };
		readonly observed: RestoreVerificationInput["observed"];
		readonly protection?: ProtectionReceipt;
	}>;
}

export interface DisposableRestoreResult extends RestoreVerificationResult {
	readonly cleaned: boolean;
	readonly workspace: string;
}

async function waitForDaemonReady(child: ReturnType<typeof spawn>, port: number): Promise<void> {
	const deadline = Date.now() + 5000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) throw new Error("daemon exited before readiness");
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/health`);
			if (response.ok) {
				const body = (await response.json()) as { status?: unknown; ok?: unknown };
				if (body.ok === true || body.status === "ok" || body.status === "healthy") return;
			}
		} catch (error) {
			lastError = error;
		}
		await sleep(50);
	}
	throw new Error(`daemon did not become ready on dynamic port${lastError ? `: ${String(lastError)}` : ""}`);
}
export async function executeDisposableRestore(input: DisposableRestoreInput): Promise<DisposableRestoreResult> {
	if (
		!isAbsolute(input.snapshotRoot) ||
		!existsSync(input.snapshotRoot) ||
		lstatSync(input.snapshotRoot).isSymbolicLink() ||
		!lstatSync(input.snapshotRoot).isDirectory()
	)
		throw new Error("restore snapshot must be an existing real directory");
	const root = mkdtempSync(join(tmpdir(), "signet-restore-run-"));
	let child: ReturnType<typeof spawn> | undefined;
	let cleaned = false;
	let result: RestoreVerificationResult;
	try {
		cpSync(input.snapshotRoot, root, { recursive: true, dereference: false, force: false });
		const server = await new Promise<{ child: ReturnType<typeof spawn>; port: number }>((resolveServer, reject) => {
			const port = 30000 + Math.floor(Math.random() * 20000);
			const proc = spawn(input.daemon.binary, [...(input.daemon.args ?? [])], {
				env: { ...process.env, SIGNET_PATH: root, SIGNET_RESTORE_PORT: String(port) },
				stdio: "ignore",
			});
			child = proc;
			void waitForDaemonReady(proc, port).then(() => resolveServer({ child: proc, port }), reject);
			proc.once("error", (error) => {
				reject(error);
			});
			proc.once("exit", (code, signal) => {
				if (code !== null || signal !== null) {
					reject(new Error(`daemon exited before readiness (${code ?? signal})`));
				}
			});
		});
		child = server.child;
		const observed = await input.probe(root, server.port);
		result = await verifyRestore({
			root,
			expected: input.expected,
			daemon: { ready: true },
			database: observed.database,
			observed: observed.observed,
			protection: observed.protection,
		});
		if (result.ok) {
			const at = new Date().toISOString();
			const digests = computeProtectionDigests(input.snapshotRoot);
			saveRestoreReceipt(input.snapshotRoot, {
				schema: "signet.restore.v1",
				id: randomUUID(),
				at,
				expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
				valid: true,
				workspace: input.snapshotRoot,
				components: [
					"root-authored",
					"sqlite",
					"transcripts",
					"external-sources",
					"runtime",
					"skills",
					"managed-originals",
					"secrets",
				],
				digests,
			});
		}
	} catch (_error) {
		result = await verifyRestore({
			root,
			expected: input.expected,
			daemon: { ready: false },
			database: { snapshotConsistent: false },
		});
	} finally {
		if (child) {
			const exited = new Promise<boolean>((resolve) => {
				if (child?.exitCode !== null || child?.signalCode !== null) return resolve(true);
				child?.once("close", () => resolve(true));
			});
			child.kill("SIGTERM");
			let stopped = await Promise.race([exited, sleep(500).then(() => false)]);
			if (!stopped) {
				child.kill("SIGKILL");
				stopped = await Promise.race([exited, sleep(500).then(() => false)]);
			}
			if (!stopped || (child.exitCode === null && child.signalCode === null)) cleaned = false;
		}
		const childStopped = !child || child.exitCode !== null || child.signalCode !== null;
		rmSync(root, { recursive: true, force: true });
		cleaned = childStopped && !existsSync(root);
	}
	return { ...result, cleaned, workspace: "disposable" };
}

export function restoreReceiptPath(root: string): string {
	return relative(root, join(root, ".signet", "restore-receipt.json"));
}
