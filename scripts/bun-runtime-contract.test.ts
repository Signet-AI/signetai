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

		const dockerfile = text("deploy/docker/Dockerfile");
		expect(dockerfile.match(new RegExp(`FROM oven/bun:${requiredVersion}`, "g"))?.length).toBe(2);

		const workflowsDir = join(root, ".github", "workflows");
		const divergentPins = readdirSync(workflowsDir)
			.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
			.flatMap((name) =>
				readFileSync(join(workflowsDir, name), "utf8")
					.split("\n")
					.map((line, index) => ({ name, line, number: index + 1 }))
					.filter(({ line }) => /^\s*bun-version:\s*/.test(line)),
			);
		expect(divergentPins).toEqual([]);
	});

	test("the compiled executable exposes and release CI verifies its embedded runtime", () => {
		const buildScript = text("scripts/build-native-bun.ts");
		expect(buildScript).toContain("SIGNET_RUNTIME_VERSION_SMOKE");
		expect(buildScript).toContain("Bun.version");

		const releaseWorkflow = text(".github/workflows/release.yml");
		expect(releaseWorkflow).toContain("Verify embedded Bun runtime");
		expect(releaseWorkflow).toContain("SIGNET_RUNTIME_VERSION_SMOKE");
	});
});
