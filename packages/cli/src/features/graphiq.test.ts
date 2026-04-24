import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	SIGNET_GRAPHIQ_PLUGIN_ID,
	getGraphiqProjectDbPath,
	readGraphiqState,
	updateGraphiqActiveProject,
	writeGraphiqState,
} from "@signet/core";
import { ensureGraphiqInstalled, installGraphiqPlugin, runGraphiqDoctor, uninstallGraphiqPlugin } from "./graphiq.js";
import { readSetupCorePluginEnabled } from "./setup-plugins.js";

let tempRoot = "";

function makeRoot(): string {
	tempRoot = mkdtempSync(join(tmpdir(), "signet-graphiq-cli-"));
	return tempRoot;
}

afterEach(() => {
	if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
	tempRoot = "";
});

describe("GraphIQ plugin install", () => {
	test("disables persisted GraphIQ runtime state when install fails", async () => {
		const basePath = makeRoot();
		const projectPath = join(basePath, "project");
		mkdirSync(projectPath, { recursive: true });
		updateGraphiqActiveProject(basePath, {
			projectPath,
			indexedAt: new Date("2026-04-21T00:00:00.000Z"),
			installSource: "existing",
		});

		const originalPath = process.env.PATH;
		const emptyBin = join(basePath, "empty-bin");
		mkdirSync(emptyBin, { recursive: true });
		process.env.PATH = emptyBin;
		try {
			await expect(installGraphiqPlugin({ agentsDir: basePath })).resolves.toBe(false);
		} finally {
			if (originalPath === undefined) {
				Reflect.deleteProperty(process.env, "PATH");
			} else {
				process.env.PATH = originalPath;
			}
		}

		expect(readSetupCorePluginEnabled(basePath, SIGNET_GRAPHIQ_PLUGIN_ID)).toBe(false);
		const state = readGraphiqState(basePath);
		expect(state.enabled).toBe(false);
		expect(state.activeProject).toBe(projectPath);
	});

	test("uses install script for GraphIQ installation", async () => {
		const basePath = makeRoot();
		const binDir = join(basePath, "bin");
		const capturePath = join(basePath, "install-args.txt");
		mkdirSync(binDir, { recursive: true });
		const bashPath = join(binDir, "bash");
		writeFileSync(bashPath, `#!/bin/sh\necho "$@" >> ${JSON.stringify(capturePath)}\nexit 0\n`);
		chmodSync(bashPath, 0o755);

		const originalPath = process.env.PATH;
		process.env.PATH = binDir;
		try {
			await expect(ensureGraphiqInstalled({ installIfMissing: true })).resolves.toBe(null);
		} finally {
			if (originalPath === undefined) {
				Reflect.deleteProperty(process.env, "PATH");
			} else {
				process.env.PATH = originalPath;
			}
		}

		const args = readFileSync(capturePath, "utf-8");
		expect(args).toContain("install");
	});

	test("does not run GraphIQ without --db when active project metadata is missing", async () => {
		const basePath = makeRoot();
		const projectPath = join(basePath, "project");
		mkdirSync(projectPath, { recursive: true });
		writeGraphiqState(basePath, {
			pluginId: SIGNET_GRAPHIQ_PLUGIN_ID,
			enabled: true,
			managedBy: "signet",
			activeProject: projectPath,
			indexedProjects: [],
			updatedAt: "2026-04-21T00:00:00.000Z",
		});

		const binDir = join(basePath, "bin");
		const capturePath = join(basePath, "graphiq-args.txt");
		mkdirSync(binDir, { recursive: true });
		const graphiqPath = join(binDir, "graphiq");
		writeFileSync(graphiqPath, `#!/bin/sh\necho "$@" > ${JSON.stringify(capturePath)}\n`);
		chmodSync(graphiqPath, 0o755);

		const originalPath = process.env.PATH;
		const originalError = console.error;
		const errors: string[] = [];
		process.env.PATH = binDir;
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			await runGraphiqDoctor({ agentsDir: basePath });
		} finally {
			console.error = originalError;
			if (originalPath === undefined) {
				Reflect.deleteProperty(process.env, "PATH");
			} else {
				process.env.PATH = originalPath;
			}
		}

		expect(existsSync(capturePath)).toBe(false);
		expect(errors.join("\n")).toContain("GraphIQ index metadata is missing");
	});

	test("purge indexes only removes GraphIQ dirs that match indexed project metadata", async () => {
		const basePath = makeRoot();
		const validProjectPath = join(basePath, "valid-project");
		const tamperedProjectPath = join(basePath, "tampered-project");
		const outsidePath = join(basePath, "outside");
		const validDbPath = getGraphiqProjectDbPath(validProjectPath);
		const outsideDbPath = join(outsidePath, ".graphiq", "graphiq.db");

		mkdirSync(dirname(validDbPath), { recursive: true });
		mkdirSync(dirname(outsideDbPath), { recursive: true });
		writeFileSync(validDbPath, "");
		writeFileSync(outsideDbPath, "");
		writeGraphiqState(basePath, {
			pluginId: SIGNET_GRAPHIQ_PLUGIN_ID,
			enabled: true,
			managedBy: "signet",
			activeProject: validProjectPath,
			indexedProjects: [
				{
					path: validProjectPath,
					dbPath: validDbPath,
					lastIndexedAt: "2026-04-21T00:00:00.000Z",
				},
				{
					path: tamperedProjectPath,
					dbPath: outsideDbPath,
					lastIndexedAt: "2026-04-21T00:00:00.000Z",
				},
			],
			updatedAt: "2026-04-21T00:00:00.000Z",
		});

		await uninstallGraphiqPlugin({ purgeIndexes: true }, { agentsDir: basePath });

		expect(existsSync(dirname(validDbPath))).toBe(false);
		expect(existsSync(dirname(outsideDbPath))).toBe(true);
		expect(readGraphiqState(basePath).enabled).toBe(false);
	});
});
