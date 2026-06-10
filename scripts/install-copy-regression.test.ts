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
		expect(manifest.files).toContain("native-manifest.json");
		expect(manifest.files).not.toContain("bin/signet-mcp.js");
		expect(launcher).toContain('join(packageDir, "native"');
		expect(launcher).toContain("resolveNativePackageBinaryPath");
		expect(launcher).toContain("require.resolve");
		expect(launcher).toContain("SIGNET_DIR");
		expect(nativePlatforms).toContain('"linux-x64"');
		expect(nativePlatforms).toContain('"linux-arm64"');
		expect(nativePlatforms).toContain('"darwin-x64"');
		expect(nativePlatforms).toContain('"darwin-arm64"');
		expect(nativePlatforms).toContain('"win32-x64"');
		expect(installer).toContain("linkSync");
		expect(installer).toContain("require.resolve");
		expect(installer).toContain("Skipping Signet native binary linking in workspace install");
		// Connector-asset install reads the manifest shipped with the
		// wrapper to discover the tarball URL and SHA-256. This is the
		// peer of the launch.js `SIGNET_DIR` wiring: the postinstall
		// extracts the connector plugin payload that the native binary
		// expects to find at `$SIGNET_DIR/runtime/connectors/...`.
		expect(installer).toContain("native-manifest.json");
		expect(installer).toContain("CONNECTOR_COMPONENT");
		expect(installer).toContain("verifySha256");
		expect(installer).toContain("signet-connectors-${manifest.version}.tar.gz");
		expect(installer).not.toContain("bun.sh/install");
		expect(installer).not.toContain("better-sqlite3");
	});

	test("curl installer downloads and verifies the connector-asset tarball", () => {
		const installer = read("web/marketing/public/install.sh");

		// The curl installer reads `components.connectors` from the
		// manifest, downloads the tarball, verifies its SHA-256, and
		// passes it to `signet install --connector-assets <path>` so the
		// native command can extract the assets next to the installed
		// binary.
		expect(installer).toContain("components.connectors");
		expect(installer).toContain("--connector-assets");
		expect(installer).toContain("install --connector-assets");
	});

	test("build-connector-assets stages runtime plugin assets into a tarball", () => {
		const buildScript = read("scripts/build-connector-assets.ts");
		expect(buildScript).toContain("signet-connectors-${version}.tar.gz");
		expect(buildScript).toContain("runtime/connectors");
		// The build script walks every `integrations/*/connector/` and
		// ships any non-source/asset dir under the runtime tree.
		expect(buildScript).toContain("integrations");
		expect(buildScript).toContain("hermes-plugin");
		// Skips build/test output dirs.
		expect(buildScript).toContain('"dist"');
		expect(buildScript).toContain('"node_modules"');
		expect(buildScript).toContain('"src"');
	});
});
