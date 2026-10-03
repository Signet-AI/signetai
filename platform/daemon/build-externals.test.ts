import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { EXTERNAL_BUN } from "./build-externals";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureWithDroppedOptionalDependency(): string {
	const directory = mkdtempSync(join(tmpdir(), "signet-daemon-build-"));
	directories.push(directory);
	mkdirSync(join(directory, "node_modules"));
	symlinkSync(join(directory, "missing-store", "better-sqlite3"), join(directory, "node_modules", "better-sqlite3"));
	writeFileSync(
		join(directory, "entry.ts"),
		'export async function load() {\n\treturn (await import("better-sqlite3")).default;\n}\n',
	);
	return directory;
}

function buildFixture(directory: string, external: string[]) {
	return Bun.build({
		entrypoints: [join(directory, "entry.ts")],
		outdir: join(directory, "out"),
		target: "bun",
		format: "esm",
		external,
	});
}

describe("daemon Bun build externals", () => {
	test("the fixture reproduces a failed optional better-sqlite3 install", async () => {
		const directory = fixtureWithDroppedOptionalDependency();
		await expect(buildFixture(directory, [])).rejects.toThrow();
	});

	test("builds when bun install dropped better-sqlite3 after its native build failed", async () => {
		const directory = fixtureWithDroppedOptionalDependency();
		const result = await buildFixture(directory, [...EXTERNAL_BUN]);
		expect(result.success).toBe(true);
	});
});
