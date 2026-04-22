import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIGNET_GRAPHIQ_PLUGIN_ID, readGraphiqState, updateGraphiqActiveProject } from "@signet/core";
import { installGraphiqPlugin } from "./graphiq.js";
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
});
