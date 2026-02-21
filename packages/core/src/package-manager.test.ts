import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getGlobalInstallCommand,
	getSkillsRunnerCommand,
	parsePackageManagerUserAgent,
	resolvePrimaryPackageManager,
} from "./package-manager";

const tmpDirs: string[] = [];

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (!dir) continue;
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-core-pm-"));
	tmpDirs.push(dir);
	return dir;
}

describe("parsePackageManagerUserAgent", () => {
	it("parses known package manager families", () => {
		expect(parsePackageManagerUserAgent("npm/10.9.0 node/v20.10.0")).toBe(
			"npm",
		);
		expect(
			parsePackageManagerUserAgent("pnpm/9.12.0 npm/? node/v20.10.0"),
		).toBe("pnpm");
		expect(parsePackageManagerUserAgent("bun/1.2.3 npm/? node/v20.10.0")).toBe(
			"bun",
		);
		expect(
			parsePackageManagerUserAgent("yarn/1.22.22 npm/? node/v20.10.0"),
		).toBe("yarn");
	});
});

describe("resolvePrimaryPackageManager", () => {
	it("prefers manager recorded in agent.yaml", () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "agent.yaml"),
			"install:\n  primary_package_manager: pnpm\n",
		);

		const result = resolvePrimaryPackageManager({
			agentsDir: dir,
			commandExists: (command) => command === "pnpm" || command === "npm",
		});

		expect(result.family).toBe("pnpm");
		expect(result.source).toBe("config");
	});

	it("falls back deterministically when configured manager is unavailable", () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "agent.yaml"),
			"install:\n  primary_package_manager: bun\n",
		);

		const result = resolvePrimaryPackageManager({
			agentsDir: dir,
			commandExists: (command) => command === "npm",
		});

		expect(result.family).toBe("npm");
		expect(result.source).toBe("fallback");
		expect(result.reason).toContain(
			"Configured package manager 'bun' is unavailable",
		);
	});

	it("uses npm_config_user_agent when config metadata is missing", () => {
		const result = resolvePrimaryPackageManager({
			env: { npm_config_user_agent: "bun/1.2.0 npm/? node/v20.10.0" },
			commandExists: (command) => command === "bun" || command === "npm",
		});

		expect(result.family).toBe("bun");
		expect(result.source).toBe("user-agent");
	});
});

describe("package manager command builders", () => {
	it("builds skills command for npm family", () => {
		const cmd = getSkillsRunnerCommand("npm", ["search", "memory"]);
		expect(cmd.command).toBe("npm");
		expect(cmd.args).toEqual([
			"exec",
			"--yes",
			"--",
			"skills",
			"search",
			"memory",
		]);
	});

	it("builds global install command for bun family", () => {
		const cmd = getGlobalInstallCommand("bun", "signetai");
		expect(cmd.command).toBe("bun");
		expect(cmd.args).toEqual(["add", "-g", "signetai"]);
	});
});
