import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { validateRustDaemonArtifact } from "./rust-shared-corpus-artifact";

describe("Rust shared-corpus artifact admission", () => {
	test("accepts a staged Rust daemon when provenance binds it to the current revision", () => {
		const directory = `/mnt/work/hermes-scratch/staged-rust-daemon-${process.pid}`;
		const artifact = `${directory}/linux-x64/signet-daemon`;
		const provenance = `${directory}/provenance.json`;
		rmSync(directory, { recursive: true, force: true });
		mkdirSync(resolve(artifact, ".."), { recursive: true });
		const bytes = Buffer.from("fresh-rust-test-artifact");
		writeFileSync(artifact, bytes);
		const revision = String(spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout).trim();
		const identityResult = spawnSync("file", ["-b", artifact], { encoding: "utf8" });
		const identity = String(identityResult.stdout).trim() || "test executable";
		writeFileSync(
			provenance,
			JSON.stringify({
				artifact,
				target: "x86_64-unknown-linux-gnu",
				rustToolchain: "rustc 1.91.1",
				cargoLockSha256: "0".repeat(64),
				sourceRevision: revision,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				size: bytes.length,
				executableIdentity: identity,
			}),
		);
		try {
			expect(validateRustDaemonArtifact({ artifact, provenance, checkout: process.cwd() }).kind).toBe("staged");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
