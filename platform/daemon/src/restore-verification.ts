import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

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
		const path = join(input.root, file);
		if (!existsSync(path)) failures.push(failure("files", `missing ${file}`));
		else fileDigests[file] = digest(path);
	}
	if (!input.database.snapshotConsistent) failures.push(failure("database", "snapshot is inconsistent"));
	if (!input.daemon.ready) failures.push(failure("daemon", "daemon is not ready"));
	if (input.observed?.sources && !sameJson(input.observed.sources, input.expected.sources))
		failures.push(failure("sources", "source id or generation mismatch"));
	for (const transcript of input.expected.transcripts) {
		const path = join(input.root, transcript.path);
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
	if (input.observed?.recall && !sameJson(input.observed.recall, input.expected.recall))
		failures.push(failure("recall", "currentness or scope mismatch"));
	if (input.observed?.dreaming && !sameJson(input.observed.dreaming, input.expected.dreaming))
		failures.push(failure("dreaming", "frontier or consumption mismatch"));
	if (input.observed?.ontology && !sameJson(input.observed.ontology, input.expected.ontology))
		failures.push(failure("ontology", "history or evidence links mismatch"));
	if (input.observed?.harness && !sameJson(input.observed.harness, input.expected.harness))
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
