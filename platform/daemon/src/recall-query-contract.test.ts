import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("recall queries do not depend on SQLite generated autoindex names", () => {
	expect(readFileSync(new URL("./memory-search.ts", import.meta.url), "utf8")).not.toContain(
		"INDEXED BY sqlite_autoindex_memories_1",
	);
});

test("the recall performance fixture is opt-in rather than normal CI work", async () => {
	const home = mkdtempSync(join(tmpdir(), "signet-benchmark-admission-"));
	try {
		const env = { ...process.env, HOME: home };
		delete env.SIGNET_RECALL_BENCHMARK;
		delete env.SIGNET_PATH;
		const child = Bun.spawn(
			[process.execPath, "scripts/run-hermetic-tests.ts", "platform/daemon/src/memory-search-benchmark.test.ts"],
			{ env, stdout: "pipe", stderr: "pipe" },
		);
		const [out, err, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code).toBe(0);
		expect(out + err).not.toContain("RECALL_BENCHMARK {");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}, 60000);
