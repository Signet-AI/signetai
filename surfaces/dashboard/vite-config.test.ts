import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

test("Vite loads the dashboard config under its Node build runtime", () => {
	const result = spawnSync(
		"node",
		[
			"--input-type=module",
			"-e",
			`import { loadConfigFromFile } from "vite";
const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, ${JSON.stringify(join(import.meta.dir, "vite.config.ts"))}, ${JSON.stringify(import.meta.dir)}, "error");
if (!loaded?.config) process.exitCode = 1;`,
		],
		{ cwd: import.meta.dir, encoding: "utf8", timeout: 30_000 },
	);
	expect(result.error).toBeUndefined();
	expect(result.status).toBe(0);
});
