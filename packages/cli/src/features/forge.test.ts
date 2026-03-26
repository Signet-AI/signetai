import { describe, expect, it } from "bun:test";
import { managedForgeAssetNameForPlatform } from "./forge.js";

describe("managed Forge release asset selection", () => {
	it("maps the published managed targets to release assets", () => {
		expect(managedForgeAssetNameForPlatform("darwin", "arm64")).toBe("forge-macos-arm64.tar.gz");
		expect(managedForgeAssetNameForPlatform("darwin", "x64")).toBe("forge-macos-x64.tar.gz");
		expect(managedForgeAssetNameForPlatform("linux", "x64")).toBe("forge-linux-x64.tar.gz");
	});

	it("rejects linux arm64 because no managed release asset is published", () => {
		expect(() => managedForgeAssetNameForPlatform("linux", "arm64")).toThrow(
			"signet forge install/update currently publishes managed binaries for macOS arm64, macOS x64, and Linux x64.",
		);
	});
});
