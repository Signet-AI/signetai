import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIGNET_GRAPHIQ_PLUGIN_ID, readGraphiqState, updateGraphiqActiveProject } from "@signet/core";
import { ensureGraphiqInstalled, installGraphiqPlugin } from "./graphiq.js";
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

	test("pins source fallback cargo installs to a fixed GraphIQ revision", async () => {
		const basePath = makeRoot();
		const binDir = join(basePath, "bin");
		const capturePath = join(basePath, "cargo-args.txt");
		mkdirSync(binDir, { recursive: true });
		const cargoPath = join(binDir, "cargo");
		writeFileSync(cargoPath, `#!/bin/sh\necho "$@" >> ${JSON.stringify(capturePath)}\n`);
		chmodSync(cargoPath, 0o755);

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

		const cargoArgs = readFileSync(capturePath, "utf-8");
		expect(cargoArgs).toContain(
			"install --git https://github.com/aaf2tbz/graphiq --rev 156f31daf366e9b68d75bdaa4069058666ecc518 graphiq-cli",
		);
		expect(cargoArgs).toContain(
			"install --git https://github.com/aaf2tbz/graphiq --rev 156f31daf366e9b68d75bdaa4069058666ecc518 graphiq-mcp",
		);
	});
});
