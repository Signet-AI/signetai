import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import manifest from "../package.json";

test("CLI prompts are a declared resolvable runtime dependency", () => {
	expect(manifest.dependencies).toHaveProperty("@clack/prompts");
	const require = createRequire(import.meta.url);
	expect(() => require.resolve("@clack/prompts")).not.toThrow();
});
