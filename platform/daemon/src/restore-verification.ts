import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
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
		else fileDigests[file] = digest(path);
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

export function restoreReceiptPath(root: string): string {
	return relative(root, join(root, ".signet", "restore-receipt.json"));
}
