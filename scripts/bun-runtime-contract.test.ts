import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const root = resolve(import.meta.dir, "..");
const requiredVersion = "1.4.2";

function text(path: string): string {
	return readFileSync(join(root, path), "utf8");
}

describe("Bun runtime contract", () => {
	test("pins one qualified Bun version across package and image builds", () => {
		const pkg = JSON.parse(text("package.json")) as {
			readonly packageManager?: string;
			readonly devDependencies?: Readonly<Record<string, string>>;
		};
		expect(pkg.packageManager).toBe(`bun@${requiredVersion}`);
		expect(pkg.devDependencies?.["bun-types"]).toBe(requiredVersion);

		const lock = text("bun.lock");
		expect(lock).toContain(`"bun-types": "${requiredVersion}"`);

		const dockerfile = text("deploy/docker/Dockerfile");
		expect(dockerfile.match(new RegExp(`FROM oven/bun:${requiredVersion}`, "g"))?.length).toBe(2);

		const workflowsDir = join(root, ".github", "workflows");
		const setupWithoutPinnedPackage: string[] = [];
		const divergentPins: Array<{ name: string; line: string; number: number }> = [];
		for (const name of readdirSync(workflowsDir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))) {
			const lines = readFileSync(join(workflowsDir, name), "utf8").split("\n");
			for (const [index, line] of lines.entries()) {
				if (/^\s*bun-version:\s*/.test(line)) divergentPins.push({ name, line, number: index + 1 });
				if (line.includes("uses: oven-sh/setup-bun@v2")) {
					const block = lines.slice(index + 1, index + 4).join("\n");
					if (!block.includes("bun-version-file: package.json")) setupWithoutPinnedPackage.push(`${name}:${index + 1}`);
				}
			}
		}
		expect(divergentPins).toEqual([]);
		expect(setupWithoutPinnedPackage).toEqual([]);
	});

	test("the compiled executable exposes and release CI verifies its embedded runtime", () => {
		const buildScript = text("scripts/build-native-bun.ts");
		expect(buildScript).toContain("SIGNET_RUNTIME_VERSION_SMOKE");
		expect(buildScript).toContain("Bun.version");

		const releaseWorkflow = text(".github/workflows/release.yml");
		expect(releaseWorkflow).toContain("Verify embedded Bun runtime");
		expect(releaseWorkflow).toContain("SIGNET_RUNTIME_VERSION_SMOKE");
		expect(releaseWorkflow).toMatch(/- os: xcode-27\s+platform: darwin-arm64\s+asset: signet-darwin-arm64/);

		const nativeFirstUse = text(".github/workflows/native-first-use.yml");
		for (const [platform, asset] of [
			["linux-x64", "signet-linux-x64"],
			["linux-arm64", "signet-linux-arm64"],
			["darwin-x64", "signet-darwin-x64"],
			["darwin-arm64", "signet-darwin-arm64"],
			["win32-x64", "signet-win32-x64.exe"],
		] as const) {
			expect(nativeFirstUse).toContain(`platform: ${platform}`);
			expect(nativeFirstUse).toContain(`asset: ${asset}`);
		}
		expect(nativeFirstUse).toContain("os: xcode-27");
		expect(nativeFirstUse).toContain(
			["SIGNET_NATIVE_SMOKE_BINARY: ./dist/native/", "$", "{{ matrix.asset }}"].join(""),
		);
	});

	test("macOS native releases run Developer ID signing before artifact upload", () => {
		const releaseWorkflow = text(".github/workflows/release.yml");
		const signingStart = releaseWorkflow.indexOf("      - name: Sign and verify macOS native binary with Developer ID");
		const signingEnd = releaseWorkflow.indexOf("\n      - name:", signingStart + 1);
		const signingStep = releaseWorkflow.slice(signingStart, signingEnd);
		const uploadStart = releaseWorkflow.indexOf("      - name: Upload to release", signingEnd);

		expect(signingStart).toBeGreaterThanOrEqual(0);
		expect(signingEnd).toBeGreaterThan(signingStart);
		expect(signingStep).toContain("if: startsWith(matrix.platform, 'darwin-')");
		expect(signingStep).toMatch(/MACOS_CERTIFICATE_P12: \$\{\{ secrets\.MACOS_CERTIFICATE_P12 \}\}/);
		expect(signingStep).toMatch(/MACOS_CERTIFICATE_PASSWORD: \$\{\{ secrets\.MACOS_CERTIFICATE_PASSWORD \}\}/);
		expect(signingStep).toMatch(/APPLE_TEAM_ID: \$\{\{ secrets\.APPLE_TEAM_ID \}\}/);
		expect(signingStep).toMatch(/run: bash scripts\/sign-macos-native\.sh "\.\/dist\/native\/\$\{RELEASE_ASSET\}"/);
		expect(uploadStart).toBeGreaterThan(signingEnd);
	});
});
