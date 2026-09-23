import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
const packageJson = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
	dependencies?: Record<string, string>;
};

test("production connector has no direct core or daemon boundary dependency", () => {
	const forbiddenPackages = ["@signet/" + "core", "@signet/" + "daemon"];
	for (const name of forbiddenPackages) expect(packageJson.dependencies ?? {}).not.toHaveProperty(name);
	expect(source).not.toMatch(/from ["']@signet\/(?:core|daemon)["']/);
	expect(source).toContain('from "@signet/connector-base"');
});
