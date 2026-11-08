import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import { registerUpdateCommands } from "./update.js";

let workspace = "";
const originalEnv = { ...process.env };
beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "signet-update-"));
	process.env.HOME = workspace;
	process.env.HERMES_HOME = join(workspace, "hermes");
	process.env.XDG_CONFIG_HOME = join(workspace, "config");
	delete process.env.HERMES_REPO;
});
const originalExit = process.exit;
const originalLog = console.log;
const originalError = console.error;

afterEach(() => {
	process.exit = originalExit;
	console.log = originalLog;
	console.error = originalError;
	mock.restore();
	for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
	Object.assign(process.env, originalEnv);
	rmSync(workspace, { recursive: true, force: true });
});

function makeProgram(
	offlineRequest: (path: string, opts?: RequestInit) => Promise<unknown>,
	reconcileDaemon?: () => Promise<boolean>,
) {
	const calls: Array<{ path: string; opts?: RequestInit }> = [];
	const program = new Command();
	registerUpdateCommands(program, {
		AGENTS_DIR: workspace,
		MAX_AUTO_UPDATE_INTERVAL: 604800,
		MIN_AUTO_UPDATE_INTERVAL: 300,
		configureHarnessHooks: async () => {},
		fetchFromDaemon: async () => null,
		getSkillsSourceDir: () => "/tmp/skills",
		getTemplatesDir: () => "/tmp/templates",
		isOpenClawInstalled: () => false,
		isOhMyPiInstalled: () => false,
		isPiInstalled: () => false,
		reconcileDaemon,
		offline: {
			request: async <T>(path: string, opts?: RequestInit) => {
				calls.push({ path, opts });
				return (await offlineRequest(path, opts)) as T;
			},
		},
		syncBuiltinSkills: () => ({ installed: [], updated: [], skipped: [] }),
	});
	return { calls, program };
}

async function invoke(program: Command, args: string[]): Promise<string> {
	const output: string[] = [];
	console.log = ((...values: unknown[]) => output.push(values.join(" "))) as typeof console.log;
	console.error = ((...values: unknown[]) => output.push(values.join(" "))) as typeof console.error;
	await program.parseAsync(["node", "signet", ...args]);
	return output.join("\n");
}

describe("daemon-off update command fallback regressions", () => {
	test.each([
		[
			"check --force",
			["update", "check", "--force"],
			"/api/update/check?force=true",
			{ currentVersion: "0.211.3", latestVersion: "0.211.3" },
			"Version: v0.211.3",
		],
		[
			"status",
			["update", "status"],
			"/api/update/config",
			{ autoInstall: false, checkInterval: 600, channel: "stable" },
			"Update Status",
		],
		["channel", ["update", "channel"], "/api/update/config", { channel: "nightly" }, "Update channel: nightly"],
		[
			"enable",
			["update", "enable", "--interval", "600"],
			"/api/update/config",
			{ success: true, persisted: true },
			"Auto-update enabled",
		],
		[
			"disable",
			["update", "disable"],
			"/api/update/config",
			{ success: true, persisted: true },
			"Auto-update disabled",
		],
		[
			"install",
			["update", "install"],
			"/api/update/run",
			{ success: true, message: "Update installed" },
			"Installing v0.211.4...",
		],
	] as const)(
		"%s invokes the offline request and renders its result",
		async (_name, args, expectedPath, result, expectedOutput) => {
			const { calls, program } = makeProgram(async (path) => {
				if (path === "/api/update/check?force=true") {
					return args[1] === "install"
						? { updateAvailable: true, latestVersion: "0.211.4" }
						: { updateAvailable: false, ...result };
				}
				if (path === "/api/update/config") return result;
				if (path === "/api/update/run") return result;
				return null;
			});
			const output = await invoke(program, [...args]);
			expect(calls.some((call) => call.path === expectedPath)).toBe(true);
			expect(output).toContain(expectedOutput);
		},
	);

	test("startup/reconciliation failure reaches the command dependency boundary", async () => {
		const exits: unknown[] = [];
		process.exit = ((code?: number) => {
			exits.push(code);
		}) as typeof process.exit;
		const reconcileDaemon = mock(async () => false);
		const { calls, program } = makeProgram(async () => ({ success: true }), reconcileDaemon);
		await invoke(program, ["update", "enable"]);
		expect(reconcileDaemon).toHaveBeenCalledTimes(1);
		expect(exits).toEqual([1]);
		expect(calls).toHaveLength(1);
	});
});
