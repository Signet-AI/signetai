import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "verify-macos-release.mjs");
const macosTest = process.platform === "darwin" ? test : test.skip;

function run(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`);
}

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "signet-verification-test-"));
	const release = join(directory, "release");
	const app = join(release, "Signet.app");
	const framework = join(app, "Contents", "Frameworks", "Proof.framework");
	const resources = join(framework, "Versions", "A", "Resources");
	const bin = join(directory, "bin");
	const scratch = join(directory, "scratch");
	const log = join(directory, "calls.log");
	mkdirSync(resources, { recursive: true });
	mkdirSync(bin);
	mkdirSync(scratch);
	writeFileSync(
		join(resources, "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.signet.proof</string>
<key>CFBundleExecutable</key><string>Proof</string>
<key>CFBundlePackageType</key><string>FMWK</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>`,
	);
	const source = join(directory, "proof.c");
	writeFileSync(source, "int proof(void) { return 1; }\n");
	run("clang", ["-dynamiclib", source, "-o", join(framework, "Versions", "A", "Proof")]);
	symlinkSync("A", join(framework, "Versions", "Current"));
	symlinkSync("Versions/Current/Proof", join(framework, "Proof"));
	symlinkSync("Versions/Current/Resources", join(framework, "Resources"));
	run("/usr/bin/codesign", ["--force", "--sign", "-", framework]);
	run("/usr/bin/xattr", ["-w", "ai.signet.verification", "preserved", app]);

	writeFileSync(
		join(bin, "codesign"),
		`#!/bin/bash
if [[ "$1" == --display ]]; then
  printf 'Authority=Developer ID Application: Fixture\nTeamIdentifier=TEAM123456\n'
  exit 0
fi
/usr/bin/codesign --verify --strict "\${@: -1}/Contents/Frameworks/Proof.framework"
`,
		{ mode: 0o755 },
	);
	writeFileSync(
		join(bin, "xcrun"),
		`#!/bin/bash
printf '%s\n' 'stapler fixture' >> "$VERIFICATION_LOG"
`,
		{ mode: 0o755 },
	);
	writeFileSync(
		join(bin, "spctl"),
		`#!/bin/bash
app="\${@: -1}"
printf '%s\n' 'Gatekeeper fixture' >> "$VERIFICATION_LOG"
if [[ "\${VERIFICATION_REJECT:-0}" == 1 ]]; then
  printf 'fixture Gatekeeper rejection\n' >&2
  exit 3
fi
/usr/bin/codesign --verify --strict "$app/Contents/Frameworks/Proof.framework" || exit 1
[[ "$(/usr/bin/readlink "$app/Contents/Frameworks/Proof.framework/Resources")" == Versions/Current/Resources ]] || exit 1
[[ "$(/usr/bin/xattr -p ai.signet.verification "$app")" == preserved ]] || exit 1
`,
		{ mode: 0o755 },
	);
	return { directory, release, scratch, bin, log, app };
}

macosTest("Gatekeeper copy preserves signed framework seals, relative links, and extended attributes", () => {
	const value = fixture();
	try {
		const result = spawnSync("node", [script, value.release], {
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${value.bin}:${process.env.PATH}`,
				TMPDIR: value.scratch,
				VERIFICATION_LOG: value.log,
			},
		});
		expect(`${result.stdout}${result.stderr}`).toContain("macOS release verification passed");
		expect(result.status).toBe(0);
		expect(existsSync(value.app)).toBe(true);
		expect(readdirSync(value.scratch)).toEqual([]);
	} finally {
		rmSync(value.directory, { recursive: true, force: true });
	}
});

macosTest("Gatekeeper rejection remains fatal and removes the temporary copy", () => {
	const value = fixture();
	try {
		const result = spawnSync("node", [script, value.release], {
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${value.bin}:${process.env.PATH}`,
				TMPDIR: value.scratch,
				VERIFICATION_LOG: value.log,
				VERIFICATION_REJECT: "1",
			},
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("fixture Gatekeeper rejection");
		expect(result.stdout).not.toContain("macOS release verification passed");
		expect(existsSync(value.app)).toBe(true);
		expect(readdirSync(value.scratch)).toEqual([]);
	} finally {
		rmSync(value.directory, { recursive: true, force: true });
	}
});
