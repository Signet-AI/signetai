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

test("the root test command covers every maintained test root", () => {
	const scripts = packageJson.scripts;
	expect(scripts.test).toBe("bun run test:workspace");
	expect(scripts["test:workspace"]).toBeDefined();

	for (const root of MAINTAINED_TEST_ROOTS) {
		expect(scripts["test:workspace"]).toContain(root);
	}

	expect(scripts["test:workspace"]).not.toContain("--filter");
	expect(scripts["test:workspace"]).not.toContain("references");
});
