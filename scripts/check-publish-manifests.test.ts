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
