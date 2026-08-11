import { expect, test } from "bun:test";
import packageJson from "../package.json";

const MAINTAINED_TEST_ROOTS = [
	"scripts",
	"tests",
	"platform/core",
	"platform/daemon",
	"platform/native",
	"surfaces/cli",
	"surfaces/dashboard",
	"surfaces/desktop",
	"surfaces/tray",
	"integrations",
	"libs",
	"memorybench",
	"web/workers",
];

const WORKSPACE_TEST_COMMAND = packageJson.scripts["test:workspace"];
const DIRECTORY_TEST_COMMAND = WORKSPACE_TEST_COMMAND.split(" && ")[0] ?? "";

test("the root test command covers every maintained test root", () => {
	const scripts = packageJson.scripts;
	expect(scripts.test).toBe("bun run test:workspace");
	expect(WORKSPACE_TEST_COMMAND).toBeDefined();

	for (const root of MAINTAINED_TEST_ROOTS) {
		expect(DIRECTORY_TEST_COMMAND).toContain(root);
	}

	expect(DIRECTORY_TEST_COMMAND).not.toContain("--filter");
	expect(DIRECTORY_TEST_COMMAND).not.toContain("references");
});

test("the root test command retains the Codex plugin package smoke test", () => {
	expect(WORKSPACE_TEST_COMMAND).toContain("bun run --filter '@signet/codex-plugin' test");
});
