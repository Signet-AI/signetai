import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { whichWithoutBun } from "./which";

describe("whichWithoutBun", () => {
	test("resolves explicit relative executable paths against cwd", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-which-"));
		const previous = process.cwd();
		const binDir = join(root, "node_modules", ".bin");
		const bin = join(binDir, "acpx");
		mkdirSync(binDir, { recursive: true });
		writeFileSync(bin, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(bin, 0o755);

		try {
			process.chdir(root);
			expect(whichWithoutBun("./node_modules/.bin/acpx", "")).toBe(bin);
		} finally {
			process.chdir(previous);
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("returns null for missing explicit relative executable paths", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-which-missing-"));
		const previous = process.cwd();

		try {
			process.chdir(root);
			expect(whichWithoutBun("./node_modules/.bin/acpx", "")).toBeNull();
		} finally {
			process.chdir(previous);
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("searches PATH for bare executable names", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-which-path-"));
		const bin = join(root, "acpx");
		writeFileSync(bin, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(bin, 0o755);

		try {
			expect(whichWithoutBun("acpx", root)).toBe(bin);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
