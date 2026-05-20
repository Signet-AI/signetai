import { describe, expect, test } from "bun:test";

import { createAcpxProvider, createCommandLineProvider } from "./provider";

describe("provider executable availability", () => {
	test("checks explicit relative ACPX executable paths instead of assuming they exist", async () => {
		const provider = createAcpxProvider({
			agent: "codex",
			bin: "./node_modules/.bin/signet-missing-acpx",
			hooks: "disabled",
		});

		await expect(provider.available()).resolves.toBe(false);
	});

	test("checks explicit relative command executable paths instead of assuming they exist", async () => {
		const provider = createCommandLineProvider({
			name: "missing-relative-command",
			bin: "./node_modules/.bin/signet-missing-command",
			args: [],
		});

		await expect(provider.available()).resolves.toBe(false);
	});
});
