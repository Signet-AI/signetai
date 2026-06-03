import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const nativeInstallCommand = "curl -fsSL https://signetai.sh/install.sh | bash";

function read(path: string): string {
	return readFileSync(join(root, path), "utf-8");
}

describe("install copy", () => {
	test("uses the native binary policy across public install paths", () => {
		const primarySurfaces = [
			"README.md",
			"docs/QUICKSTART.md",
			"docs/CLI.md",
			"web/marketing/src/components/landing/Hero.astro",
			"web/marketing/src/components/landing/InstallCta.astro",
			"web/marketing/src/components/landing/Quickstart.astro",
			"web/marketing/public/skill.md",
		];

		for (const path of primarySurfaces) {
			expect(read(path)).toContain(nativeInstallCommand);
		}

		for (const path of ["README.md", "docs/QUICKSTART.md", "docs/CLI.md", "dist/signetai/README.md"]) {
			const content = read(path);
			expect(content).toContain("same compiled Signet binary");
			expect(content).toContain("npm install -g signetai");
			expect(content).toContain("bun add -g signetai");
		}
	});

	test("serves the website install script as a native binary downloader", () => {
		const installer = read("web/marketing/public/install.sh");

		expect(installer).toContain("native-manifest.json");
		expect(installer).toContain('"$binary_path" install "$@"');
		expect(installer).toContain("Published Signet native binaries: linux-x64, darwin-x64, darwin-arm64, win32-x64");
		expect(installer).toContain("sha256sum");
		expect(installer).not.toContain("releases/download/bundle-latest");
		expect(installer).not.toContain("bun add -g signetai");
		expect(installer).not.toContain("npm install -g signetai");
		expect(installer).not.toContain("better-sqlite3");
	});

	test("keeps the npm package as a native binary wrapper", () => {
		const manifest = JSON.parse(read("dist/signetai/package.json")) as {
			dependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
			scripts?: Record<string, string>;
		};
		const wrapper = read("dist/signetai/bin/signet.js");
		const installer = read("dist/signetai/scripts/install-native.js");

		expect(manifest.scripts?.postinstall).toContain("scripts/install-native.js");
		expect(manifest.dependencies).toBeUndefined();
		expect(manifest.optionalDependencies).toBeUndefined();
		expect(wrapper).toContain('join(packageDir, "native"');
		expect(installer).toContain("native-manifest.json");
		expect(installer).toContain("createHash");
		expect(installer).toContain('"linux-x64", "darwin-x64", "darwin-arm64", "win32-x64"');
		expect(installer).toContain("Skipping Signet native binary download in workspace install");
		expect(installer).not.toContain("bun.sh/install");
		expect(installer).not.toContain("better-sqlite3");
	});
});
