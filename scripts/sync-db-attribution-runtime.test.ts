import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const tempDirs: string[] = [];

interface ProbeResult {
	readonly one?: unknown;
	readonly two?: unknown;
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function outputOf(result: ReturnType<typeof spawnSync>): string {
	return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function parseProbeOutput(output: string): ProbeResult {
	const lines = output.trim().split("\n");
	const lastLine = lines.at(-1);
	if (lastLine === undefined) throw new Error(`probe did not return JSON:\n${output}`);
	const parsed: unknown = JSON.parse(lastLine);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`probe returned non-object JSON:\n${output}`);
	}
	return parsed as ProbeResult;
}

function runProbe(command: string, args: readonly string[] = []): ProbeResult {
	const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
	const output = outputOf(result);
	expect(result.error, output).toBeUndefined();
	expect(result.status, output).toBe(0);
	return parseProbeOutput(output);
}

describe("sync DB attribution runtime boundaries", () => {
	test("keeps distinct caller locations in Bun bundles and compiled binaries", () => {
		const directory = mkdtempSync(join(tmpdir(), "signet-sync-db-attribution-runtime-"));
		tempDirs.push(directory);
		const fixture = join(directory, "attribution-probe.ts");
		const bundle = join(directory, "attribution-probe.bundle.js");
		const binary = join(directory, process.platform === "win32" ? "attribution-probe.exe" : "attribution-probe");
		const attribution = join(root, "platform", "daemon", "src", "db-accessor.ts");

		writeFileSync(
			fixture,
			`import { runWriteTxAsync } from ${JSON.stringify(attribution)};

const accessor = {
  withWriteTxAsync: async (_fn: unknown, options?: { siteToken?: string }): Promise<string | undefined> =>
    options?.siteToken,
};

async function callerOne(): Promise<string | undefined> {
  return runWriteTxAsync(accessor as never, () => 0);
}

async function callerTwo(): Promise<string | undefined> {
  return runWriteTxAsync(accessor as never, () => 0);
}

const one = await callerOne();
const two = await callerTwo();
if (one === undefined || two === undefined || one === two) {
  throw new Error(\`distinct caller attribution failed: \${String(one)} / \${String(two)}\`);
}
console.log(JSON.stringify({ one, two }));
process.exit(0);
`,
		);

		const bundleBuild = spawnSync(
			process.execPath,
			["build", "--target=bun", "--external", "better-sqlite3", "--outfile", bundle, fixture],
			{
				cwd: root,
				encoding: "utf8",
				timeout: 120_000,
			},
		);
		const bundleBuildOutput = outputOf(bundleBuild);
		expect(bundleBuild.error, bundleBuildOutput).toBeUndefined();
		expect(bundleBuild.status, bundleBuildOutput).toBe(0);
		const bundled = runProbe(process.execPath, [bundle]);
		expect(bundled.one).toEqual(expect.any(String));
		expect(bundled.two).toEqual(expect.any(String));
		expect(bundled.one).toMatch(/:\d+$/);
		expect(bundled.two).toMatch(/:\d+$/);
		expect(bundled.one).not.toBe(bundled.two);

		const compileBuild = spawnSync(
			process.execPath,
			["build", "--compile", "--target=bun", "--external", "better-sqlite3", "--outfile", binary, fixture],
			{ cwd: root, encoding: "utf8", timeout: 120_000 },
		);
		const compileBuildOutput = outputOf(compileBuild);
		expect(compileBuild.error, compileBuildOutput).toBeUndefined();
		expect(compileBuild.status, compileBuildOutput).toBe(0);
		if (process.platform !== "win32") chmodSync(binary, 0o755);
		const compiled = runProbe(binary);
		expect(compiled.one).toEqual(expect.any(String));
		expect(compiled.two).toEqual(expect.any(String));
		expect(compiled.one).toMatch(/:\d+$/);
		expect(compiled.two).toMatch(/:\d+$/);
		expect(compiled.one).not.toBe(compiled.two);
	});
});
