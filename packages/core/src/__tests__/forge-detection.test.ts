import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSignetForgeBinary, isCompatibleForgeBinary, isSignetForgeBinary } from "../identity";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeBinary(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-forge-detect-"));
	tempDirs.push(dir);
	const file = join(dir, "forge");
	writeFileSync(file, contents);
	chmodSync(file, 0o755);
	return file;
}

describe("Forge binary detection", () => {
	it("accepts strict Signet Forge fingerprints for managed install verification", () => {
		const binary = makeBinary("Signet's native AI terminal");
		expect(isSignetForgeBinary(binary)).toBe(true);
		expect(isCompatibleForgeBinary(binary)).toBe(true);
	});

	it("accepts standalone/source Forge compatibility fingerprints for passive detection", () => {
		const binary = makeBinary(["Forge — First Run", "FORGE_SIGNET_TOKEN", "Dashboard (Ctrl+D)"].join("\n"));
		expect(isSignetForgeBinary(binary)).toBe(false);
		expect(isCompatibleForgeBinary(binary)).toBe(true);
	});

	it("rejects unrelated forge-named binaries", () => {
		const binary = makeBinary(["forge", "solidity", "build contracts"].join("\n"));
		expect(isSignetForgeBinary(binary)).toBe(false);
		expect(isCompatibleForgeBinary(binary)).toBe(false);
	});

	it("detects compatible local/source builds under the workspace even when they are not on PATH", () => {
		const workspace = mkdtempSync(join(tmpdir(), "signet-forge-workspace-"));
		tempDirs.push(workspace);
		const binary = join(workspace, "packages", "forge", "target", "release", "forge");
		mkdirSync(join(workspace, "packages", "forge", "target", "release"), { recursive: true });
		writeFileSync(binary, ["Forge — First Run", "FORGE_SIGNET_TOKEN", "Dashboard (Ctrl+D)"].join("\n"));
		chmodSync(binary, 0o755);

		expect(findSignetForgeBinary(workspace, "/nonexistent-home")).toBe(binary);
	});
});
