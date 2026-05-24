import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const nativeInstallCommand = "curl -fsSL https://signetai.sh/install.sh | bash";

function read(path: string): string {
	return readFileSync(join(root, path), "utf-8");
}

describe("install copy", () => {
	test("uses the native bundle as the primary public install path", () => {
		const primarySurfaces = [
			"README.md",
			"docs/QUICKSTART.md",
			"docs/CLI.md",
			"web/marketing/src/components/landing/Hero.astro",
			"web/marketing/src/components/landing/InstallCta.astro",
			"web/marketing/src/components/landing/Quickstart.astro",
			"web/marketing/public/skill.md",
			"dist/signetai/README.md",
		];

		for (const path of primarySurfaces) {
			expect(read(path)).toContain(nativeInstallCommand);
		}

		expect(read("docs/QUICKSTART.md")).not.toContain("# bun (recommended)");
		expect(read("docs/CLI.md")).not.toContain("# bun (recommended)");
	});

	test("serves the website install script as a native bundle shim", () => {
		const installer = read("web/marketing/public/install.sh");

		expect(installer).toContain("releases/download/bundle-latest/install.sh");
		expect(installer).not.toContain("SIGNET_INSTALLER_URL");
		expect(installer).toContain('curl -fsSL "$INSTALLER_URL" | bash');
		expect(installer).not.toContain("bash -c");
		expect(installer).not.toContain("bun add -g signetai");
		expect(installer).not.toContain("npm install -g signetai");
	});

	test("documents macOS package-manager attribution behavior", () => {
		for (const path of ["docs/QUICKSTART.md", "docs/CLI.md"]) {
			const content = read(path);
			expect(content).toContain("Background Activity");
			expect(content).toContain("runtime");
			expect(content).toContain("native bundle");
		}
	});
});
