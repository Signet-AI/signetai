import { expect, test } from "bun:test";
import { join } from "node:path";

interface PackageJson {
	readonly devDependencies: Readonly<Record<string, string>>;
	readonly scripts: Readonly<Record<string, string>>;
}

interface BiomeConfig {
	readonly $schema: string;
	readonly files: {
		readonly includes: readonly string[];
	};
}

const ROOT = join(import.meta.dir, "..");

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await Bun.file(join(ROOT, path)).text()) as T;
}

test("Biome 2 baseline exposes non-writing quality checks", async () => {
	const packageJson = await readJson<PackageJson>("package.json");
	const biomeConfig = await readJson<BiomeConfig>("biome.json");

	expect(packageJson.devDependencies["@biomejs/biome"]).toMatch(/^\^2\./);
	expect(biomeConfig.$schema).toContain("/schemas/2.");
	expect(packageJson.scripts.lint).toBe("bun run lint:check");
	expect(packageJson.scripts["lint:check"]).toBe("biome check .");
	expect(packageJson.scripts["format:check"]).toBe("biome format .");
});

test("Biome gate excludes generated output and runs in pull requests", async () => {
	const biomeConfig = await readJson<BiomeConfig>("biome.json");
	const workflow = await Bun.file(join(ROOT, ".github/workflows/biome.yml")).text();

	for (const pattern of ["!**/built", "!**/*.bundle.*", "!**/*.min.*", "!**/generated", "!**/*.generated.*"]) {
		expect(biomeConfig.files.includes).toContain(pattern);
	}
	expect(workflow).toContain("pull_request:");
	expect(workflow).toContain("branches: [main]");
	expect(workflow).toContain("bun install --frozen-lockfile");
	expect(workflow).toContain("bunx biome check .");
});
