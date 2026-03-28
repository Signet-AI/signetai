import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OhMyPiConnector } from "./src/index.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let tmpRoot = "";

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "signet-omp-connector-"));
	process.env.PI_CODING_AGENT_DIR = join(tmpRoot, "agent");
});

afterEach(() => {
	if (originalAgentDir === undefined) {
		process.env.PI_CODING_AGENT_DIR = undefined;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	}
	if (tmpRoot) {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});

describe("OhMyPiConnector", () => {
	it("installs a bundled managed extension without external package resolution", async () => {
		const connector = new OhMyPiConnector();
		const result = await connector.install(tmpRoot);
		const installedPath = join(tmpRoot, "agent", "extensions", "signet-oh-my-pi.js");

		expect(result.success).toBe(true);
		expect(result.filesWritten).toContain(installedPath);
		expect(existsSync(installedPath)).toBe(true);

		const content = readFileSync(installedPath, "utf8");
		expect(content).toContain("SIGNET_MANAGED_OH_MY_PI_EXTENSION");
		expect(content).toContain("Managed by Signet (@signet/oh-my-pi-extension)");
		expect(content.length).toBeGreaterThan(1_000);
	});
});
