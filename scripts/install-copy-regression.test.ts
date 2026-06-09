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
			expect(content).toContain("native package");
			expect(content).toContain("npm install -g signetai");
			expect(content).toContain("bun add -g signetai");
		}
	});

	test("serves the website install script as a native binary downloader", () => {
		const installer = read("web/marketing/public/install.sh");

		expect(installer).toContain("native-manifest.json");
		expect(installer).toContain("SIGNET_RELEASES_API_BASE");
		expect(installer).toContain("SIGNET_RELEASE_TAG");
		expect(installer).toContain('"$binary_path" install "$@"');
		expect(installer).toContain(
			"Published Signet native binaries: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64",
		);
		expect(installer).toContain("sha256sum");
		expect(installer).not.toContain("releases/latest/download");
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
			bin?: Record<string, string>;
			files?: string[];
		};
		const launcher = read("dist/signetai/bin/launch.js");
		const nativePlatforms = read("dist/signetai/bin/native-platforms.js");
		const installer = read("dist/signetai/scripts/install-native.js");

		expect(manifest.scripts?.postinstall).toContain("scripts/install-native.js");
		expect(manifest.dependencies).toBeUndefined();
		expect(manifest.optionalDependencies).toBeUndefined();
		expect(manifest.bin?.signet).toBe("bin/signet.js");
		// signet-mcp is the self-contained stdio JSON-RPC bundle, not a
		// wrapper that forwards to the native binary (issue #826).
		expect(manifest.bin?.["signet-mcp"]).toBe("dist/mcp-stdio.js");
		expect(manifest.files).toContain("dist/mcp-stdio.js");
		expect(manifest.files).not.toContain("bin/signet-mcp.js");
		expect(launcher).toContain('join(packageDir, "native"');
		expect(launcher).toContain("resolveNativePackageBinaryPath");
		expect(launcher).toContain("require.resolve");
		expect(nativePlatforms).toContain('"linux-x64"');
		expect(nativePlatforms).toContain('"linux-arm64"');
		expect(nativePlatforms).toContain('"darwin-x64"');
		expect(nativePlatforms).toContain('"darwin-arm64"');
		expect(nativePlatforms).toContain('"win32-x64"');
		expect(installer).toContain("linkSync");
		expect(installer).toContain("require.resolve");
		expect(installer).toContain("Skipping Signet native binary linking in workspace install");
		expect(installer).not.toContain("native-manifest.json");
		expect(installer).not.toContain("https");
		expect(installer).not.toContain("bun.sh/install");
		expect(installer).not.toContain("better-sqlite3");
	});
});
