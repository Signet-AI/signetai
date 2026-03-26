import { describe, expect, it } from "bun:test";
import {
	isSignetManagedForgeRecord,
	managedForgeAssetNameForPlatform,
	managedForgeInstallSupportedForPlatform,
	selectLatestStableForgeRelease,
} from "./forge.js";

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
