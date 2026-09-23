import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const root = join(import.meta.dir, "..");
const connectors = ["claude-code", "codex", "forge"];

describe("production connector boundary", () => {
	it("keeps core out of connector source and manifests", () => {
		for (const connector of connectors) {
			const dir = join(root, "integrations", connector, "connector");
			const source = readFileSync(join(dir, "src", "index.ts"), "utf8");
			const manifest = readFileSync(join(dir, "package.json"), "utf8");
			expect(source).not.toContain("@signet/core");
			expect(manifest).not.toContain("@signet/core");
		}
	});

	it("retains native connector entry points", () => {
		for (const connector of connectors) {
			const source = readFileSync(join(root, "integrations", connector, "connector", "src", "index.ts"), "utf8");
			expect(source).toContain("@signet/connector-base");
		}
		expect(existsSync(join(root, "integrations", "codex", "connector", "src", "index.ts"))).toBe(true);
	});
});
