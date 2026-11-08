import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const root = join(import.meta.dir, "..");
const releaseText = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
const desktopText = readFileSync(join(root, ".github/workflows/desktop-build.yml"), "utf8");
const release = parse(releaseText);
const desktop = parse(desktopText);

test("directly executed release helpers remain committed executable", () => {
	const entries = execFileSync(
		"git",
		["ls-files", "-s", "scripts/advance-npm-dist-tag.sh", "scripts/retry-github-release.sh"],
		{ cwd: root, encoding: "utf8" },
	);
	expect(
		entries
			.trim()
			.split("\n")
			.map((line) => line.split(/\s+/)[0]),
	).toEqual(["100755", "100755"]);
});

test("Release is manual with exactly three channels and per-channel queueing", () => {
	expect(release.name).toBe("Release");
	expect(Object.keys(release.on)).toEqual(["workflow_dispatch"]);
	expect(Object.keys(release.on.workflow_dispatch.inputs)).toEqual(["channel"]);
	expect(release.on.workflow_dispatch.inputs.channel).toEqual({
		description: "Release channel",
		type: "choice",
		required: true,
		default: "check",
		options: ["check", "next", "stable"],
	});
	expect(release.concurrency).toEqual({ group: "release-${{ inputs.channel }}", "cancel-in-progress": false });
	expect(releaseText).not.toMatch(/^\s*push:/m);
	expect(releaseText).not.toMatch(/git (push|tag)\b/);
	for (const retired of [
		"resume_from_tag",
		"signing_preflight_only",
		"macos-signing-preflight",
		"RELEASE_PAT",
		"Check for code changes",
		"Sync with remote main",
		"Bump version",
		"Push version bump",
	])
		expect(releaseText).not.toContain(retired);
});

test("builds use the planned SHA and stamp before installing or building", () => {
	for (const name of ["build-native", "publish"]) {
		const steps = release.jobs[name].steps;
		expect(steps[0].with.ref).toBe("${{ needs.plan.outputs.sha }}");
		const stamp = steps.findIndex((step: { name?: string }) => step.name === "Stamp release version");
		const install = steps.findIndex((step: { name?: string }) => step.name === "Install dependencies");
		expect(stamp).toBeGreaterThan(0);
		expect(stamp).toBeLessThan(install);
		expect(steps[stamp].run).toContain('bun scripts/version-sync.ts --to "$RELEASE_VERSION"');
		expect(steps[stamp].run).toContain('if [ "$RELEASE_VERSION" !=');
	}
});

test("desktop is reusable without a tag trigger and check has no publication target", () => {
	expect(Object.keys(desktop.on).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
	expect(Object.keys(desktop.on.workflow_call.inputs).sort()).toEqual(["ref", "release_tag", "version"]);
	expect(desktopText).not.toContain("startsWith(github.ref");
	expect(desktopText).not.toContain("GITHUB_REF_NAME");
	expect(release.jobs.desktop.needs).toBe("plan");
	expect(release.jobs.desktop.uses).toBe("./.github/workflows/desktop-build.yml");
	expect(release.jobs.desktop.secrets).toBe("inherit");
	expect(release.jobs.desktop.with.ref).toBe("${{ needs.plan.outputs.sha }}");
	expect(release.jobs.desktop.with.version).toBe("${{ needs.plan.outputs.version }}");
	expect(release.jobs.desktop.with.release_tag).toBe(
		"${{ inputs.channel != 'check' && needs.plan.outputs.tag || '' }}",
	);
	expect(desktop.jobs.build.steps[0].with.ref).toBe("${{ inputs.ref || github.sha }}");
	expect(desktopText).toContain('bun scripts/version-sync.ts --to "$RELEASE_VERSION"');
});

test("publication stages npm behind all builds and assets before finalizing then moving tags", () => {
	expect(release.jobs.publish.needs).toEqual(["plan", "build-native", "desktop"]);
	expect(release.jobs.publish.if).toBe("inputs.channel != 'check'");
	const names = release.jobs.publish.steps.map((step: { name?: string }) => step.name);
	const order = [
		"Verify all release assets",
		"Verify macOS update manifest",
		"Pack native npm release assets",
		"Validate publish manifests",
		"Stage scoped npm packages",
		"Publish npm packages",
		"Finalize GitHub release",
		"Advance npm channels",
	];
	let previous = -1;
	for (const name of order) {
		const index = names.indexOf(name);
		expect(index).toBeGreaterThan(previous);
		previous = index;
	}
	const upload = release.jobs["build-native"].steps.find(
		(step: { name?: string }) => step.name === "Upload to release",
	);
	expect(upload.if).toBe("inputs.channel != 'check'");
	expect(releaseText).not.toContain("Wait for desktop release assets");
	expect(releaseText).not.toContain("sleep 30");
	expect(releaseText).toContain("--prerelease=false --latest");
	expect(releaseText).toContain("--prerelease --latest=false");
	const publish = release.jobs.publish.steps.find(
		(step: { name?: string }) => step.name === "Publish npm packages",
	).run;
	expect(publish).toContain("npm publish --tag release-staging");
	expect(publish).not.toContain("dist-tag");
	const advance = release.jobs.publish.steps.find(
		(step: { name?: string }) => step.name === "Advance npm channels",
	).run;
	expect(advance).toContain('scripts/advance-npm-dist-tag.sh "${package_name}" "${NEW_VERSION}" latest');
	expect(advance).toContain('scripts/advance-npm-dist-tag.sh "${package_name}" "${NEW_VERSION}" next');
	expect(advance.indexOf(" next")).toBeLessThan(advance.indexOf("dist-tag rm"));
});

test("rollback admits only plain published non-draft releases and leaves next unchanged", () => {
	const text = readFileSync(join(root, ".github/workflows/promote-release.yml"), "utf8");
	expect(parse(text).name).toBe("Point Stable at Release");
	expect(text).toContain("--json isDraft");
	expect(text).toContain('"${draft}" != "false"');
	expect(text).not.toContain("(-[0-9A-Za-z.-]+)");
	expect(text).not.toMatch(/dist-tag add .* next/);
	expect(text.indexOf("--json isDraft")).toBeLessThan(text.indexOf("npm dist-tag add"));
});
