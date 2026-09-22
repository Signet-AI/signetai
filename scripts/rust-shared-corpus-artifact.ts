import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type RustDaemonArtifactProvenance = {
	artifact?: string;
	target?: string;
	rustToolchain?: string;
	cargoLockSha256?: string;
	sha256?: string;
	size?: number;
	executableIdentity?: string;
	sourceRevision?: string;
};

export type RustDaemonArtifactValidation = {
	kind: "target" | "staged";
	artifact: string;
	provenancePath?: string;
};

export type RustDaemonArtifactInput = {
	artifact: string;
	checkout: string;
	provenance?: string;
};

function currentRevision(checkout: string): string {
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
}

function currentRustToolchain(): string {
	return execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim();
}

function currentRustTarget(): string {
	const details = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
	const host = details
		.split(/\r?\n/)
		.find((line) => line.startsWith("host:"))
		?.slice("host:".length)
		.trim();
	if (!host) throw new Error("unable to determine the current Rust target");
	return host;
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function executableIdentity(path: string): string | undefined {
	try {
		return execFileSync("file", ["-b", path], { encoding: "utf8" }).trim();
	} catch {
		return undefined;
	}
}

function provenanceCandidates(artifact: string): string[] {
	const directory = dirname(artifact);
	return [resolve(directory, "provenance.json"), resolve(directory, "..", "provenance.json")];
}

function readProvenance(path: string): RustDaemonArtifactProvenance {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as RustDaemonArtifactProvenance;
	} catch {
		throw new Error(`staged daemon provenance is invalid: ${path}`);
	}
}

function validateStagedArtifact(
	artifact: string,
	checkout: string,
	provenancePath: string,
): RustDaemonArtifactValidation {
	if (!existsSync(provenancePath) || !statSync(provenancePath).isFile())
		throw new Error(`staged daemon provenance is missing: ${provenancePath}`);
	const provenance = readProvenance(provenancePath);
	const resolvedArtifact = realpathSync(artifact);
	if (!provenance.artifact || realpathSync(provenance.artifact) !== resolvedArtifact)
		throw new Error("staged daemon provenance artifact does not match the requested executable");
	if (!provenance.sourceRevision || !/^[0-9a-f]{40}$/.test(provenance.sourceRevision))
		throw new Error("staged daemon provenance source revision is not a full git SHA");
	if (provenance.sourceRevision !== currentRevision(checkout))
		throw new Error("staged daemon provenance source revision does not match the current checkout");
	if (!provenance.target || !provenance.rustToolchain || !provenance.cargoLockSha256 || !provenance.executableIdentity)
		throw new Error("staged daemon provenance is incomplete");
	if (provenance.target !== currentRustTarget()) throw new Error("staged daemon provenance target mismatch");
	if (provenance.rustToolchain !== currentRustToolchain())
		throw new Error("staged daemon provenance Rust toolchain mismatch");
	const cargoLock = resolve(checkout, "platform/rust-daemon/Cargo.lock");
	if (!existsSync(cargoLock) || provenance.cargoLockSha256 !== sha256(cargoLock))
		throw new Error("staged daemon provenance Cargo.lock mismatch");
	if (provenance.sha256 !== sha256(artifact)) throw new Error("staged daemon provenance checksum mismatch");
	if (!Number.isSafeInteger(provenance.size) || provenance.size <= 0 || provenance.size !== statSync(artifact).size)
		throw new Error("staged daemon provenance size mismatch");
	const actualIdentity = executableIdentity(artifact);
	if (actualIdentity !== undefined && actualIdentity !== provenance.executableIdentity)
		throw new Error("staged daemon provenance executable identity mismatch");
	return { kind: "staged", artifact: resolvedArtifact, provenancePath };
}

export function validateRustDaemonArtifact(input: RustDaemonArtifactInput): RustDaemonArtifactValidation {
	const artifact = resolve(input.artifact);
	const checkout = realpathSync(resolve(input.checkout));
	if (!existsSync(artifact) || !statSync(artifact).isFile()) throw new Error("daemon artifact must be a regular file");
	if (lstatSync(artifact).isSymbolicLink()) throw new Error("daemon artifact must not be a symlink");
	const resolvedArtifact = realpathSync(artifact);
	const relativeArtifact = relative(checkout, resolvedArtifact);
	const targetPrefix = ["platform", "rust-daemon", "target"].join(sep) + sep;
	if (
		!isAbsolute(relativeArtifact) &&
		!relativeArtifact.startsWith(`..${sep}`) &&
		relativeArtifact.startsWith(targetPrefix)
	)
		return { kind: "target", artifact: resolvedArtifact };
	const provenancePath = input.provenance
		? resolve(input.provenance)
		: provenanceCandidates(artifact).find((candidate) => existsSync(candidate));
	if (!provenancePath) throw new Error("staged daemon artifact requires adjacent provenance");
	return validateStagedArtifact(resolvedArtifact, checkout, provenancePath);
}
