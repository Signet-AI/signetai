import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isSignetManagedForgeRecord,
	loadForgeManifest,
	managedForgeAssetNameForPlatform,
	managedForgeInstallSupportedForPlatform,
	readForgeVersionFromBinaryMetadata,
	selectLatestStableForgeRelease,
	withManagedForgeInstallLock,
} from "./forge.js";

const originalHome = process.env.HOME;

afterEach(() => {
	if (originalHome === undefined) {
		process.env.HOME = undefined;
	} else {
		process.env.HOME = originalHome;
	}
});

describe("managed Forge release asset selection", () => {
	it("maps the published managed targets to release assets", () => {
		expect(managedForgeAssetNameForPlatform("darwin", "arm64")).toBe("forge-macos-arm64.tar.gz");
		expect(managedForgeAssetNameForPlatform("darwin", "x64")).toBe("forge-macos-x64.tar.gz");
		expect(managedForgeAssetNameForPlatform("linux", "x64")).toBe("forge-linux-x64.tar.gz");
		expect(managedForgeAssetNameForPlatform("linux", "arm64")).toBe("forge-linux-arm64.tar.gz");
	});

	it("rejects unsupported managed targets with a clear platform list", () => {
		expect(() => managedForgeAssetNameForPlatform("linux", "ppc64")).toThrow(
			"signet forge install/update currently publishes managed binaries for macOS arm64, macOS x64, Linux x64, and Linux arm64.",
		);
	});

	it("exposes the managed-install support matrix for setup gating", () => {
		expect(managedForgeInstallSupportedForPlatform("darwin", "arm64")).toBe(true);
		expect(managedForgeInstallSupportedForPlatform("linux", "arm64")).toBe(true);
		expect(managedForgeInstallSupportedForPlatform("win32", "x64")).toBe(false);
	});
});

describe("managed Forge ownership", () => {
	it("requires a matching managed install record before update ownership is granted", () => {
		expect(
			isSignetManagedForgeRecord(
				{
					managed: true,
					binaryPath: "/tmp/forge",
					source: "github-release",
				},
				"/tmp/forge",
			),
		).toBe(true);
		expect(
			isSignetManagedForgeRecord(
				{
					managed: true,
					binaryPath: "/tmp/other-forge",
					source: "github-release",
				},
				"/tmp/forge",
			),
		).toBe(false);
		expect(
			isSignetManagedForgeRecord(
				{
					managed: true,
					binaryPath: "/tmp/forge",
					source: "manual-copy",
				},
				"/tmp/forge",
			),
		).toBe(false);
	});
});

describe("stable Forge release selection", () => {
	it("ignores drafts and prereleases when choosing the default managed release", () => {
		const release = selectLatestStableForgeRelease(
			[
				{
					tag_name: "forge-v2.0.0-rc.1",
					html_url: "https://example.test/rc",
					draft: false,
					prerelease: true,
					assets: [],
				},
				{
					tag_name: "forge-v1.9.1",
					html_url: "https://example.test/stable-newest",
					draft: false,
					prerelease: false,
					assets: [],
				},
				{
					tag_name: "forge-v2.0.0",
					html_url: "https://example.test/draft",
					draft: true,
					prerelease: false,
					assets: [],
				},
			],
			{ tagPrefix: "forge-v", repository: "Signet-AI/signetai" },
		);

		expect(release.version).toBe("1.9.1");
		expect(release.tag).toBe("forge-v1.9.1");
	});

	it("fails clearly when only prereleases are available", () => {
		expect(() =>
			selectLatestStableForgeRelease(
				[
					{
						tag_name: "forge-v2.0.0-rc.1",
						html_url: "https://example.test/rc",
						draft: false,
						prerelease: true,
						assets: [],
					},
				],
				{ tagPrefix: "forge-v", repository: "Signet-AI/signetai" },
			),
		).toThrow("No stable Forge releases found in Signet-AI/signetai");
	});
});

describe("managed Forge manifest resolution", () => {
	it("prefers packages/forge/forge-version.json over the template copy when available", () => {
		const tempTemplates = mkdtempSync(join(tmpdir(), "forge-manifest-"));
		try {
			mkdirSync(join(tempTemplates, "forge"), { recursive: true });
			writeFileSync(
				join(tempTemplates, "forge", "manifest.json"),
				JSON.stringify({
					version: "0.0.0-test",
					tagPrefix: "wrong-v",
					repository: "wrong/repo",
					binary: "wrong",
				}),
			);

			const manifest = loadForgeManifest(() => tempTemplates);

			expect(manifest.repository).toBe("Signet-AI/signetai");
			expect(manifest.tagPrefix).toBe("forge-v");
			expect(manifest.binary).toBe("forge");
		} finally {
			rmSync(tempTemplates, { recursive: true, force: true });
		}
	});
});

describe("managed Forge install lock", () => {
	it("recovers a stale lock left behind by a dead process", async () => {
		const tempHome = mkdtempSync(join(tmpdir(), "forge-home-"));
		process.env.HOME = tempHome;
		try {
			const lockDir = join(tempHome, ".config", "signet", "bin", ".forge-install.lock");
			mkdirSync(lockDir, { recursive: true });
			writeFileSync(
				join(lockDir, "owner.json"),
				JSON.stringify({
					pid: 999_999,
					createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
				}),
			);
			const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
			utimesSync(lockDir, staleTime, staleTime);

			const result = await withManagedForgeInstallLock(async () => "ok", tempHome);

			expect(result).toBe("ok");
			expect(existsSync(lockDir)).toBe(false);
		} finally {
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("recovers a stale lock when pid metadata is invalid", async () => {
		const tempHome = mkdtempSync(join(tmpdir(), "forge-home-"));
		process.env.HOME = tempHome;
		try {
			const lockDir = join(tempHome, ".config", "signet", "bin", ".forge-install.lock");
			mkdirSync(lockDir, { recursive: true });
			writeFileSync(
				join(lockDir, "owner.json"),
				JSON.stringify({
					pid: "not-a-pid",
					createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
				}),
			);
			const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
			utimesSync(lockDir, staleTime, staleTime);

			const result = await withManagedForgeInstallLock(async () => "ok", tempHome);

			expect(result).toBe("ok");
			expect(existsSync(lockDir)).toBe(false);
		} finally {
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("does not treat lock as stale when the recorded pid is still alive", async () => {
		const tempHome = mkdtempSync(join(tmpdir(), "forge-home-"));
		process.env.HOME = tempHome;
		try {
			const lockDir = join(tempHome, ".config", "signet", "bin", ".forge-install.lock");
			mkdirSync(lockDir, { recursive: true });
			writeFileSync(
				join(lockDir, "owner.json"),
				JSON.stringify({
					pid: process.pid,
					createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
				}),
			);
			const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
			utimesSync(lockDir, staleTime, staleTime);

			await expect(
				(async () => {
					await withManagedForgeInstallLock(async () => "ok", tempHome);
				})(),
			).rejects.toThrow("already running");

			expect(existsSync(lockDir)).toBe(true);
		} finally {
			rmSync(tempHome, { recursive: true, force: true });
		}
	});
});

describe("Forge version metadata parsing", () => {
	it("extracts a semver version from passive binary metadata without executing the binary", () => {
		const tempHome = mkdtempSync(join(tmpdir(), "forge-version-"));
		try {
			const binaryPath = join(tempHome, "forge");
			writeFileSync(binaryPath, "Forge binary marker forge-v1.2.3 and build notes");
			expect(readForgeVersionFromBinaryMetadata(binaryPath)).toBe("1.2.3");
		} finally {
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("does not over-select unrelated higher semver strings in binary metadata", () => {
		const tempHome = mkdtempSync(join(tmpdir(), "forge-version-"));
		try {
			const binaryPath = join(tempHome, "forge");
			writeFileSync(binaryPath, "forge-v1.2.3 dependency-9.9.9 forge 1.2.3");
			expect(readForgeVersionFromBinaryMetadata(binaryPath)).toBe("1.2.3");
		} finally {
			rmSync(tempHome, { recursive: true, force: true });
		}
	});
});
