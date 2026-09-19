import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { resolveFreshRustDaemon } from "./lib/fresh-rust-daemon";
import { generateLaunchdPlist, generateSystemdUnit } from "./lib/native-daemon-service";

const makeExecutable = (path: string) => {
	writeFileSync(path, "native");
	chmodSync(path, 0o755);
};

describe("native daemon service cutover", () => {
	it("keeps the production script independent of platform/daemon runtime code", async () => {
		const source = await Bun.file(join(import.meta.dir, "native-daemon-service.ts")).text();
		expect(source).not.toMatch(/platform\/daemon|@signet\/daemon/);
	});

	it("rejects JavaScript and TypeScript executable paths", () => {
		for (const extension of ["js", "ts", "mjs", "cjs"]) {
			expect(() => resolveFreshRustDaemon("/tmp", { SIGNET_RUST_DAEMON_BIN: `/tmp/daemon.${extension}` })).toThrow(
				/JavaScript and TypeScript paths/,
			);
		}
	});

	it("accepts the packaged/current Rust binary path", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-native-service-"));
		const binary = join(root, "platform", "rust-daemon", "target", "debug", "signet-daemon");
		mkdirSync(join(root, "platform", "rust-daemon", "target", "debug"), { recursive: true });
		makeExecutable(binary);
		expect(resolveFreshRustDaemon(root)).toBe(binary);
	});

	it("emits native executable arguments for launchd and systemd", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-native-service-"));
		const binary = join(root, "signet-daemon");
		makeExecutable(binary);
		const previous = process.env.SIGNET_RUST_DAEMON_BIN;
		process.env.SIGNET_RUST_DAEMON_BIN = binary;
		try {
			const plist = generateLaunchdPlist(3901);
			const unit = generateSystemdUnit(3901);
			expect(plist).toContain(`<string>${binary}</string>`);
			expect(unit).toContain(`ExecStart=${binary}`);
		} finally {
			if (previous === undefined) delete process.env.SIGNET_RUST_DAEMON_BIN;
			else process.env.SIGNET_RUST_DAEMON_BIN = previous;
		}
	});
});
