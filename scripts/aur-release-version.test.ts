import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("AUR metadata uses a valid prerelease pkgver while retaining exact release URLs", () => {
	const dir = mkdtempSync(join(tmpdir(), "signet-aur-version-"));
	try {
		const aur = join(dir, "deploy/aur");
		mkdirSync(aur, { recursive: true });
		copyFileSync(join(import.meta.dir, "../deploy/aur/generate-pkgbuild.sh"), join(aur, "generate-pkgbuild.sh"));
		for (const version of ["1.0.1", "1.0.1-next.42", "1.0.1-check.42"]) {
			const url = `https://github.com/example/repo/releases/download/v${version}/Signet-${version}-linux-x86_64.AppImage`;
			const result = Bun.spawnSync(["bash", join(aur, "generate-pkgbuild.sh"), version, url, "a".repeat(64)]);
			expect(result.exitCode).toBe(0);
			const expected = version.replaceAll("-", "");
			expect(readFileSync(join(aur, "PKGBUILD"), "utf8")).toContain(`pkgver=${expected}\n`);
			expect(readFileSync(join(aur, ".SRCINFO"), "utf8")).toContain(`pkgver = ${expected}\n`);
			expect(readFileSync(join(aur, "PKGBUILD"), "utf8")).toContain(url);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
