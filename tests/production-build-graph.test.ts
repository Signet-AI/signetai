import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const turbo = JSON.parse(readFileSync(join(root, "turbo.json"), "utf8"));
const daemonManifest = JSON.parse(readFileSync(join(root, "platform/daemon/package.json"), "utf8"));

describe("production build graph", () => {
	it("selects native production build without the displaced TypeScript daemon/core build", () => {
		const build = rootManifest.scripts.build as string;
		expect(build).toContain("build:native");
		expect(build).not.toContain("build:core");
		expect(build).not.toContain("platform/daemon");
		expect(build).not.toContain("build:daemon");
		expect(turbo.tasks["signetai#build"].dependsOn).not.toContain("@signet/core#build");
	});

	it("keeps daemon TypeScript tests available only as an explicit parity surface", () => {
		expect(rootManifest.scripts["test:workspace"]).toContain("platform/daemon");
		expect(rootManifest.workspaces).toContain("!platform/daemon");
		expect(daemonManifest.private).toBe(true);
		expect(daemonManifest.scripts["parity-only"]).toBe("bun test");
		expect(daemonManifest.scripts.prepublishOnly).toBeUndefined();
	});
});
