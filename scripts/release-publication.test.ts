import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const root = join(import.meta.dir, "..");
const workflow = parse(readFileSync(join(root, ".github/workflows/release.yml"), "utf8"));
const steps: { name: string; run: string }[] = workflow.jobs.publish.steps;
const script = (name: string): string => {
	const step = steps.find((step) => step.name === name);
	if (!step) throw new Error(`Missing workflow step ${name}`);
	return step.run;
};
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Registry {
	versions: Record<string, string>;
	tags: Record<string, Record<string, string>>;
	calls: string[][];
	public: boolean;
	assets?: string[];
	failPackage?: string;
	failFinalize?: boolean;
}
function fixture(channel = "stable") {
	const dir = mkdtempSync(join(tmpdir(), "signet-release-publish-"));
	dirs.push(dir);
	mkdirSync(join(dir, "scripts"));
	mkdirSync(join(dir, "tools"));
	copyFileSync(join(root, "scripts/advance-npm-dist-tag.sh"), join(dir, "scripts/advance-npm-dist-tag.sh"));
	copyFileSync(join(root, "scripts/retry-github-release.sh"), join(dir, "scripts/retry-github-release.sh"));
	const names: string[] = [];
	for (const match of script("Publish npm packages").matchAll(/^\s*publish_npm_package (.+?)( true)?$/gm)) {
		const path = match[1]?.replaceAll('"', "").replace("${STAGED_NPM_ROOT}", join(dir, "signet-npm-publish"));
		if (!path) throw new Error("Missing package path");
		const absolute = path.startsWith("/") ? path : join(dir, path);
		const name = path.includes("memory-adapter")
			? "@signetai/signet-memory-openclaw"
			: path.endsWith("dist/signetai")
				? "signetai"
				: `@signetai/${path.split("/").pop()}`;
		names.push(name);
		mkdirSync(absolute, { recursive: true });
		writeFileSync(join(absolute, "package.json"), JSON.stringify({ name, version: "1.0.1" }));
	}
	const stateFile = join(dir, "registry.json");
	writeFileSync(stateFile, JSON.stringify({ versions: {}, tags: {}, calls: [], public: false }));
	for (const command of ["npm", "gh"]) {
		const path = join(dir, "tools", command);
		writeFileSync(
			path,
			`#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const path = process.env.REGISTRY;
const state = JSON.parse(readFileSync(path, "utf8"));
const args = process.argv.slice(2);
state.calls.push([${JSON.stringify(command)}, ...args]);
const save = () => writeFileSync(path, JSON.stringify(state));
save();
if (${JSON.stringify(command)} === "gh") {
 if (args[1] === "view") { console.log(args.includes("isDraft") ? String(!state.public) : (state.assets ?? []).join("\\n")); process.exit(0); }
 if (state.failFinalize) process.exit(1);
 state.public = true; save(); process.exit(0);
}
if (args[0] === "config") process.exit(0);
if (args[0] === "view") {
 const name = args[1];
 if (args[2] === "version") {
  const split = name.lastIndexOf("@");
  const pkg = name.slice(0, split);
  const ref = name.slice(split + 1);
  const version = ref === "latest" ? state.tags[pkg]?.latest : state.versions[pkg];
  if (!version || (ref !== "latest" && version !== ref)) process.exit(1);
  console.log(version); process.exit(0);
 }
 console.log(state.tags[name]?.[args[2].replace("dist-tags.", "")] ?? ""); process.exit(0);
}
if (args[0] === "publish") {
 const pkg = JSON.parse(readFileSync("package.json", "utf8"));
 if (pkg.name === state.failPackage) process.exit(1);
 state.versions[pkg.name] = pkg.version;
 (state.tags[pkg.name] ??= {})[args[2]] = pkg.version;
 save(); process.exit(0);
}
if (args[0] === "dist-tag") {
 if (!state.public) process.exit(12);
 if (args[1] === "add") {
  const split = args[2].lastIndexOf("@");
  (state.tags[args[2].slice(0, split)] ??= {})[args[3]] = args[2].slice(split + 1);
 } else delete state.tags[args[2]][args[3]];
 save(); process.exit(0);
}
process.exit(9);
`,
		);
		chmodSync(path, 0o755);
	}
	return {
		names,
		read: (): Registry => JSON.parse(readFileSync(stateFile, "utf8")),
		write: (state: Registry): void => writeFileSync(stateFile, JSON.stringify(state)),
		run: (name: string, body = script(name)) =>
			Bun.spawnSync(["bash", "-c", body], {
				cwd: dir,
				env: {
					...process.env,
					RUNNER_TEMP: dir,
					PATH: `${dir}/tools:${process.env.PATH}`,
					REGISTRY: stateFile,
					NEW_VERSION: "1.0.1",
					VERSION: "1.0.1",
					NODE_AUTH_TOKEN: "test-only-not-a-token",
					GITHUB_REPOSITORY: "example/repo",
					CHANNEL: channel,
				},
				stdout: "pipe",
				stderr: "pipe",
			}),
	};
}

test("real publication steps stage every package before finalizing and advancing stable channels", () => {
	const value = fixture();
	for (const name of ["Publish npm packages", "Finalize GitHub release", "Advance npm channels"]) {
		const result = value.run(name);
		expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
		const state = value.read();
		if (name === "Publish npm packages") {
			expect(state.public).toBe(false);
			expect(Object.keys(state.versions).sort()).toEqual([...value.names].sort());
			for (const tags of Object.values(state.tags)) expect(tags).toEqual({ "release-staging": "1.0.1" });
		}
	}
	for (const tags of Object.values(value.read().tags)) expect(tags).toEqual({ latest: "1.0.1", next: "1.0.1" });
	const published = value.read().calls.filter((call) => call[1] === "publish").length;
	for (const name of ["Publish npm packages", "Finalize GitHub release", "Advance npm channels"])
		expect(value.run(name).exitCode).toBe(0);
	expect(value.read().calls.filter((call) => call[1] === "publish")).toHaveLength(published);
});

test("next advances only next and tolerates an unavailable optional adapter", () => {
	const value = fixture("next");
	value.write({ ...value.read(), failPackage: "@signetai/signet-memory-openclaw" });
	for (const name of ["Publish npm packages", "Finalize GitHub release", "Advance npm channels"])
		expect(value.run(name).exitCode).toBe(0);
	const state = value.read();
	expect(state.versions["@signetai/signet-memory-openclaw"]).toBeUndefined();
	for (const tags of Object.values(state.tags)) expect(tags).toEqual({ next: "1.0.1" });
});

test("required npm failure stops before finalization and leaves no user-facing tags", () => {
	const value = fixture();
	value.write({ ...value.read(), failPackage: "signetai" });
	expect(value.run("Publish npm packages").exitCode).not.toBe(0);
	const state = value.read();
	expect(state.public).toBe(false);
	for (const tags of Object.values(state.tags)) expect(tags.latest ?? tags.next).toBeUndefined();
	value.write({ ...state, failPackage: undefined });
	for (const name of ["Publish npm packages", "Finalize GitHub release", "Advance npm channels"])
		expect(value.run(name).exitCode).toBe(0);
	for (const tags of Object.values(value.read().tags)) expect(tags.latest).toBe("1.0.1");
});

test("stable leaves a newer development next tag ahead", () => {
	const value = fixture();
	value.write({
		...value.read(),
		tags: Object.fromEntries(value.names.map((name) => [name, { next: "1.1.0-next.3" }])),
	});
	for (const name of ["Publish npm packages", "Finalize GitHub release", "Advance npm channels"])
		expect(value.run(name).exitCode).toBe(0);
	for (const tags of Object.values(value.read().tags)) expect(tags).toEqual({ latest: "1.0.1", next: "1.1.0-next.3" });
});

test("the asset gate rejects any missing native, desktop, or manifest asset", () => {
	const value = fixture();
	const expected = script("Verify all release assets").match(/expected=\(([\s\S]*?)\)/)?.[1];
	if (!expected) throw new Error("Missing asset list");
	const assets = expected
		.trim()
		.split(/\s+/)
		.map((asset) => asset.replaceAll('"', "").replaceAll("${NEW_VERSION}", "1.0.1"));
	for (const missing of ["signet-linux-x64", "native-manifest.json", "latest-mac.yml", "Signet-1.0.1-win-x64.exe"]) {
		value.write({ ...value.read(), assets: assets.filter((asset) => asset !== missing) });
		const result = value.run("Verify all release assets");
		expect(result.exitCode).not.toBe(0);
		expect(new TextDecoder().decode(result.stdout)).toContain(`Missing release asset: ${missing}`);
	}
	value.write({ ...value.read(), assets });
	expect(value.run("Verify all release assets").exitCode).toBe(0);
});

test("failed GitHub finalization leaves staged versions for an idempotent retry", () => {
	const value = fixture();
	expect(value.run("Publish npm packages").exitCode).toBe(0);
	value.write({ ...value.read(), failFinalize: true });
	expect(value.run("Finalize GitHub release").exitCode).not.toBe(0);
	expect(value.read().public).toBe(false);
	for (const tags of Object.values(value.read().tags)) expect(tags).toEqual({ "release-staging": "1.0.1" });
	value.write({ ...value.read(), failFinalize: false });
	for (const name of ["Publish npm packages", "Finalize GitHub release", "Advance npm channels"])
		expect(value.run(name).exitCode).toBe(0);
});

test("rollback requires all packages and a public release before moving only latest backward", () => {
	const value = fixture();
	const rollback = parse(readFileSync(join(root, ".github/workflows/promote-release.yml"), "utf8")).jobs.promote
		.steps[0].run;
	expect(value.run("rollback", rollback).exitCode).not.toBe(0);
	expect(value.run("Publish npm packages").exitCode).toBe(0);
	expect(value.run("rollback", rollback).exitCode).not.toBe(0);
	expect(value.read().calls.filter((call) => call[1] === "dist-tag")).toHaveLength(0);
	value.write({
		...value.read(),
		public: true,
		tags: Object.fromEntries(value.names.map((name) => [name, { latest: "1.0.2", next: "1.1.0-next.3" }])),
	});
	const result = value.run("rollback", rollback);
	expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
	for (const tags of Object.values(value.read().tags)) expect(tags).toEqual({ latest: "1.0.1", next: "1.1.0-next.3" });
});
