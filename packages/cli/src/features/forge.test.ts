import { describe, expect, it } from "bun:test";
import { isSignetManagedForgeRecord, managedForgeAssetNameForPlatform } from "./forge.js";

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
