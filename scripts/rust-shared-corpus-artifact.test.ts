import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { validateRustDaemonArtifact } from "./rust-shared-corpus-artifact";

type Overrides = Partial<{
	target: string;
	rustToolchain: string;
	cargoLockSha256: string;
	sha256: string;
}>;

function stagedFixture(overrides: Overrides = {}) {
	const directory = `/mnt/work/hermes-scratch/staged-rust-daemon-${process.pid}`;
	const artifact = `${directory}/linux-x64/signet-daemon`;
	const provenance = `${directory}/provenance.json`;
	rmSync(directory, { recursive: true, force: true });
	mkdirSync(resolve(artifact, ".."), { recursive: true });
	const bytes = Buffer.from("fresh-rust-test-artifact");
	writeFileSync(artifact, bytes);
	const revision = String(spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout).trim();
	const rustVersion = String(spawnSync("rustc", ["--version"], { encoding: "utf8" }).stdout).trim();
	const rustHost = (
		String(spawnSync("rustc", ["-vV"], { encoding: "utf8" }).stdout).match(/^host:\s*(.+)$/m)?.[1] ?? ""
	).trim();
	const lockHash = createHash("sha256")
		.update(readFileSync(resolve(process.cwd(), "platform/rust-daemon/Cargo.lock")))
		.digest("hex");
	const identityResult = spawnSync("file", ["-b", artifact], { encoding: "utf8" });
	const identity = String(identityResult.stdout).trim() || "test executable";
	writeFileSync(
		provenance,
		JSON.stringify({
			artifact,
			target: overrides.target ?? rustHost ?? "x86_64-unknown-linux-gnu",
			rustToolchain: overrides.rustToolchain ?? rustVersion,
			cargoLockSha256: overrides.cargoLockSha256 ?? lockHash,
			sourceRevision: revision,
			sha256: overrides.sha256 ?? createHash("sha256").update(bytes).digest("hex"),
			size: bytes.length,
			executableIdentity: identity,
		}),
	);
	return { directory, artifact, provenance };
}

describe("Rust shared-corpus artifact admission", () => {
	test("accepts a staged Rust daemon when provenance binds it to the current revision", () => {
		const fixture = stagedFixture();
		try {
			expect(validateRustDaemonArtifact({ ...fixture, checkout: process.cwd() }).kind).toBe("staged");
		} finally {
			rmSync(fixture.directory, { recursive: true, force: true });
		}
	});

	test("rejects staged metadata that does not match the current Rust build", () => {
		const fixture = stagedFixture({ target: "forged-target" });
		try {
			expect(() => validateRustDaemonArtifact({ ...fixture, checkout: process.cwd() })).toThrow(
				/staged daemon provenance target mismatch/,
			);
		} finally {
			rmSync(fixture.directory, { recursive: true, force: true });
		}
	});

	test("rejects a staged executable whose bytes do not match provenance", () => {
		const fixture = stagedFixture();
		try {
			writeFileSync(fixture.artifact, "tampered-artifact");
			expect(() => validateRustDaemonArtifact({ ...fixture, checkout: process.cwd() })).toThrow(
				/staged daemon provenance checksum mismatch/,
			);
		} finally {
			rmSync(fixture.directory, { recursive: true, force: true });
		}
	});
});
