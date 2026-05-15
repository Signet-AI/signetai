import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	collectManifestIssues,
	collectWorkspacePackages,
	isPublishableWorkspacePackage,
	listPublishableManifestTargets,
} from "./check-publish-manifests";

function writeJson(file: string, value: unknown): void {
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

describe("check-publish-manifests", () => {
	test("keeps threaded extraction worker in standalone daemon and meta-package builds", () => {
		const root = join(import.meta.dir, "..");
		const daemonBuild = readFileSync(join(root, "platform", "daemon", "build.ts"), "utf-8");
		const metaPackageBuild = readFileSync(join(root, "dist", "signetai", "build-daemon.ts"), "utf-8");

		expect(daemonBuild).toContain('entrypoint: "./src/pipeline/extraction-thread.ts"');
		expect(daemonBuild).toContain('outfile: "./dist/extraction-thread.js"');
		expect(metaPackageBuild).toContain('entrypoint: "../../platform/daemon/src/pipeline/extraction-thread.ts"');
		expect(metaPackageBuild).toContain('outfile: "./dist/extraction-thread.js"');
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

	test("keeps runtime split SQLite loader ESM-safe", () => {
		const root = join(import.meta.dir, "..");
		const dbSource = readFileSync(join(root, "platform", "daemon", "src", "db.ts"), "utf-8");

		expect(dbSource).toContain("createRequire(import.meta.url)");
		expect(dbSource).not.toContain('({ Database } = require("bun:sqlite"));');
	});

	test("installs bundle plugins under runtime/plugins", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");

		for (const script of [installer, updater]) {
			expect(script).toContain("component_runtime_path()");
			expect(script).toContain("cleanup_legacy_plugin_paths()");
			expect(script).toContain('plugin-*) printf \'%s/runtime/plugins/%s\' "$SIGNET_INSTALL_DIR" "${name#plugin-}" ;;');
		}
	});

	test("keeps bundle manifest fallback parser scoped to component fields", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");

		for (const script of [installer, updater]) {
			expect(script).toContain("ignoring nested metadata");
			expect(script).toContain("if (depth == 1)");
		}
	});

	test("validates archive paths from raw tar member names", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");

		for (const script of [installer, updater]) {
			expect(script).toContain('tar tzf "$archive"');
			expect(script).toContain("while IFS= read -r entry");
			expect(script).not.toContain('tar tvf "$archive"');
			expect(script).not.toContain("sed 's/^.* //'");
		}
	});

	test("fails macOS desktop bundle builds when expected artifacts are missing", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "bundle.yml"), "utf-8");

		expect(workflow).toContain("Electron build produced no macOS DMG");
		expect(workflow).toContain("Electron build produced no macOS zip");
		expect(workflow).not.toContain('cp release/*.dmg "$ARTIFACT_DIR/" 2>/dev/null || true');
		expect(workflow).not.toContain('cp release/*.zip "$ARTIFACT_DIR/" 2>/dev/null || true');
	});

	test("pins bundled Node runtime versions in CI", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "bundle.yml"), "utf-8");

		expect(workflow).toContain("BUNDLE_NODE_VERSION: 20.19.5");
		expect(workflow).toContain('NODE_VER="$BUNDLE_NODE_VERSION"');
		expect(workflow).not.toContain("NODE_VER=\"$(node --version | sed 's/^v//')\"");
	});

	test("packages CLI bundle with Node ESM metadata", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "bundle.yml"), "utf-8");

		expect(workflow).toContain('printf \'{"type":"module"}\\n\' > ./dist/package.json');
		expect(workflow).toContain('tar czf "$ARTIFACT_DIR/signet-cli.tar.gz" -C dist cli.js package.json');
		expect(workflow).not.toContain('tar czf "$ARTIFACT_DIR/signet-cli.tar.gz" -C dist cli.js\n');
	});

	test("smoke-checks native bundle artifact layout before release upload", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "bundle.yml"), "utf-8");

		expect(workflow).toContain("bundle-layout-check");
		expect(workflow).toContain('tar xzf "$MERGE_DIR/signet-cli.tar.gz" -C "$CHECK_DIR/runtime/cli"');
		expect(workflow).toContain('"$CHECK_DIR/runtime/cli/cli.js"');
		expect(workflow).toContain('"$CHECK_DIR/runtime/cli/package.json"');
		expect(workflow).toContain("Bundle artifact layout missing");
	});

	test("delegates updater reinstall without sharing the install lock trap", () => {
		const root = join(import.meta.dir, "..");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");

		expect(updater).toContain('INSTALLER="$TMPDIR/install.sh"');
		expect(updater).toContain("trap 'rm -rf \"$TMPDIR\"' EXIT");
		expect(updater).toContain('SIGNET_INSTALL_DIR="$SIGNET_INSTALL_DIR" bash "$INSTALLER"');
		expect(updater).not.toContain('curl -fsSL "${DOWNLOAD_BASE}/install.sh" |');
	});

	test("does not advertise unsupported versioned bundle installs", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");

		expect(installer).toContain('if [ "$SIGNET_VERSION" != "latest" ]; then');
		expect(installer).toContain("SIGNET_VERSION is not supported by the native bundle installer yet");
		expect(installer).not.toContain("SIGNET_VERSION      — version tag");
	});

	test("keeps bundle downloads pinned to expected release assets", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");

		for (const script of [installer, updater]) {
			expect(script).toContain("is_expected_asset_url()");
			expect(script).toContain('"$DOWNLOAD_BASE"/*');
			expect(script).toContain('signet-"$name".tar.gz|signet-"$name"-"$PLATFORM".tar.gz');
			expect(script).toContain("outside expected release assets");
		}
	});

	test("refuses remote manifests that drop installed components", () => {
		const root = join(import.meta.dir, "..");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");

		expect(updater).toContain("require_remote_manifest_superset()");
		expect(updater).toContain("Remote manifest dropped installed component");
		expect(updater).toContain("refusing update without explicit obsolete marker");
		expect(updater).not.toContain("Removing obsolete component:");
	});

	test("documents daemon-js as platform-specific", () => {
		const root = join(import.meta.dir, "..");
		const readme = readFileSync(join(root, "deploy", "bundle", "README.md"), "utf-8");

		expect(readme).toContain("| `daemon-js` | Daemon JS bundle with Node runtime dependencies | Yes |");
		expect(readme).not.toContain("| `daemon-js` | Daemon JS bundle | No |");
	});

	test("keeps manifest node fallback free of generated lookup code", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");

		for (const script of [installer, updater]) {
			expect(script).toContain("process.argv.slice(1)");
			expect(script).not.toContain("const parts='${key}'");
		}
		expect(updater).toContain("validate_component_name()");
		expect(updater).toContain("Manifest contains invalid component name");
		expect(updater).toContain("^[A-Za-z0-9_-]+$");
	});

	test("writes real bundle artifact sizes into manifests", () => {
		const root = join(import.meta.dir, "..");
		const generator = readFileSync(join(root, "deploy", "bundle", "scripts", "generate-manifest.ts"), "utf-8");

		expect(generator).toContain("statSync");
		expect(generator).toContain("size: statSync(join(artifactDir, file)).size");
		expect(generator).not.toContain("size: 0");
	});

	test("keeps Hermes plugin assets in the signetai publish package", () => {
		const root = join(import.meta.dir, "..");
		const manifest = JSON.parse(readFileSync(join(root, "dist", "signetai", "package.json"), "utf-8")) as {
			files?: unknown;
			scripts?: Record<string, string>;
		};

		expect(manifest.files).toContain("hermes-plugin");
		expect(manifest.scripts?.["copy:hermes-plugin"]).toContain(
			"../../integrations/hermes-agent/connector/hermes-plugin",
		);
		expect(manifest.scripts?.prebuild).toContain("copy:hermes-plugin");
		expect(existsSync(join(root, "integrations", "hermes-agent", "connector", "hermes-plugin", "__init__.py"))).toBe(
			true,
		);
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
		};

		expect(rootPackage.devDependencies?.["@signet/sdk"]).toBe("workspace:*");
		expect(rootPackage.scripts?.["build:deps"]).toStartWith("bun run --filter '@signet/sdk' build && ");
		expect(adapter.dependencies?.["@signet/sdk"]).toBeUndefined();
		expect(adapter.devDependencies?.["@signet/sdk"]).toBeDefined();

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
