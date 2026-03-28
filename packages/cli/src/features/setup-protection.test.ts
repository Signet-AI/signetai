import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSnapshotProtection } from "../lib/workspace-protection.js";
import Database from "../sqlite.js";
import { enforceSetupProtection } from "./setup-protection.js";

const originalEnv = {
	OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
	HOME: process.env.HOME,
};

afterEach(() => {
	if (originalEnv.OPENCLAW_CONFIG_PATH === undefined) {
		process.env.OPENCLAW_CONFIG_PATH = undefined;
	} else {
		process.env.OPENCLAW_CONFIG_PATH = originalEnv.OPENCLAW_CONFIG_PATH;
	}

	if (originalEnv.HOME === undefined) {
		process.env.HOME = undefined;
	} else {
		process.env.HOME = originalEnv.HOME;
	}
});

function setupRepo(): {
	root: string;
	workspace: string;
	configPath: string;
} {
	const root = mkdtempSync(join(tmpdir(), "setup-protection-"));
	const workspace = join(root, "agents");
	mkdirSync(workspace, { recursive: true });
	writeFileSync(join(workspace, "AGENTS.md"), "# test\n");
	mkdirSync(join(workspace, "memory"), { recursive: true });
	const db = Database(join(workspace, "memory", "memories.db"));
	try {
		db.exec("CREATE TABLE IF NOT EXISTS marker (id INTEGER PRIMARY KEY, value TEXT)");
		db.exec("INSERT INTO marker (value) VALUES ('ready')");
	} finally {
		db.close();
	}
	spawnSync("git", ["init"], { cwd: workspace, windowsHide: true });

	const configPath = join(root, "openclaw.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			agents: {
				defaults: {
					workspace,
				},
			},
		}),
	);
	process.env.OPENCLAW_CONFIG_PATH = configPath;
	process.env.HOME = root;
	return { root, workspace, configPath };
}

describe("setup protection soft gate", () => {
	it("fails non-interactive setup when workspace is linked and unprotected", async () => {
		const { root, workspace } = setupRepo();
		try {
			await expect(
				enforceSetupProtection({
					basePath: workspace,
					nonInteractive: true,
					allowUnprotectedWorkspace: false,
					createLocalBackup: false,
				}),
			).rejects.toThrow("OpenClaw workspace is linked");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("creates a local snapshot in non-interactive mode when requested", async () => {
		const { root, workspace } = setupRepo();
		try {
			const result = await enforceSetupProtection({
				basePath: workspace,
				nonInteractive: true,
				allowUnprotectedWorkspace: false,
				createLocalBackup: true,
			});
			expect(result.state).toBe("snapshot");
			expect(result.snapshotPath).not.toBeNull();
			if (result.snapshotPath) {
				expect(existsSync(result.snapshotPath)).toBe(true);
				const snapDb = Database(join(result.snapshotPath, "memory", "memories.db"), { readonly: true });
				try {
					const row = snapDb.prepare("SELECT COUNT(*) as count FROM marker").get();
					expect(row?.count).toBe(1);
				} finally {
					snapDb.close();
				}
			}
			expect(getSnapshotProtection(workspace)).toBe(result.snapshotPath);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("allows explicit bypass in non-interactive mode", async () => {
		const { root, workspace } = setupRepo();
		try {
			const result = await enforceSetupProtection({
				basePath: workspace,
				nonInteractive: true,
				allowUnprotectedWorkspace: true,
				createLocalBackup: false,
			});
			expect(result.state).toBe("bypass");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("passes immediately when origin remote is configured", async () => {
		const { root, workspace } = setupRepo();
		try {
			spawnSync("git", ["remote", "add", "origin", "git@github.com:test/private.git"], {
				cwd: workspace,
				windowsHide: true,
			});
			const result = await enforceSetupProtection({
				basePath: workspace,
				nonInteractive: true,
				allowUnprotectedWorkspace: false,
				createLocalBackup: false,
			});
			expect(result.state).toBe("remote");
			expect(result.origin).toContain("github.com:test/private.git");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
