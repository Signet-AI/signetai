import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const dockerfile = readFileSync(join(rootDir, "deploy/docker/Dockerfile"), "utf8");
const openclawPackageJson = JSON.parse(
	readFileSync(join(rootDir, "packages/adapters/openclaw/package.json"), "utf8"),
);
const openclawBuild =
	typeof openclawPackageJson === "object" &&
	openclawPackageJson !== null &&
	"scripts" in openclawPackageJson &&
	typeof openclawPackageJson.scripts === "object" &&
	openclawPackageJson.scripts !== null &&
	"build" in openclawPackageJson.scripts &&
	typeof openclawPackageJson.scripts.build === "string"
		? openclawPackageJson.scripts.build
		: undefined;
const openclawEntry = readFileSync(join(rootDir, "packages/adapters/openclaw/src/index.ts"), "utf8");

function getBuildCommands(source: string): string[] {
	return source
		.split("\n")
		.filter((line) => line.startsWith("RUN bun run "))
		.map((line) => line.replace("RUN bun run ", "").trim());
}

describe("Docker build pipeline regression guard", () => {
	it("uses shared build scripts instead of hardcoded connector filters", () => {
		expect(dockerfile).toContain("RUN bun run build:deps");
		expect(dockerfile).not.toContain("--filter '@signet/connector-");
	});

	it("keeps the shared prebuild sequence aligned before packaging signetai", () => {
		expect(getBuildCommands(dockerfile)).toEqual([
			"build:core",
			"build:connector-base",
			"build:opencode-plugin",
			"build:native",
			"build:oh-my-pi-extension",
			"build:connector-oh-my-pi",
			"build:pi-extension",
			"build:connector-pi",
			"build:deps",
			"build:dashboard",
			"build:signetai",
		]);
	});

	it("keeps the OpenClaw adapter build Docker-safe when bundling @signet/core", () => {
		expect(openclawEntry).toContain('from "@signet/core"');
		expect(openclawBuild).toContain("--external better-sqlite3");
	});
});
