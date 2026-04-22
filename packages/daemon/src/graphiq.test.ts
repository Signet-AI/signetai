import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getGraphiqProjectDbPath, updateGraphiqActiveProject } from "@signet/core";
import { runGraphiqCli } from "./graphiq.js";

let root = "";
let originalPath: string | undefined;
let originalSignetPath: string | undefined;

afterEach(() => {
	if (originalPath === undefined) {
		Reflect.deleteProperty(process.env, "PATH");
	} else {
		process.env.PATH = originalPath;
	}
	if (originalSignetPath === undefined) {
		Reflect.deleteProperty(process.env, "SIGNET_PATH");
	} else {
		process.env.SIGNET_PATH = originalSignetPath;
	}
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

describe("GraphIQ daemon CLI runner", () => {
	test("force kills GraphIQ subprocesses that ignore timeout SIGTERM", async () => {
		root = mkdtempSync(join(tmpdir(), "signet-graphiq-daemon-"));
		originalPath = process.env.PATH;
		originalSignetPath = process.env.SIGNET_PATH;

		const agentsDir = join(root, "agents");
		const projectPath = join(root, "project");
		const binDir = join(root, "bin");
		const dbPath = getGraphiqProjectDbPath(projectPath);
		mkdirSync(dirname(dbPath), { recursive: true });
		mkdirSync(binDir, { recursive: true });
		writeFileSync(dbPath, "");
		updateGraphiqActiveProject(agentsDir, {
			projectPath,
			indexedAt: new Date("2026-04-21T00:00:00.000Z"),
			installSource: "existing",
		});

		const graphiqPath = join(binDir, "graphiq");
		writeFileSync(graphiqPath, "#!/bin/sh\ntrap '' TERM\nsleep 10\n");
		chmodSync(graphiqPath, 0o755);
		process.env.SIGNET_PATH = agentsDir;
		process.env.PATH = binDir;

		await expect(runGraphiqCli(["status"], 20)).rejects.toThrow("Timed out after 20ms");
	});
});
