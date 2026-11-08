import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const sha = "a".repeat(40);
interface Scenario {
	channel?: string;
	base?: string;
	ref?: string;
	tagSha?: string;
	latest?: string;
	release?: { draft: boolean; target_commitish: string };
	notes?: string;
	apiFails?: boolean;
}
function run(scenario: Scenario = {}) {
	const dir = mkdtempSync(join(tmpdir(), "signet-release-plan-"));
	dirs.push(dir);
	mkdirSync(join(dir, "scripts"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ version: scenario.base ?? "1.0.1" }));
	writeFileSync(
		join(dir, "scripts/extract-changelog-section.ts"),
		`console.log(${JSON.stringify(scenario.notes ?? "## [1.0.1] - 2026-11-07\n\nBug fixes.")});`,
	);
	for (const command of ["gh", "git", "npm"]) {
		writeFileSync(
			join(dir, command),
			`#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.LOG, JSON.stringify([${JSON.stringify(command)}, ...args]) + "\\n");
const scenario = JSON.parse(process.env.SCENARIO);
if (${JSON.stringify(command)} === "git") console.log(scenario.tagSha ? scenario.tagSha + "\\trefs/tags/v1.0.1^{}" : "");
if (${JSON.stringify(command)} === "npm") console.log(scenario.latest ?? "1.0.0");
if (${JSON.stringify(command)} === "gh" && args[0] === "api") {
 if (scenario.apiFails) process.exit(1);
 if (args[1] === "graphql") console.log(scenario.release ? "123" : "0");
 else console.log(JSON.stringify({ tag_name: "v" + (scenario.channel === "next" ? "1.0.1-next.42" : "1.0.1"), ...scenario.release }));
}
`,
		);
		chmodSync(join(dir, command), 0o755);
	}
	const output = join(dir, "output");
	writeFileSync(output, "");
	const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "release-plan.ts")], {
		cwd: dir,
		env: {
			...process.env,
			PATH: `${dir}:${process.env.PATH}`,
			CHANNEL: scenario.channel ?? "stable",
			GITHUB_SHA: sha,
			GITHUB_REF: scenario.ref ?? "refs/heads/main",
			GITHUB_RUN_NUMBER: "42",
			GITHUB_REPOSITORY: "example/repo",
			GITHUB_OUTPUT: output,
			LOG: join(dir, "log"),
			SCENARIO: JSON.stringify(scenario),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		result,
		error: new TextDecoder().decode(result.stderr),
		output: readFileSync(output, "utf8"),
		calls: Bun.file(join(dir, "log")),
	};
}

test("stable plans the committed SHA and creates an untagged draft with changelog notes", async () => {
	const value = run();
	expect(value.result.exitCode, value.error).toBe(0);
	expect(value.output).toBe(`version=1.0.1\ntag=v1.0.1\nsha=${sha}\nprerelease=false\n`);
	const calls = await value.calls.text();
	expect(calls).toContain('"api","graphql"');
	expect(calls).not.toContain("--paginate");
	expect(calls).toContain(`"--draft","--target","${sha}`);
	expect(calls).toContain('"--notes"');
	expect(calls).not.toContain('"push"');
	expect(calls).not.toContain('"--prerelease"');
});

test("stable rejects wrong refs, invalid versions, missing notes, older versions, and conflicting tags/drafts", () => {
	for (const scenario of [
		{ ref: "refs/heads/feature" },
		{ base: "1.0.1-next.1" },
		{ base: "01.0.1" },
		{ notes: "No changelog section found for v1.0.1" },
		{ latest: "1.0.2" },
		{ tagSha: "b".repeat(40) },
		{ release: { draft: true, target_commitish: "b".repeat(40) } },
		{ apiFails: true },
	]) {
		const value = run(scenario);
		expect(value.result.exitCode).not.toBe(0);
		expect(value.output).toBe("");
	}
	expect(run({ release: { draft: true, target_commitish: "b".repeat(40) } }).error).toContain("delete the draft");
});

test("stable blocks completed releases but resumes before either finalization boundary", async () => {
	const complete = run({ latest: "1.0.1", release: { draft: false, target_commitish: sha }, tagSha: sha });
	expect(complete.result.exitCode).not.toBe(0);
	expect(complete.error).toContain("already released");
	for (const draft of [true, false]) {
		const resumed = run({ release: { draft, target_commitish: sha }, latest: draft ? "1.0.1" : "1.0.0", tagSha: sha });
		expect(resumed.result.exitCode, resumed.error).toBe(0);
		expect(await resumed.calls.text()).not.toContain('"create"');
	}
});

test("next uses the unreleased base or the next patch after a base tag", async () => {
	for (const tagSha of [undefined, sha]) {
		const value = run({ channel: "next", tagSha });
		expect(value.result.exitCode, value.error).toBe(0);
		expect(value.output).toContain(`version=1.0.${tagSha ? 2 : 1}-next.42`);
		expect(value.output).toContain("prerelease=true");
		const calls = await value.calls.text();
		expect(calls).toContain('"--prerelease"');
		expect(calls).toContain('"--generate-notes"');
		expect(calls).not.toContain('"npm"');
	}
});

test("next resumes its run-number draft without recreating it", async () => {
	const value = run({ channel: "next", release: { draft: true, target_commitish: sha } });
	expect(value.result.exitCode, value.error).toBe(0);
	const calls = await value.calls.text();
	expect(calls).not.toContain('"create"');
	expect(calls).toContain('"api","repos/example/repo/releases/123"');
	expect(calls).toContain('"tag=v1.0.1-next.42"');
});

test("check uses only local metadata and never calls publication services", () => {
	const value = run({ channel: "check" });
	expect(value.result.exitCode, value.error).toBe(0);
	expect(value.output).toContain("version=1.0.1-check.42");
	expect(value.calls.size).toBe(0);
});
