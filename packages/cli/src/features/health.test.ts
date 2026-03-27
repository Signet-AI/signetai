import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStatusReport } from "./health.js";

const originalOpenClawConfig = process.env.OPENCLAW_CONFIG_PATH;

afterEach(() => {
	if (originalOpenClawConfig === undefined) {
		process.env.OPENCLAW_CONFIG_PATH = undefined;
	} else {
		process.env.OPENCLAW_CONFIG_PATH = originalOpenClawConfig;
	}
});

function depsFor(basePath: string) {
	return {
		agentsDir: basePath,
		defaultPort: 3850,
		detectExistingSetup: () => ({
			agentsDir: true,
			agentsMd: true,
			agentYaml: true,
			memoryDb: false,
		}),
		extractPathOption: () => null,
		formatUptime: () => "0s",
		getDaemonStatus: async () => ({
			running: false,
			pid: null,
			uptime: null,
			version: null,
			host: null,
			bindHost: null,
			networkMode: null,
		}),
		normalizeAgentPath: (pathValue: string) => pathValue,
		parseIntegerValue: (value: unknown) => (typeof value === "number" ? value : null),
		signetLogo: () => "signet",
	};
}

describe("status report openclaw backup risk", () => {
	it("marks workspace as unprotected when openclaw is linked and origin is missing", async () => {
		const root = mkdtempSync(join(tmpdir(), "health-risk-"));
		const workspace = join(root, "agents");
		try {
			mkdirSync(workspace, { recursive: true });
			spawnSync("git", ["init"], { cwd: workspace, windowsHide: true });
			const cfgPath = join(root, "openclaw.json");
			writeFileSync(
				cfgPath,
				JSON.stringify({
					agents: {
						defaults: {
							workspace,
						},
					},
				}),
			);
			process.env.OPENCLAW_CONFIG_PATH = cfgPath;
			const report = await getStatusReport(workspace, depsFor(workspace));
			expect(report.openclawWorkspaceLinked).toBe(true);
			expect(report.openclawWorkspaceUnprotected).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("clears unprotected flag when origin exists", async () => {
		const root = mkdtempSync(join(tmpdir(), "health-risk-"));
		const workspace = join(root, "agents");
		try {
			mkdirSync(workspace, { recursive: true });
			spawnSync("git", ["init"], { cwd: workspace, windowsHide: true });
			spawnSync("git", ["remote", "add", "origin", "git@github.com:test/private.git"], {
				cwd: workspace,
				windowsHide: true,
			});
			const cfgPath = join(root, "openclaw.json");
			writeFileSync(
				cfgPath,
				JSON.stringify({
					agents: {
						defaults: {
							workspace,
						},
					},
				}),
			);
			process.env.OPENCLAW_CONFIG_PATH = cfgPath;
			const report = await getStatusReport(workspace, depsFor(workspace));
			expect(report.openclawWorkspaceLinked).toBe(true);
			expect(report.openclawWorkspaceUnprotected).toBe(false);
			expect(report.git.origin).toContain("private.git");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("treats linked workspace as protected when snapshot marker points to an existing backup", async () => {
		const root = mkdtempSync(join(tmpdir(), "health-risk-"));
		const workspace = join(root, "agents");
		try {
			mkdirSync(workspace, { recursive: true });
			spawnSync("git", ["init"], { cwd: workspace, windowsHide: true });
			const snapshotPath = join(root, "backups", "agents-20260327T120000Z");
			mkdirSync(snapshotPath, { recursive: true });
			writeFileSync(
				join(workspace, ".signet-workspace-protection.json"),
				`${JSON.stringify({
					source: workspace,
					snapshot: snapshotPath,
					createdAt: new Date().toISOString(),
				})}\n`,
			);

			const cfgPath = join(root, "openclaw.json");
			writeFileSync(
				cfgPath,
				JSON.stringify({
					agents: {
						defaults: {
							workspace,
						},
					},
				}),
			);
			process.env.OPENCLAW_CONFIG_PATH = cfgPath;
			const report = await getStatusReport(workspace, depsFor(workspace));
			expect(report.openclawWorkspaceLinked).toBe(true);
			expect(report.openclawWorkspaceUnprotected).toBe(false);
			expect(report.git.snapshot).toBe(snapshotPath);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
