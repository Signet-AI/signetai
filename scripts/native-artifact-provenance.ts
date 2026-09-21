import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type RustArtifactProvenance = {
	artifact: string;
	target: string;
	rustToolchain: string;
	cargoLockSha256: string;
	sha256: string;
	size: number;
	executableIdentity: string;
	sourceRevision: string;
};

type Inputs = PackagedArtifactInputs & {
	target: string;
	sourceRevision: string;
};

export type PackagedArtifactInputs = {
	artifact: string;
	checkout: string;
	cargoLock: string;
};

function sha256(path: string) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function command(name: string, args: string[]) {
	return execFileSync(name, args, { encoding: "utf8" }).trim();
}

function identity(path: string) {
	try {
		return command("file", ["-b", path]);
	} catch {
		return process.platform === "win32" ? "Windows executable" : "executable";
	}
}

export function verifyStagedArtifact(input: Inputs): RustArtifactProvenance {
	const artifact = resolve(input.artifact);
	const checkout = resolve(input.checkout);
	if (!existsSync(artifact)) throw new Error(`staged artifact missing: ${artifact}`);
	const resolvedArtifact = realpathSync(artifact);
	const resolvedCheckout = realpathSync(checkout);
	if (resolvedArtifact === resolvedCheckout || resolvedArtifact.startsWith(`${resolvedCheckout}/`)) {
		throw new Error(`artifact must be staged outside checkout: ${artifact}`);
	}
	if (!existsSync(input.cargoLock)) throw new Error(`Cargo.lock missing: ${input.cargoLock}`);
	const provenance: RustArtifactProvenance = {
		artifact,
		target: input.target,
		rustToolchain: command("rustc", ["--version"]),
		cargoLockSha256: sha256(input.cargoLock),
		sha256: sha256(artifact),
		size: statSync(artifact).size,
		executableIdentity: identity(artifact),
		sourceRevision: input.sourceRevision,
	};
	if (!/^[0-9a-f]{40}$/.test(provenance.sourceRevision)) throw new Error("source revision must be a full git SHA");
	if (!provenance.size) throw new Error("staged artifact is empty");
	return provenance;
}

export function verifyPackagedArtifactProvenance(
	input: PackagedArtifactInputs,
	expected: RustArtifactProvenance,
): RustArtifactProvenance {
	const actual = verifyStagedArtifact({ ...input, target: expected.target, sourceRevision: expected.sourceRevision });
	const fields: Array<keyof RustArtifactProvenance> = [
		"artifact",
		"target",
		"rustToolchain",
		"cargoLockSha256",
		"sha256",
		"size",
		"executableIdentity",
		"sourceRevision",
	];
	for (const field of fields) {
		if (actual[field] !== expected[field]) throw new Error(`${field} mismatch`);
	}
	return actual;
}
