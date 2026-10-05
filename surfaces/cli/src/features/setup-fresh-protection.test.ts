import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as protection from "../lib/workspace-protection.js";
import type { SetupDeps } from "./setup-types.js";

const realProtection = { ...protection };
const realCreateWorkspaceSnapshot = protection.createWorkspaceSnapshot;
let backupRoot = "";
afterAll(() => {
	mock.module("../lib/workspace-protection.js", () => realProtection);
});
mock.module("../lib/workspace-protection.js", () => ({
	...protection,
	createWorkspaceSnapshot: (basePath: string, root?: string) =>
		realCreateWorkspaceSnapshot(basePath, root ?? (backupRoot || undefined)),
}));

const { runDashboardSetupBootstrap } = await import("./setup-fresh.js");

describe("dashboard setup bootstrap with --create-local-backup", () => {
	let root = "";
	const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;

	afterEach(() => {
		if (previousConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
		else process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
		if (root) rmSync(root, { recursive: true, force: true });
		backupRoot = "";
	});

	it("records local-backup protection state in the v2 runtime directory", async () => {
		root = mkdtempSync(join(tmpdir(), "signet-dashboard-bootstrap-backup-"));
		backupRoot = join(root, "backups");
		const basePath = join(root, "agents");
		const configPath = join(root, "openclaw.json");
		mkdirSync(basePath, { recursive: true });
		writeFileSync(join(basePath, "AGENTS.md"), "# Agent\n");
		writeFileSync(configPath, JSON.stringify({ agents: { defaults: { workspace: basePath } } }));
		process.env.OPENCLAW_CONFIG_PATH = configPath;

		await runDashboardSetupBootstrap(basePath, { allowUnprotectedWorkspace: false, createLocalBackup: true }, {
			getTemplatesDir: () => join(root, "templates"),
		} as unknown as SetupDeps);

		expect(existsSync(join(basePath, "runtime", "workspace-protection.json"))).toBe(true);
		expect(existsSync(join(basePath, ".daemon"))).toBe(false);
		expect(existsSync(join(basePath, "data", "signet.db"))).toBe(true);
		expect(existsSync(backupRoot)).toBe(true);
	});
});
