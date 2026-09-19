import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFreshRustDaemon } from "../../../scripts/lib/fresh-rust-daemon";

describe("native daemon runtime contract", () => {
	it("selects the explicitly configured native executable", () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-native-daemon-"));
		const binary = join(dir, "signet-daemon");
		writeFileSync(binary, "native");
		chmodSync(binary, 0o755);
		expect(resolveFreshRustDaemon(dir, { SIGNET_RUST_DAEMON_BIN: binary })).toBe(binary);
	});

	it("does not advertise or launch the displaced JavaScript daemon", () => {
		const packageJson = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
			bin?: Record<string, string>;
			scripts?: Record<string, string>;
		};
		const productionScripts = ["dev", "start", "install:service", "uninstall:service"];
		expect(packageJson.bin?.["signet-daemon"]).toBeUndefined();
		for (const name of productionScripts) {
			const script = packageJson.scripts?.[name] ?? "";
			expect(script).not.toMatch(/src\/(?:dev-)?daemon\.ts/);
			expect(script).toContain("native-daemon");
		}
	});
});
