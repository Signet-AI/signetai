import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePrimaryPackageManager } from "./package-manager";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "signet-pm-exec-"));
}

describe("Bug 2: exec path detection", () => {
	it("detects bun from ~/.bun/bin/signet exec path", () => {
		const result = resolvePrimaryPackageManager({
			execPath: "/home/user/.bun/bin/signet",
			commandExists: (cmd) => cmd === "bun" || cmd === "npm",
		});
		expect(result.family).toBe("bun");
		expect(result.reason).toContain("executable path");
	});

	it("detects npm from /usr/lib/node_modules path", () => {
		const result = resolvePrimaryPackageManager({
			execPath: "/usr/lib/node_modules/signetai/dist/cli.js",
			commandExists: (cmd) => cmd === "npm",
		});
		expect(result.family).toBe("npm");
		expect(result.reason).toContain("executable path");
	});

	it("detects pnpm from ~/.pnpm/ path", () => {
		const result = resolvePrimaryPackageManager({
			execPath: "/home/user/.local/share/.pnpm/signetai/node_modules/.bin/signet",
			commandExists: (cmd) => cmd === "pnpm" || cmd === "npm",
		});
		expect(result.family).toBe("pnpm");
		expect(result.reason).toContain("executable path");
	});

	it("config takes priority over exec path", () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "agent.yaml"),
			"install:\n  primary_package_manager: npm\n",
		);

		const result = resolvePrimaryPackageManager({
			agentsDir: dir,
			execPath: "/home/user/.bun/bin/signet",
			commandExists: (cmd) => cmd === "bun" || cmd === "npm",
		});
		expect(result.family).toBe("npm");
		expect(result.source).toBe("config");

		rmSync(dir, { recursive: true, force: true });
	});

	it("user-agent takes priority over exec path", () => {
		const result = resolvePrimaryPackageManager({
			execPath: "/home/user/.bun/bin/signet",
			env: { npm_config_user_agent: "pnpm/9.0.0 npm/? node/v20" },
			commandExists: (cmd) => cmd === "bun" || cmd === "pnpm" || cmd === "npm",
		});
		expect(result.family).toBe("pnpm");
		expect(result.source).toBe("user-agent");
	});

	it("falls back to default when exec path is unrecognizable", () => {
		const result = resolvePrimaryPackageManager({
			execPath: "/usr/local/bin/signet",
			commandExists: (cmd) => cmd === "npm",
		});
		expect(result.family).toBe("npm");
		expect(result.source).toBe("fallback");
		expect(result.reason).toContain("No package manager metadata");
	});

	it("skips exec path detection when detected manager is unavailable", () => {
		const result = resolvePrimaryPackageManager({
			execPath: "/home/user/.bun/bin/signet",
			commandExists: (cmd) => cmd === "npm", // bun not available
		});
		// Should fall through exec path (bun unavailable) to default fallback
		expect(result.family).toBe("npm");
		expect(result.source).toBe("fallback");
	});
});

describe("Bug 2: source: fallback in config is not authoritative", () => {
	it("ignores config with source: fallback and uses exec path instead", () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "agent.yaml"),
			"install:\n  primary_package_manager: npm\n  source: fallback\n",
		);

		const result = resolvePrimaryPackageManager({
			agentsDir: dir,
			execPath: "/home/user/.bun/bin/signet",
			commandExists: (cmd) => cmd === "bun" || cmd === "npm",
		});

		// Should NOT use npm from config (it's a fallback, not user-chosen)
		// Should use bun from exec path detection
		expect(result.family).toBe("bun");
		expect(result.reason).toContain("executable path");

		rmSync(dir, { recursive: true, force: true });
	});

	it("respects config when source is not fallback", () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "agent.yaml"),
			"install:\n  primary_package_manager: npm\n  source: config\n",
		);

		const result = resolvePrimaryPackageManager({
			agentsDir: dir,
			execPath: "/home/user/.bun/bin/signet",
			commandExists: (cmd) => cmd === "bun" || cmd === "npm",
		});

		// Explicit config should be respected
		expect(result.family).toBe("npm");
		expect(result.source).toBe("config");

		rmSync(dir, { recursive: true, force: true });
	});

	it("respects config when no source field exists", () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "agent.yaml"),
			"install:\n  primary_package_manager: npm\n",
		);

		const result = resolvePrimaryPackageManager({
			agentsDir: dir,
			execPath: "/home/user/.bun/bin/signet",
			commandExists: (cmd) => cmd === "bun" || cmd === "npm",
		});

		// No source field = treat as explicit config
		expect(result.family).toBe("npm");
		expect(result.source).toBe("config");

		rmSync(dir, { recursive: true, force: true });
	});
});
