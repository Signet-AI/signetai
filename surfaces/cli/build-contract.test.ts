import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Manifest = {
	scripts: Record<string, string>;
};

const manifest = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")) as Manifest;
const productionScriptNames = ["build", "build:cli", "prebuild", "prepublishOnly"];
const forbiddenProductionReachability = [
	"build:core",
	"@signet/core",
	"platform/daemon",
	"dist/daemon.js",
	"node ./",
	"node src/",
	"bun run ./src/daemon",
];

describe("CLI production build graph", () => {
	it("builds the CLI without materializing the TypeScript daemon or core", () => {
		const productionScripts = productionScriptNames.map((name) => manifest.scripts[name]).join("\n");

		expect(manifest.scripts.build).toBe("bun run build:cli");
		expect(manifest.scripts.prebuild).toBe("bun run copy:skills");
		for (const forbidden of forbiddenProductionReachability) {
			expect(productionScripts).not.toContain(forbidden);
		}
	});

	it("keeps TypeScript daemon/core work explicitly named for parity only", () => {
		expect(manifest.scripts["build:typescript-parity"]).toContain("build:core");
		expect(manifest.scripts["build:typescript-parity"]).toContain("build:connector-base");
	});
});
