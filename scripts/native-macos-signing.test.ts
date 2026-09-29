import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const directories: string[] = [];

async function signingFixture(team = "TEAM123456"): Promise<{
	readonly binary: string;
	readonly log: string;
	readonly path: string;
}> {
	const directory = await mkdtemp(join(tmpdir(), "signet-macos-signing-"));
	directories.push(directory);
	const bin = join(directory, "bin");
	await mkdir(bin);
	const log = join(directory, "calls.log");
	const binary = join(directory, "signet-darwin-arm64");
	await writeFile(binary, "Mach-O fixture");
	await writeFile(
		join(bin, "security"),
		`#!/bin/sh
printf 'security:%s\\n' "$*" >> "$SIGNING_LOG"
if [ "$1" = find-identity ]; then
  printf '  1) ABCDEF "Developer ID Application: Signet AI (${team})"\n  1 valid identities found\n'
fi
`,
		{ mode: 0o700 },
	);
	await writeFile(
		join(bin, "codesign"),
		`#!/bin/sh
printf 'codesign:%s\\n' "$*" >> "$SIGNING_LOG"
case "$*" in
  *--display*--requirements*) printf 'designated => anchor apple generic and identifier "ai.signet.cli" and certificate leaf[subject.OU] = "${team}"\\n' ;;
  *--display*) printf 'Identifier=ai.signet.cli\\nTeamIdentifier=${team}\\nAuthority=Developer ID Application: Signet AI (${team})\\n' ;;
esac
`,
		{ mode: 0o700 },
	);
	return { binary, log, path: bin };
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("signs the macOS CLI with a stable team-bound designated requirement", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			SIGNING_LOG: fixture.log,
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
	const calls = await readFile(fixture.log, "utf8").catch(() => "");

	expect(result.exitCode).toBe(0);
	expect(output).toContain("Signed and verified");
	expect(calls).toContain("security:import ");
	expect(calls).toContain("codesign:--force --timestamp --identifier ai.signet.cli");
	expect(calls).toContain("--requirements =designated => anchor apple generic");
	expect(calls).toContain("certificate leaf[subject.OU] =");
	expect(calls).toContain("TEAM123456");
	expect(calls).toContain(` ${fixture.binary}`);
});

test("refuses to sign when the imported certificate belongs to another team", async () => {
	const fixture = await signingFixture("OTHERTEAM");
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			SIGNING_LOG: fixture.log,
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
	const calls = await readFile(fixture.log, "utf8").catch(() => "");

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("No Developer ID Application identity found for the configured team");
	expect(calls).not.toContain("codesign:");
});
