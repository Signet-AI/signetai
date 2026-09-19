import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

test("desktop release builds connector artifacts before bundling the daemon", () => {
	const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
		scripts: Record<string, string>;
	};
	const desktopBuild = manifest.scripts["build:desktop"] ?? "";
	const connectorBuild = manifest.scripts["build:connectors"] ?? "";

	expect(desktopBuild.indexOf("build:connectors")).toBeGreaterThanOrEqual(0);
	expect(desktopBuild.indexOf("build:connectors")).toBeLessThan(desktopBuild.indexOf("build:daemon"));
	for (const prerequisite of [
		"build:connector-base",
		"build:opencode-plugin",
		"build:oh-my-pi-extension",
		"build:pi-extension",
	])
		expect(connectorBuild).toContain(prerequisite);
});

test("desktop release has no displaced TypeScript daemon build path", () => {
	const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
		scripts: Record<string, string>;
	};
	const scripts = Object.values(manifest.scripts).join("\n");
	expect(scripts).not.toContain("build:core");
	expect(scripts).not.toContain("platform/daemon");
	expect(scripts).not.toContain("dist/daemon.js");
});

test("desktop runtime owns its boundary helpers and has no daemon fallback imports", () => {
	const daemonManager = readFileSync(join(import.meta.dir, "daemon-manager.ts"), "utf8");
	const workspace = readFileSync(join(import.meta.dir, "workspace.ts"), "utf8");
	expect(daemonManager).not.toContain("@signet/core");
	expect(workspace).not.toContain("@signet/core");
	expect(daemonManager).toContain('from "node:child_process"');
	expect(daemonManager).toContain('const LOOPBACK_HOST = "127.0.0.1"');
	expect(daemonManager).not.toContain("platform/daemon");
	expect(daemonManager).not.toContain("daemon-rs");
	expect(workspace).not.toContain("platform/daemon");
});
