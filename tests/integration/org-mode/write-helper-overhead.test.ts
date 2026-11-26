import assert from "node:assert/strict";
import { test } from "bun:test";
import { join } from "node:path";

test("Actual remember and prompt capture helper overhead stays below 1ms p95", async () => {
	const child = Bun.spawn(
		[process.execPath, join(import.meta.dir, "../../../evals/compartment-writes/helper-overhead.ts")],
		{
			env: process.env,
			timeout: 50_000,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	console.log(stdout);
	assert.equal(await child.exited, 0, stderr);
	assert.equal(stdout.split("\n").filter((line) => line.startsWith('{"benchmark":')).length, 2);
}, 60_000);
