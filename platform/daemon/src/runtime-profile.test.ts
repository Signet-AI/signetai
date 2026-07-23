import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeProfile } from "./runtime-profile";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(contents = ""): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-runtime-profile-"));
	dirs.push(dir);
	if (contents) writeFileSync(join(dir, "agent.yaml"), contents);
	return dir;
}

describe("runtime profile", () => {
	it("uses the standard profile by default", () => {
		expect(loadRuntimeProfile(workspace(), {}).profile).toBe("standard");
	});

	it("edge profile uses polling and keeps native embedding lazy", () => {
		const config = loadRuntimeProfile(workspace("runtime:\n  profile: edge\n"), {});
		expect(config).toMatchObject({
			embeddingIsolation: "process",
			profile: "edge",
			probeEmbeddingAtStartup: false,
			watcher: "poll",
		});
		expect(config.embeddingIdleUnloadMs).toBe(30_000);
	});

	it("a valid environment override wins over the file", () => {
		const config = loadRuntimeProfile(workspace("runtime:\n  profile: standard\n"), {
			SIGNET_RUNTIME_PROFILE: " edge ",
		});
		expect(config.profile).toBe("edge");
	});

	it("invalid values fail safely to standard", () => {
		expect(loadRuntimeProfile(workspace("runtime:\n  profile: enormous\n"), {}).profile).toBe("standard");
	});
});
