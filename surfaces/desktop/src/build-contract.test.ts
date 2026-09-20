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
