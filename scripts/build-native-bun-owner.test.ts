import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nativeWorkerBootstrap } from "./lib/native-worker-bootstrap";

test("bundled owner worker loads its native scan without the parent asset registry", () => {
	const root = resolve(import.meta.dir, "..");
	const directory = mkdtempSync(join(tmpdir(), "signet-owner-native-"));
	try {
		const suffix = `${process.platform}-${process.arch}${process.platform === "linux" ? "-gnu" : process.platform === "win32" ? "-msvc" : ""}`;
		const addon = join(root, "platform/native", `signet-native.${suffix}.node`);
		const registry = join(root, "platform/daemon/src/native-runtime-assets.ts");
		const entry = join(directory, "owner.ts");
		writeFileSync(
			entry,
			`import { materializeEmbeddedNativeAddon } from ${JSON.stringify(registry)};
const path=materializeEmbeddedNativeAddon("signet-native");
if(!path)throw Error("owner_native_asset_missing");
const addon=require(path);
const rows=Buffer.alloc(8);rows.writeBigInt64LE(1n);
const result=addon.scanAdmittedVectors(new Float32Array([1,0,0]),[{vectors:Buffer.from(new Float32Array([1,0,0]).buffer),rowids:rows,validity:Buffer.from([1]),eligibility:Buffer.from([1])}],1);
console.log(JSON.stringify(result));`,
		);
		const bootstrap = join(directory, "bootstrap.ts");
		writeFileSync(
			bootstrap,
			nativeWorkerBootstrap(entry, registry, [
				{ name: "signet-native", contentBase64: readFileSync(addon).toString("base64") },
			]),
		);
		const bundle = join(directory, "worker.mjs");
		const build = spawnSync(
			process.execPath,
			["build", "--target=bun", "--format=esm", "--outfile", bundle, bootstrap],
			{ encoding: "utf8" },
		);
		expect(build.status).toBe(0);
		const result = spawnSync(process.execPath, [bundle], {
			cwd: directory,
			env: { ...process.env, TMPDIR: directory },
			encoding: "utf8",
		});
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			rows: [{ rowid: "1", distance: 0 }],
			scannedRows: 1,
			eligibleRows: 1,
			heapPeak: 1,
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
