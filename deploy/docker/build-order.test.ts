import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const dockerfile = readFileSync(resolve(repo, "deploy/docker/Dockerfile"), "utf8");
const buildNativeBun = readFileSync(resolve(repo, "scripts/build-native-bun.ts"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(repo, "package.json"), "utf8")) as {
	scripts: Record<string, string>;
};

test("Docker builds every CLI workspace export before compiling the Bun CLI", () => {
	const buildLine = dockerfile.split("\n").find((line) => line.includes("build:native-bun"));
	expect(buildLine).toBe(
		"RUN bun run --filter '@signet/core' build && bun run build:connector-base && bun run build:opencode-plugin && bun run build:oh-my-pi-extension && bun run build:connector-oh-my-pi && bun run build:pi-extension && bun run build:connector-pi && bun run build:deps && bun run build:native-bun",
	);
	for (const script of [
		"build:connector-base",
		"build:opencode-plugin",
		"build:oh-my-pi-extension",
		"build:connector-oh-my-pi",
		"build:pi-extension",
		"build:connector-pi",
		"build:deps",
	]) {
		expect(packageJson.scripts[script]).toBeString();
	}
	expect(buildNativeBun).toContain('external: ["better-sqlite3"]');
});
