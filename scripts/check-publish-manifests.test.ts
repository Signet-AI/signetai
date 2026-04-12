import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
			const signetaiDir = join(root, "packages", "signetai");
			const adapterDir = join(root, "packages", "adapters", "openclaw");
			const connectorDir = join(root, "packages", "connector-pi");
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
			const signetaiDir = join(root, "packages", "signetai");
			const connectorPiDir = join(root, "packages", "connector-pi");
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
			const signetaiDir = join(root, "packages", "signetai");
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
			const signetaiDir = join(root, "packages", "signetai");
			const adapterDir = join(root, "packages", "adapters", "openclaw");
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
			const adapterDir = join(root, "packages", "adapters", "openclaw");
			const coreDir = join(root, "packages", "core");
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
