import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dirs: string[] = [];
const binary = Buffer.from("#!/bin/sh\nprintf 'verified signet\\n'\n");
const platform = `${process.platform}-${process.arch}`;
const name = process.platform === "win32" ? "signet.exe" : "signet";

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { readonly pkg: string; readonly source: string; readonly target: string } {
	const pkg = mkdtempSync(join(tmpdir(), "signet-install-integrity-"));
	dirs.push(pkg);
	cpSync(join(root, "dist/signetai/scripts"), join(pkg, "scripts"), { recursive: true });
	cpSync(join(root, "dist/signetai/bin"), join(pkg, "bin"), { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ type: "module", version: "0.0.0" }));
	const native = join(pkg, "node_modules", `signetai-${platform}`);
	mkdirSync(join(native, "bin"), { recursive: true });
	writeFileSync(join(native, "package.json"), JSON.stringify({ version: "0.0.0" }));
	const source = join(native, "bin", name);
	writeFileSync(source, binary);
	writeFileSync(
		join(pkg, "native-manifest.json"),
		JSON.stringify({
			schemaVersion: 1,
			version: "0.0.0",
			assets: [{ platform, size: binary.length, sha256: createHash("sha256").update(binary).digest("hex") }],
		}),
	);
	return { pkg, source, target: join(pkg, "native", name) };
}

function install(pkg: string, runtime = "node"): ReturnType<typeof spawnSync> {
	return spawnSync(runtime, [join(pkg, "scripts/install-native.js")], {
		env: { ...process.env, SIGNET_TELEMETRY_OPTOUT: "1", SIGNET_SKIP_NATIVE_POSTINSTALL: "0" },
		encoding: "utf8",
		timeout: 10_000,
	});
}

for (const damage of ["truncated", "same-size corruption"] as const) {
	for (const previous of [false, true]) {
		test(`postinstall rejects ${damage} and preserves ${previous ? "the previous executable" : "an absent executable"}`, () => {
			const f = fixture();
			mkdirSync(join(f.pkg, "native"));
			if (previous) writeFileSync(f.target, binary);
			writeFileSync(f.source, damage === "truncated" ? binary.subarray(12) : Buffer.alloc(binary.length, 120));

			const result = install(f.pkg);

			expect(result.status).toBe(1);
			expect(result.stderr.toString()).toContain(damage === "truncated" ? "size mismatch" : "SHA-256 mismatch");
			expect(existsSync(f.target)).toBe(previous);
			if (previous) expect(readFileSync(f.target)).toEqual(binary);
			expect(readdirSync(join(f.pkg, "native"))).toEqual(previous ? [name] : []);
		});
	}
}

for (const manifest of [null, "invalid JSON", { assets: [] }, { assets: [{ platform, size: binary.length }] }]) {
	test(`postinstall fails closed without usable release integrity metadata: ${JSON.stringify(manifest)}`, () => {
		const f = fixture();
		if (manifest === null) rmSync(join(f.pkg, "native-manifest.json"));
		else
			writeFileSync(
				join(f.pkg, "native-manifest.json"),
				typeof manifest === "string" ? manifest : JSON.stringify(manifest),
			);

		const result = install(f.pkg);

		expect(result.status).toBe(1);
		expect(result.stderr.toString()).toContain("integrity metadata");
		expect(existsSync(f.target)).toBe(false);
	});
}

test.each(["node", "bun"])("%s postinstall survives cache mutation and rejects a damaged retry", (runtime) => {
	const f = fixture();
	mkdirSync(join(f.pkg, "native"));
	writeFileSync(f.target, "previous executable");

	const result = install(f.pkg, runtime);

	expect(result.status).toBe(0);
	expect(readFileSync(f.target)).toEqual(binary);
	writeFileSync(f.source, binary.subarray(12));
	expect(readFileSync(f.target)).toEqual(binary);
	expect(install(f.pkg, runtime).status).toBe(1);
	expect(readFileSync(f.target)).toEqual(binary);
	expect(readdirSync(join(f.pkg, "native"))).toEqual([name]);
	if (process.platform === "win32") return;
	const launch = spawnSync(f.target, ["--version"], { encoding: "utf8", timeout: 10_000 });
	expect(launch.status).toBe(0);
	expect(launch.stdout).toBe("verified signet\n");
	expect(launch.stderr).toBe("");
});

test("postinstall leaves an existing target directory untouched when publication fails", () => {
	const f = fixture();
	mkdirSync(f.target, { recursive: true });
	writeFileSync(join(f.target, "sentinel"), "preserve");

	const result = install(f.pkg);

	expect(result.status).toBe(1);
	expect(readFileSync(join(f.target, "sentinel"), "utf8")).toBe("preserve");
	expect(readdirSync(join(f.pkg, "native"))).toEqual([name]);
});
