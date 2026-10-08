import { expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let packaged = false;
let resources = "";
mock.module("electron", () => ({
	app: {
		get isPackaged() {
			return packaged;
		},
	},
}));
const paths = await import("./paths.ts");

test("packaged runtime refuses a missing staged Bun despite a valid explicit override", () => {
	const root = mkdtempSync(join(tmpdir(), "desktop-packaged-paths-"));
	const previous = { packaged, resources, override: process.env.SIGNET_BUN_PATH };
	try {
		resources = join(root, "resources");
		mkdirSync(resources);
		packaged = true;
		process.resourcesPath = resources;
		process.env.SIGNET_BUN_PATH = process.execPath;
		expect(() => paths.bunPath()).toThrow();
	} finally {
		packaged = previous.packaged;
		resources = previous.resources;
		if (previous.override === undefined) delete process.env.SIGNET_BUN_PATH;
		else process.env.SIGNET_BUN_PATH = previous.override;
		rmSync(root, { recursive: true, force: true });
	}
});
