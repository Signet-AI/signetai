#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

type Scalar = string | number | boolean;

export interface UpdateFile {
	readonly url: string;
	readonly sha512: string;
	readonly size: number;
	readonly [key: string]: Scalar;
}

export interface UpdateManifest {
	readonly version: string;
	readonly files: readonly UpdateFile[];
	readonly path: string;
	readonly sha512: string;
	readonly releaseDate: string;
}

function fail(message: string): never {
	throw new Error(`[mac update manifest] ${message}`);
}

function isScalar(value: unknown): value is Scalar {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function requireString(source: Record<string, unknown>, key: string, label: string): string {
	const value = source[key];
	if (typeof value !== "string" || value.length === 0) fail(`${label} is missing ${key}`);
	return value;
}

export function parseUpdateManifest(text: string, label: string): UpdateManifest {
	const raw: unknown = Bun.YAML.parse(text);
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(`${label} is not a mapping`);
	const source = raw as Record<string, unknown>;
	const version = source.version;
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) fail(`${label} has an invalid version`);
	if (!Array.isArray(source.files) || source.files.length === 0) fail(`${label} lists no files`);
	const files = source.files.map((entry: unknown, index: number) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) fail(`${label} file ${index} is invalid`);
		const file = entry as Record<string, unknown>;
		for (const [key, value] of Object.entries(file)) {
			if (!isScalar(value)) fail(`${label} file ${index} has a non-scalar ${key}`);
		}
		requireString(file, "url", `${label} file ${index}`);
		requireString(file, "sha512", `${label} file ${index}`);
		if (typeof file.size !== "number" || file.size <= 0) fail(`${label} file ${index} has an invalid size`);
		return file as UpdateFile;
	});
	return {
		version,
		files,
		path: requireString(source, "path", label),
		sha512: requireString(source, "sha512", label),
		releaseDate: requireString(source, "releaseDate", label),
	};
}

function isArm64File(file: UpdateFile): boolean {
	return file.url.includes("arm64");
}

function requireArch(manifest: UpdateManifest, arch: "x64" | "arm64"): void {
	for (const file of manifest.files) {
		if (isArm64File(file) !== (arch === "arm64")) fail(`${arch} manifest lists ${file.url}`);
	}
	if (!manifest.files.some((file) => file.url.endsWith(".zip"))) fail(`${arch} manifest lists no zip`);
}

export function validateMergedMacUpdateManifest(manifest: UpdateManifest, expectedVersion: string): void {
	if (manifest.version !== expectedVersion) {
		fail(`published manifest version mismatch: expected ${expectedVersion}, got ${manifest.version}`);
	}
	for (const arch of ["x64", "arm64"] as const) {
		if (!manifest.files.some((file) => file.url.endsWith(".zip") && isArm64File(file) === (arch === "arm64"))) {
			fail(`published manifest lists no ${arch} zip`);
		}
	}
}

export function mergeMacUpdateManifests(x64: UpdateManifest, arm64: UpdateManifest): UpdateManifest {
	if (x64.version !== arm64.version) fail(`version mismatch: x64 ${x64.version}, arm64 ${arm64.version}`);
	requireArch(x64, "x64");
	requireArch(arm64, "arm64");
	return {
		version: x64.version,
		files: [...x64.files, ...arm64.files],
		path: x64.path,
		sha512: x64.sha512,
		releaseDate: x64.releaseDate > arm64.releaseDate ? x64.releaseDate : arm64.releaseDate,
	};
}

export function renderUpdateManifest(manifest: UpdateManifest): string {
	const lines = [`version: ${JSON.stringify(manifest.version)}`, "files:"];
	for (const file of manifest.files) {
		Object.entries(file).forEach(([key, value], index) => {
			lines.push(`${index === 0 ? "  - " : "    "}${key}: ${JSON.stringify(value)}`);
		});
	}
	lines.push(`path: ${JSON.stringify(manifest.path)}`);
	lines.push(`sha512: ${JSON.stringify(manifest.sha512)}`);
	lines.push(`releaseDate: ${JSON.stringify(manifest.releaseDate)}`);
	return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			x64: { type: "string" },
			arm64: { type: "string" },
			out: { type: "string" },
			verify: { type: "string" },
			version: { type: "string" },
		},
	});
	if (values.verify) {
		if (!values.version) fail("usage: --verify <latest-mac.yml> --version <version>");
		validateMergedMacUpdateManifest(
			parseUpdateManifest(readFileSync(resolve(values.verify), "utf8"), "published"),
			values.version,
		);
		console.log(`Verified both macOS architectures for ${values.version} in ${values.verify}`);
	} else {
		if (!values.x64 || !values.arm64 || !values.out)
			fail("usage: --x64 <latest-mac.yml> --arm64 <latest-mac.yml> --out <path>");
		const merged = mergeMacUpdateManifests(
			parseUpdateManifest(readFileSync(resolve(values.x64), "utf8"), "x64"),
			parseUpdateManifest(readFileSync(resolve(values.arm64), "utf8"), "arm64"),
		);
		writeFileSync(resolve(values.out), renderUpdateManifest(merged));
		console.log(`Merged ${merged.files.length} macOS update files for ${merged.version} into ${values.out}`);
	}
}
