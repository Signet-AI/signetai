import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	collectBundledNativePackageIssues,
	collectManifestIssues,
	collectNativeManifestIssues,
	collectWorkspacePackages,
	isPublishableWorkspacePackage,
	listPublishableManifestTargets,
	parseSupportedNativePlatforms,
} from "./check-publish-manifests";

function writeJson(file: string, value: unknown): void {
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

describe("check-publish-manifests", () => {
	test("keeps the nightly release manually triggerable", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf-8");

		expect(workflow).toContain("  workflow_dispatch:\n  push:");
	});

	test("keeps threaded extraction worker in standalone daemon and meta-package builds", () => {
		const root = join(import.meta.dir, "..");
		const daemonBuild = readFileSync(join(root, "platform", "daemon", "build.ts"), "utf-8");
		const metaPackageBuild = readFileSync(join(root, "dist", "signetai", "build-daemon.ts"), "utf-8");

		expect(daemonBuild).toContain('entrypoint: "./src/pipeline/extraction-thread.ts"');
		expect(daemonBuild).toContain('outfile: "./dist/extraction-thread.js"');
		expect(metaPackageBuild).toContain('entrypoint: "../../platform/daemon/src/pipeline/extraction-thread.ts"');
		expect(metaPackageBuild).toContain('outfile: "./dist/extraction-thread.js"');
	});

	test("keeps Docker build COPY sources present in the repository", () => {
		const root = join(import.meta.dir, "..");
		const dockerfile = readFileSync(join(root, "deploy", "docker", "Dockerfile"), "utf-8");
		const copySourcePattern = /^COPY (?<source>\S+) \S+$/gm;
		const missingSources: string[] = [];

		for (const match of dockerfile.matchAll(copySourcePattern)) {
			const source = match.groups?.source;
			if (source && !source.startsWith("--from=") && !existsSync(join(root, source))) {
				missingSources.push(source);
			}
		}

		expect(missingSources).toEqual([]);
		expect(dockerfile).toContain("RUN bun run build:native-bun");
		expect(dockerfile).toContain("COPY --from=build /app/dist/native/signet ./bin/signet");
		expect(dockerfile).not.toContain("/app/dist/signetai/dist");
		expect(dockerfile).not.toContain("/app/dist/signetai/dashboard");
		expect(dockerfile).not.toContain("/app/dist/signetai/skills");
	});

	test("keeps Node daemon build banner from colliding with esbuild require helper", () => {
		const root = join(import.meta.dir, "..");
		const daemonBuild = readFileSync(join(root, "platform", "daemon", "build.ts"), "utf-8");
		const metaPackageBuild = readFileSync(join(root, "dist", "signetai", "build-daemon.ts"), "utf-8");
		const banner = "const require = __createRequire(import.meta.url);";

		expect(daemonBuild).toContain(banner);
		expect(metaPackageBuild).toContain(banner);
		expect(daemonBuild).not.toContain("const __require =");
		expect(metaPackageBuild).not.toContain("const __require =");
	});

	test("routes forced daemon builds through the Node/esbuild path", () => {
		const root = join(import.meta.dir, "..");
		const daemonBuild = readFileSync(join(root, "platform", "daemon", "build.ts"), "utf-8");
		const metaPackageBuild = readFileSync(join(root, "dist", "signetai", "build-daemon.ts"), "utf-8");

		for (const buildScript of [daemonBuild, metaPackageBuild]) {
			expect(buildScript).toContain('const forceNodeBuild = process.env.FORCE_NODE_BUILD === "1";');
			expect(buildScript).toContain('const isBun = typeof Bun !== "undefined" && !forceNodeBuild;');
		}
	});

	test("keeps runtime split SQLite loader ESM-safe", () => {
		const root = join(import.meta.dir, "..");
		const dbSource = readFileSync(join(root, "platform", "daemon", "src", "db.ts"), "utf-8");
		const dbAccessorSource = readFileSync(join(root, "platform", "daemon", "src", "db-accessor.ts"), "utf-8");

		for (const source of [dbSource, dbAccessorSource]) {
			expect(source).toContain('import { createRequire } from "node:module";');
			expect(source).toContain("createRequire(import.meta.url)");
			expect(source).not.toContain('await import("node:module")');
		}
		expect(dbSource).not.toContain('({ Database } = require("bun:sqlite"));');
	});

	test("builds native Signet binaries in the release matrix", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf-8");
		const buildScript = readFileSync(join(root, "scripts", "build-native-bun.ts"), "utf-8");
		const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
			scripts?: Record<string, string>;
		};

		expect(rootPackage.scripts?.["build:native-bun"]).toBe("bun scripts/build-native-bun.ts");
		expect(buildScript).toContain("bun");
		expect(buildScript).toContain("build");
		expect(buildScript).toContain("--compile");
		expect(buildScript).toContain("bun-linux-arm64");
		expect(buildScript).toContain('createRequire(join(root, "platform", "daemon", "package.json"))');
		expect(buildScript).toContain("surfaces/cli/src/cli.ts");
		expect(buildScript).toContain('join(root, "surfaces", "cli", "templates")');
		expect(buildScript).toContain('join(root, "skills")');
		expect(buildScript).toContain("templateAssets");
		expect(buildScript).toContain("skillAssets");
		expect(buildScript).toContain("SIGNET_TEMPLATES_DIR");
		expect(buildScript).toContain("SIGNET_SKILLS_SOURCE");
		expect(buildScript).not.toContain('"@1password/sdk"');
		expect(workflow).toContain("build-native:");
		expect(workflow).toContain("platform: linux-x64");
		expect(workflow).toContain("asset: signet-linux-x64");
		expect(workflow).toContain("platform: linux-arm64");
		expect(workflow).toContain("asset: signet-linux-arm64");
		expect(workflow).toContain("os: ubuntu-24.04-arm");
		expect(workflow).toContain("platform: darwin-x64");
		expect(workflow).toContain("asset: signet-darwin-x64");
		expect(workflow).toContain("os: macos-15-intel");
		expect(workflow).not.toContain("os: macos-13");
		expect(workflow).toContain("platform: darwin-arm64");
		expect(workflow).toContain("asset: signet-darwin-arm64");
		expect(workflow).toContain("platform: win32-x64");
		expect(workflow).toContain("asset: signet-win32-x64.exe");
		expect(workflow.indexOf("run: bun run build:dashboard")).toBeLessThan(
			workflow.indexOf("run: bun run build:native-bun"),
		);
		expect(workflow).toContain("bun run build:native-bun");
		expect(workflow).toContain('./dist/native/"$RELEASE_ASSET" --help');
		expect(workflow).not.toContain("if: matrix.platform != 'linux-arm64'");
	});

	test("publishes native release assets, bundled npm assets, and the native manifest", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf-8");
		const promoteWorkflow = readFileSync(join(root, ".github", "workflows", "promote-release.yml"), "utf-8");
		const manifestScript = readFileSync(join(root, "scripts", "generate-native-manifest.ts"), "utf-8");

		expect(workflow).toContain('gh release download "v${NEW_VERSION}" --pattern "signet-*"');
		expect(workflow).toContain('SIGNET_VERSION="$NEW_VERSION" bun scripts/generate-native-manifest.ts');
		expect(workflow).toContain("dist/native/native-manifest.json");
		expect(workflow.indexOf('SIGNET_VERSION="$NEW_VERSION" bun scripts/generate-native-manifest.ts')).toBeLessThan(
			workflow.indexOf("bun scripts/check-publish-manifests.ts"),
		);
		expect(workflow.indexOf('SIGNET_VERSION="$NEW_VERSION" bun scripts/generate-native-manifest.ts')).toBeLessThan(
			workflow.indexOf('stage_bundled_binary "linux-x64" "signet-linux-x64" "signet"'),
		);
		expect(workflow.indexOf('stage_bundled_binary "win32-x64" "signet-win32-x64.exe" "signet.exe"')).toBeLessThan(
			workflow.indexOf("bun scripts/check-publish-manifests.ts"),
		);
		expect(workflow.indexOf("bun scripts/check-publish-manifests.ts")).toBeLessThan(
			workflow.indexOf("publish_npm_package dist/signetai\n"),
		);
		expect(workflow).toContain('stage_bundled_binary "linux-x64" "signet-linux-x64" "signet"');
		expect(workflow).toContain('stage_bundled_binary "linux-arm64" "signet-linux-arm64" "signet"');
		expect(workflow).toContain('stage_bundled_binary "darwin-x64" "signet-darwin-x64" "signet"');
		expect(workflow).toContain('stage_bundled_binary "darwin-arm64" "signet-darwin-arm64" "signet"');
		expect(workflow).toContain('stage_bundled_binary "win32-x64" "signet-win32-x64.exe" "signet.exe"');
		expect(workflow).not.toContain("publish_npm_package dist/signetai-linux-x64");
		expect(workflow).not.toContain("publish_npm_package dist/signetai-linux-arm64");
		expect(workflow).not.toContain("publish_npm_package dist/signetai-darwin-x64");
		expect(workflow).not.toContain("publish_npm_package dist/signetai-darwin-arm64");
		expect(workflow).not.toContain("publish_npm_package dist/signetai-win32-x64");
		expect(workflow).toContain('npm dist-tag add "${package_name}@${NEW_VERSION}" next');
		expect(workflow).toContain("NPM_CONFIG_USERCONFIG: ${{ runner.temp }}/.npmrc");
		expect(workflow).toContain("npm publish --tag next --access public");
		expect(workflow).toContain('gh release edit "v${NEW_VERSION}" --draft=false');
		expect(workflow.indexOf("publish_npm_package dist/signetai\n")).toBeLessThan(
			workflow.indexOf('gh release edit "v${NEW_VERSION}" --draft=false'),
		);
		expect(workflow).not.toContain("npm publish --access public");
		expect(workflow).not.toContain("bundle-latest");
		expect(workflow).not.toContain("deploy/bundle");
		expect(promoteWorkflow).not.toContain('"signetai-linux-x64"');
		expect(promoteWorkflow).not.toContain('"signetai-linux-arm64"');
		expect(promoteWorkflow).not.toContain('"signetai-darwin-x64"');
		expect(promoteWorkflow).not.toContain('"signetai-darwin-arm64"');
		expect(promoteWorkflow).not.toContain('"signetai-win32-x64"');
		expect(promoteWorkflow).toContain('"signetai"');
		expect(promoteWorkflow).toContain('npm view "${package}@${VERSION}" version >/dev/null');
		expect(promoteWorkflow).toContain('npm dist-tag add "${package}@${VERSION}" latest');
		expect(promoteWorkflow).toContain('npm dist-tag add "@signetai/signet-memory-openclaw@${VERSION}" latest || true');
		expect(promoteWorkflow).toContain("NPM_CONFIG_USERCONFIG: ${{ runner.temp }}/.npmrc");
		expect(manifestScript).toContain('name.endsWith(".sha256")');
		expect(manifestScript).toContain("native-manifest.json");
	});

	test("validates generated native manifest coverage against the npm wrapper", () => {
		const installerSource = `
			export const nativePlatforms = {
				"linux-x64": {},
				"linux-arm64": {},
				"darwin-x64": {},
				"darwin-arm64": {},
				"win32-x64": {},
			};
		`;
		const supportedPlatforms = parseSupportedNativePlatforms(installerSource);
		const validSha = "a".repeat(64);

		expect(supportedPlatforms).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
		expect(
			collectNativeManifestIssues(
				{
					schemaVersion: 1,
					version: "0.1.0",
					assets: supportedPlatforms.map((platform) => ({
						name: platform.startsWith("win32-") ? `signet-${platform}.exe` : `signet-${platform}`,
						platform,
						sha256: validSha,
						size: 1,
					})),
				},
				supportedPlatforms,
			),
		).toEqual([]);

		expect(
			collectNativeManifestIssues(
				{
					schemaVersion: 1,
					version: "0.1.0",
					assets: [
						{
							name: "signet-linux-x64",
							platform: "linux-x64",
							sha256: validSha,
							size: 1,
						},
					],
				},
				supportedPlatforms,
			),
		).toContainEqual({
			file: "dist/native/native-manifest.json",
			reason:
				"platforms must match npm wrapper support: expected darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64, got linux-x64",
		});
	});

	test("validates bundled native package binaries", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-native-bundle-"));
		try {
			const packageDir = join(root, "dist", "signetai");
			const packageFile = join(packageDir, "package.json");
			mkdirSync(join(packageDir, "bin"), { recursive: true });
			writeJson(packageFile, { name: "signetai", version: "0.1.0", publishConfig: { access: "public" } });
			writeFileSync(
				join(packageDir, "bin", "native-platforms.js"),
				`export const nativePlatforms = {\n\t"linux-x64": { binaryName: "signet" },\n};\n`,
			);

			expect(collectBundledNativePackageIssues([packageFile])).toContainEqual({
				file: packageFile,
				reason: `missing bundled native binary ${join(packageDir, "native", "linux-x64", "signet")}`,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("keeps curl install as a thin verified native-binary downloader", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "web", "marketing", "public", "install.sh"), "utf-8");

		expect(installer).toContain("native-manifest.json");
		expect(installer).toContain("SIGNET_RELEASES_API_BASE");
		expect(installer).toContain("SIGNET_RELEASE_TAG");
		expect(installer).toContain("sha256sum");
		expect(installer).toContain("shasum -a 256");
		expect(installer).toContain(
			"Published Signet native binaries: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64",
		);
		expect(installer).toContain('"$binary_path" install "$@"');
		expect(installer).not.toContain("bun add -g signetai");
		expect(installer).not.toContain("npm install -g signetai");
		expect(installer).not.toContain("bun.sh/install");
		expect(installer).not.toContain("better-sqlite3");
		expect(installer).not.toContain("releases/latest/download");
		expect(installer).not.toContain("releases/download/bundle-latest");
	});

	test("keeps the signetai package as a thin publishable native wrapper", () => {
		const root = join(import.meta.dir, "..");
		const manifest = JSON.parse(readFileSync(join(root, "dist", "signetai", "package.json"), "utf-8")) as {
			name?: string;
			dependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
			files?: string[];
			publishConfig?: unknown;
			scripts?: Record<string, string>;
			bin?: Record<string, string>;
		};
		const launcher = readFileSync(join(root, "dist", "signetai", "bin", "launch.js"), "utf-8");
		const nativePlatforms = readFileSync(join(root, "dist", "signetai", "bin", "native-platforms.js"), "utf-8");
		const mcpBin = readFileSync(join(root, "dist", "signetai", "bin", "signet-mcp.js"), "utf-8");
		const installer = readFileSync(join(root, "dist", "signetai", "scripts", "install-native.js"), "utf-8");

		expect(manifest.name).toBe("signetai");
		expect(manifest.publishConfig).toEqual({ access: "public" });
		expect(manifest.dependencies).toBeUndefined();
		expect(manifest.optionalDependencies).toBeUndefined();
		expect(manifest.files).toContain("native/**");
		expect(manifest.scripts?.postinstall).toContain("scripts/install-native.js");
		expect(manifest.bin?.signet).toBe("bin/signet.js");
		expect(manifest.bin?.["signet-mcp"]).toBe("bin/signet-mcp.js");
		expect(launcher).toContain('join(packageDir, "native"');
		expect(launcher).toContain("resolveBundledBinaryPath");
		expect(launcher).not.toContain("require.resolve");
		expect(nativePlatforms).toContain('"linux-x64"');
		expect(nativePlatforms).toContain('"linux-arm64"');
		expect(nativePlatforms).toContain('"darwin-x64"');
		expect(nativePlatforms).toContain('"darwin-arm64"');
		expect(nativePlatforms).toContain('"win32-x64"');
		expect(nativePlatforms).not.toContain("packageName");
		expect(mcpBin).toContain("forceMcp: true");
		expect(installer).toContain("linkSync");
		expect(installer).not.toContain("require.resolve");
		expect(installer).toContain("Linked bundled Signet native binary");
		expect(installer).not.toContain("native-manifest.json");
		expect(installer).not.toContain("https");
		expect(installer).not.toContain("better-sqlite3");
	});

	test("treats manifests with publishConfig.access public as publishable", () => {
		expect(
			isPublishableWorkspacePackage({
				name: "signetai",
				publishConfig: { access: "public" },
			}),
		).toBe(true);
	});

	test("discovers publishable manifest targets from workspace files", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-publish-manifests-"));
		try {
			const signetaiDir = join(root, "dist", "signetai");
			const adapterDir = join(root, "integrations", "openclaw", "memory-adapter");
			const connectorDir = join(root, "integrations", "pi", "connector");
			mkdirSync(signetaiDir, { recursive: true });
			mkdirSync(adapterDir, { recursive: true });
			mkdirSync(connectorDir, { recursive: true });

			const signetaiFile = join(signetaiDir, "package.json");
			const adapterFile = join(adapterDir, "package.json");
			const connectorFile = join(connectorDir, "package.json");

			writeJson(signetaiFile, {
				name: "signetai",
				publishConfig: { access: "public" },
			});
			writeJson(adapterFile, {
				name: "@signetai/signet-memory-openclaw",
				publishConfig: { access: "public" },
			});
			writeJson(connectorFile, {
				name: "@signet/connector-pi",
			});

			expect(listPublishableManifestTargets([signetaiFile, adapterFile, connectorFile])).toEqual([
				signetaiFile,
				adapterFile,
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("flags runtime dependencies on unpublished workspace packages", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-publish-manifests-"));
		try {
			const signetaiDir = join(root, "dist", "signetai");
			const connectorPiDir = join(root, "integrations", "pi", "connector");
			mkdirSync(signetaiDir, { recursive: true });
			mkdirSync(connectorPiDir, { recursive: true });

			const signetaiFile = join(signetaiDir, "package.json");
			const connectorPiFile = join(connectorPiDir, "package.json");

			writeJson(signetaiFile, {
				name: "signetai",
				version: "1.2.3",
				dependencies: {
					"@signet/connector-pi": "1.2.3",
				},
			});
			writeJson(connectorPiFile, {
				name: "@signet/connector-pi",
				version: "1.2.3",
			});

			const workspacePackages = collectWorkspacePackages([signetaiFile, connectorPiFile]);
			const issues = collectManifestIssues([signetaiFile], workspacePackages);

			expect(issues).toHaveLength(1);
			expect(issues[0]?.reason).toContain("not published");
			expect(issues[0]?.dep).toBe("@signet/connector-pi");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("flags workspace protocol in runtime dependency fields", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-publish-manifests-"));
		try {
			const signetaiDir = join(root, "dist", "signetai");
			mkdirSync(signetaiDir, { recursive: true });

			const signetaiFile = join(signetaiDir, "package.json");
			writeJson(signetaiFile, {
				name: "signetai",
				version: "1.2.3",
				dependencies: {
					"@signet/connector-pi": "workspace:*",
				},
			});

			const workspacePackages = collectWorkspacePackages([signetaiFile]);
			const issues = collectManifestIssues([signetaiFile], workspacePackages);

			expect(issues).toHaveLength(1);
			expect(issues[0]?.reason).toContain("workspace protocol");
			expect(issues[0]?.field).toBe("dependencies");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("keeps bundled Signet internals out of the OpenClaw adapter runtime manifest", () => {
		const root = join(import.meta.dir, "..");
		const rootPackageFile = join(root, "package.json");
		const adapterFile = join(root, "integrations", "openclaw", "memory-adapter", "package.json");
		const sdkFile = join(root, "libs", "sdk", "package.json");
		const coreFile = join(root, "platform", "core", "package.json");

		const rootPackage = JSON.parse(readFileSync(rootPackageFile, "utf-8")) as {
			devDependencies?: Record<string, string>;
			scripts?: Record<string, string>;
		};
		const adapter = JSON.parse(readFileSync(adapterFile, "utf-8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
			peerDependenciesMeta?: Record<string, { optional?: boolean }>;
		};

		expect(rootPackage.devDependencies?.["@signet/sdk"]).toBe("workspace:*");
		expect(rootPackage.scripts?.["build:deps"]).toStartWith("bun run --filter '@signet/sdk' build && ");
		expect(adapter.dependencies?.["@signet/sdk"]).toBeUndefined();
		expect(adapter.devDependencies?.["@signet/sdk"]).toBeDefined();
		expect(adapter.peerDependencies?.openclaw).toBe(">=2026.5.22");
		expect(adapter.peerDependenciesMeta?.openclaw?.optional).toBe(true);

		const workspacePackages = collectWorkspacePackages([adapterFile, sdkFile, coreFile]);

		expect(collectManifestIssues([adapterFile], workspacePackages)).toHaveLength(0);

		const releaseRewrittenAdapterDir = mkdtempSync(join(tmpdir(), "signet-openclaw-release-manifest-"));
		try {
			const releaseRewrittenAdapterFile = join(releaseRewrittenAdapterDir, "package.json");
			writeJson(releaseRewrittenAdapterFile, {
				...JSON.parse(readFileSync(adapterFile, "utf-8")),
				version: "1.2.3",
				devDependencies: {
					...adapter.devDependencies,
					"@signet/core": "1.2.3",
					"@signet/sdk": "1.2.3",
				},
			});

			expect(collectManifestIssues([releaseRewrittenAdapterFile], workspacePackages)).toHaveLength(0);
		} finally {
			rmSync(releaseRewrittenAdapterDir, { recursive: true, force: true });
		}
	});

	test("allows runtime dependencies on publishable workspace packages", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-publish-manifests-"));
		try {
			const signetaiDir = join(root, "dist", "signetai");
			const adapterDir = join(root, "integrations", "openclaw", "memory-adapter");
			mkdirSync(signetaiDir, { recursive: true });
			mkdirSync(adapterDir, { recursive: true });

			const signetaiFile = join(signetaiDir, "package.json");
			const adapterFile = join(adapterDir, "package.json");

			writeJson(signetaiFile, {
				name: "signetai",
				version: "1.2.3",
				publishConfig: { access: "public" },
				dependencies: {
					"@signetai/signet-memory-openclaw": "1.2.3",
				},
			});
			writeJson(adapterFile, {
				name: "@signetai/signet-memory-openclaw",
				version: "1.2.3",
				publishConfig: { access: "public" },
			});

			const workspacePackages = collectWorkspacePackages([signetaiFile, adapterFile]);
			const issues = collectManifestIssues([signetaiFile], workspacePackages);

			expect(issues).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("ignores devDependencies on workspace packages for publish checks", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-publish-manifests-"));
		try {
			const adapterDir = join(root, "integrations", "openclaw", "memory-adapter");
			const coreDir = join(root, "platform", "core");
			mkdirSync(adapterDir, { recursive: true });
			mkdirSync(coreDir, { recursive: true });

			const adapterFile = join(adapterDir, "package.json");
			const coreFile = join(coreDir, "package.json");

			writeJson(adapterFile, {
				name: "@signetai/signet-memory-openclaw",
				version: "1.2.3",
				publishConfig: { access: "public" },
				dependencies: {
					"@sinclair/typebox": "0.34.47",
				},
				devDependencies: {
					"@signet/core": "workspace:*",
				},
			});
			writeJson(coreFile, {
				name: "@signet/core",
				version: "1.2.3",
			});

			const workspacePackages = collectWorkspacePackages([adapterFile, coreFile]);
			const issues = collectManifestIssues([adapterFile], workspacePackages);

			expect(issues).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
