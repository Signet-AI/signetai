#!/usr/bin/env bun

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

function exec(command: string, args: readonly string[]): string {
	return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function remoteTag(tag: string): string | undefined {
	const refs = exec("git", ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
	const entries = refs
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split(/\s+/));
	return (entries.find((entry) => entry[1]?.endsWith("^{}")) ?? entries[0])?.[0];
}

function npmHasVersion(version: string): boolean {
	const result = spawnSync("npm", ["view", `signetai@${version}`, "version"], { encoding: "utf8" });
	if (result.status === 0) return result.stdout.trim() === version;
	if (result.stderr.includes("E404")) return false;
	throw new Error(`npm view signetai@${version} failed: ${result.stderr.trim()}`);
}

const channel = process.env.CHANNEL;
const sha = process.env.GITHUB_SHA ?? "";
const ref = process.env.GITHUB_REF;
const run = process.env.GITHUB_RUN_NUMBER ?? "";
const repo = process.env.GITHUB_REPOSITORY ?? "";
const output = process.env.GITHUB_OUTPUT;
const base: unknown = JSON.parse(readFileSync("package.json", "utf8")).version;
const plain = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
if (channel !== "check" && channel !== "next" && channel !== "stable") throw new Error("Invalid release channel");
if (!/^[a-f0-9]{40}$/.test(sha) || !/^[1-9]\d*$/.test(run) || !output || !repo)
	throw new Error("Missing release workflow context");
if (typeof base !== "string" || !plain.test(base)) throw new Error("Committed version must be plain x.y.z");
if ((channel === "stable" || channel === "next") && ref !== "refs/heads/main")
	throw new Error(`${channel} releases require refs/heads/main`);

const baseTag = channel === "check" ? undefined : remoteTag(`v${base}`);
const parts = base.split(".");
const version =
	channel === "stable"
		? base
		: channel === "next" && baseTag
			? `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}-next.${run}`
			: `${base}-${channel}.${run}`;
const tag = `v${version}`;
let notes = "";
if (channel === "stable") {
	notes = exec(process.execPath, ["scripts/extract-changelog-section.ts", version]);
	if (!notes.startsWith(`## [${version}]`) || !notes.includes("\n\n"))
		throw new Error(`Missing real CHANGELOG.md section for ${version}`);
	if (baseTag && baseTag !== sha) throw new Error(`${tag} points at a different commit than ${sha}`);
}

if (channel !== "check") {
	const lines = exec("gh", [
		"api",
		"--paginate",
		`repos/${repo}/releases?per_page=100`,
		"--jq",
		`.[] | select(.tag_name == "${tag}") | {draft, target_commitish} | @json`,
	])
		.split("\n")
		.filter(Boolean);
	if (lines.length > 1) throw new Error(`Found ${lines.length} GitHub releases for ${tag}; delete the duplicates`);
	const release: unknown = lines[0] === undefined ? null : JSON.parse(lines[0]);
	if (
		release !== null &&
		(typeof release !== "object" ||
			!("draft" in release) ||
			typeof release.draft !== "boolean" ||
			!("target_commitish" in release) ||
			typeof release.target_commitish !== "string")
	)
		throw new Error("Invalid GitHub release response");
	if (release && !release.draft)
		throw new Error(`${tag} is already published; re-run the failed jobs of its original Release run instead`);
	if (release && release.target_commitish !== sha)
		throw new Error(`Draft ${tag} targets a different commit; delete the draft before retrying`);
	if (!release && npmHasVersion(version))
		throw new Error(`signetai@${version} is already on npm but has no draft for ${sha}; prepare a new version`);
	if (channel === "stable") {
		const latest = exec("npm", ["view", "signetai", "dist-tags.latest"]);
		if (!plain.test(latest)) throw new Error(`Invalid npm latest version: ${latest}`);
		if (Bun.semver.order(version, latest) < 0)
			throw new Error(`${version} must not be older than npm latest ${latest}`);
	}
	if (!release) {
		const args = ["release", "create", tag, "--draft", "--target", sha, "--title", tag];
		args.push(...(channel === "next" ? ["--prerelease", "--generate-notes"] : ["--notes", notes]));
		exec("gh", args);
	}
}

appendFileSync(output, `version=${version}\ntag=${tag}\nsha=${sha}\nprerelease=${channel !== "stable"}\n`);
