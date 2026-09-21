import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const root = join(import.meta.dir, "..");

describe("native keyring isolation contract", () => {
	test("routes compiled keyring operations back through a dedicated child mode", () => {
		const build = readFileSync(join(root, "scripts", "build-native-bun.ts"), "utf8");
		expect(build).toContain('process.env.SIGNET_COMPILED_NATIVE = "1"');
		expect(build).toContain("SIGNET_KEYRING_HELPER");
		expect(build).toContain("runSecretKeyringChild");
		expect(build).toContain("SIGNET_NATIVE_SOURCE_WORKER_SMOKE");
	});

	test("ships the child entry while keeping the parent adapter free of native imports", () => {
		const manifest = readFileSync(join(root, "platform", "core", "package.json"), "utf8");
		const parent = readFileSync(join(root, "platform", "core", "src", "secrets-keyring.ts"), "utf8");
		expect(manifest).toContain("./src/secrets-keyring-child.ts");
		expect(parent).not.toContain('from "@napi-rs/keyring"');
		expect(parent).not.toContain('require("@napi-rs/keyring")');
	});
});
