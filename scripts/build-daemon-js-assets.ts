#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dir, "..");
const source = join(root, "dist", "signetai", "runtime", "daemon-js");
const nativeDir = join(root, "dist", "native");
const version =
	process.env.SIGNET_VERSION?.trim() || JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const stage = spawnSync(process.execPath, [join(root, "scripts", "stage-daemon-js-runtime.ts")], {
	cwd: root,
	stdio: "inherit",
});
if (stage.status !== 0) throw new Error(`daemon runtime staging exited with status ${stage.status ?? "unknown"}`);

const tarballPath = join(nativeDir, `signet-daemon-js-${version}.tar.gz`);
if (!existsSync(join(source, "daemon.js"))) {
	throw new Error(`Bun JavaScript daemon bundle is missing: ${join(source, "daemon.js")}`);
}

mkdirSync(nativeDir, { recursive: true });

const result = spawnSync("tar", ["czf", tarballPath, "-C", join(source, "..", ".."), "runtime/daemon-js"], {
	stdio: "inherit",
});
if (result.status !== 0) {
	throw new Error(`tar exited with status ${result.status ?? "unknown"}`);
}

const bytes = statSync(tarballPath).size;
const sha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
const metadata = {
	name: `signet-daemon-js-${version}.tar.gz`,
	sha256,
	size: bytes,
};
writeFileSync(join(nativeDir, "daemon-js-manifest.json"), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`wrote ${tarballPath} (${bytes} bytes, sha256=${sha256})`);
