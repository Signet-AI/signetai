import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const turbo = JSON.parse(readFileSync(join(root, "turbo.json"), "utf8"));
const daemonManifest = JSON.parse(readFileSync(join(root, "platform/daemon/package.json"), "utf8"));
const workflow = (name: string) => readFileSync(join(root, ".github/workflows", name), "utf8");

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

	it("does not make displaced TypeScript runtime a production or release gate", () => {
		const release = workflow("release.yml");
		const deploy = workflow("deploy-web.yml");
		const codex = workflow("codex-windows.yml");
		expect(release).toContain("build-native:");
		expect(release).toContain("platform/rust-daemon/Cargo.toml");
		expect(release).not.toContain("bun run --filter '@signet/core' build");
		expect(release).not.toContain("@signet/daemon");
		expect(deploy).not.toContain("@signet/core");
		expect(codex).not.toContain('"@signet/core"');
		for (const name of ["boot-wedge.yml", "memorybench-dreaming-gate.yml", "transcript-import-platform.yml"]) {
			const parity = workflow(name);
			expect(parity).toContain("continue-on-error: true");
			expect(parity).toContain("TypeScript parity");
		}
	});
});
