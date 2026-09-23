import { chmodSync, cpSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { verifyPackagedArtifactProvenance, verifyStagedArtifact } from "./native-artifact-provenance";

describe("staged Rust artifact provenance", () => {
	it("records and verifies identity outside the checkout", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-provenance-"));
		const checkout = join(root, "checkout");
		const staged = join(root, "staged");
		mkdirSync(join(checkout, "platform/rust-daemon"), { recursive: true });
		mkdirSync(staged, { recursive: true });
		const source = join(checkout, "platform/rust-daemon/signet-daemon");
		const artifact = join(staged, "signet-daemon");
		writeFileSync(source, "#!/bin/sh\nexit 0\n");
		writeFileSync(join(checkout, "platform/rust-daemon/Cargo.lock"), "lockfile");
		chmodSync(source, 0o755);
		cpSync(source, artifact);
		const provenance = verifyStagedArtifact({
			artifact,
			checkout,
			target: "x86_64-unknown-linux-gnu",
			sourceRevision: "0123456789abcdef0123456789abcdef01234567",
			cargoLock: join(checkout, "platform/rust-daemon/Cargo.lock"),
		});
		expect(provenance.target).toBe("x86_64-unknown-linux-gnu");
		expect(provenance.sourceRevision).toMatch(/^[0-9a-f]{40}$/);
		expect(provenance.cargoLockSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(provenance.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(provenance.size).toBeGreaterThan(0);
		expect(provenance.rustToolchain).toContain("rustc");
		expect(provenance.executableIdentity).toContain("script");
		expect(provenance.artifact).toBe(artifact);
		expect(artifact.startsWith(checkout)).toBe(false);
	});

	it("rejects an artifact symlink that resolves inside the checkout", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-provenance-boundary-"));
		const checkout = join(root, "checkout");
		const staged = join(root, "staged");
		mkdirSync(join(checkout, "platform/rust-daemon"), { recursive: true });
		mkdirSync(staged, { recursive: true });
		const source = join(checkout, "platform/rust-daemon/signet-daemon");
		writeFileSync(source, "#!/bin/sh\nexit 0\n");
		chmodSync(source, 0o755);
		writeFileSync(join(checkout, "platform/rust-daemon/Cargo.lock"), "lockfile");
		symlinkSync(source, join(staged, "signet-daemon"));
		expect(() =>
			verifyStagedArtifact({
				artifact: join(staged, "signet-daemon"),
				checkout,
				target: "x86_64-unknown-linux-gnu",
				sourceRevision: "0123456789abcdef0123456789abcdef01234567",
				cargoLock: join(checkout, "platform/rust-daemon/Cargo.lock"),
			}),
		).toThrow("artifact must be staged outside checkout");
	});

	it("rejects tampered packaged metadata", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-provenance-tamper-"));
		const checkout = join(root, "checkout");
		const staged = join(root, "staged");
		mkdirSync(join(checkout, "platform/rust-daemon"), { recursive: true });
		mkdirSync(staged, { recursive: true });
		const artifact = join(staged, "signet-daemon");
		writeFileSync(artifact, "#!/bin/sh\nexit 0\n");
		chmodSync(artifact, 0o755);
		writeFileSync(join(checkout, "platform/rust-daemon/Cargo.lock"), "lockfile");
		const actual = verifyStagedArtifact({
			artifact,
			checkout,
			target: "x86_64-unknown-linux-gnu",
			sourceRevision: "0123456789abcdef0123456789abcdef01234567",
			cargoLock: join(checkout, "platform/rust-daemon/Cargo.lock"),
		});
		expect(() =>
			verifyPackagedArtifactProvenance(
				{ artifact, checkout, cargoLock: join(checkout, "platform/rust-daemon/Cargo.lock") },
				{ ...actual, sha256: "0".repeat(64) },
			),
		).toThrow("sha256 mismatch");
	});
});
