import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const directories: string[] = [];

async function signingFixture(team = "TEAM123456"): Promise<{
	readonly binary: string;
	readonly log: string;
	readonly path: string;
	readonly runnerTemp: string;
}> {
	const directory = await mkdtemp(join(tmpdir(), "signet-macos-signing-"));
	directories.push(directory);
	const bin = join(directory, "bin");
	const runnerTemp = join(directory, "runner-temp");
	await mkdir(bin);
	await mkdir(runnerTemp);
	const log = join(directory, "calls.log");
	const binary = join(directory, "signet-darwin-arm64");
	await writeFile(binary, "Mach-O fixture");
	await writeFile(
		join(bin, "openssl"),
		`#!/bin/sh
if [ "\${SIGNING_OPENSSL_FAILURE:-0}" = "1" ]; then exit 1; fi
printf 'fixture-keychain-password'
`,
		{ mode: 0o700 },
	);
	await writeFile(
		join(bin, "security"),
		`#!/bin/sh
printf 'security:%s\\n' "$*" >> "$SIGNING_LOG"
if [ "\${SIGNING_SECURITY_FAILURE:-}" = "$1" ]; then
  printf 'fixture security error\\n' >&2
  exit 1
fi
if [ "$1" = import ]; then
  printf '1 certificate imported.\\n1 identity imported.\\n'
fi
if [ "$1" = find-identity ] && [ "\${SIGNING_IDENTITY_LOOKUP_FAILURE:-0}" = "1" ]; then
  printf 'security: SecPolicySearchCopyNext: The specified item could not be found in the keychain.\\n' >&2
  exit 1
fi
if [ "$1" = find-identity ] && [ "$2" = "-p" ]; then
  echo 'security: SecPolicySearchCopyNext: The specified item could not be found in the keychain.' >&2
  exit 1
fi
if [ "$1" = find-identity ]; then
  if [ "$SIGNING_AMBIGUOUS_IDENTITY" = "1" ]; then
    printf '  1) BAD "Developer ID Application: Other (${team}) Extra"
  2) ABCDEF "Developer ID Application: Signet AI (${team})"
  2 identities found
'
    exit 0
  fi
  printf '  1) ABCDEF "Developer ID Application: Signet AI (${team})"\n  1 identities found\n'
fi
`,
		{ mode: 0o700 },
	);
	await writeFile(
		join(bin, "codesign"),
		`#!/bin/sh
printf 'codesign:%s\\n' "$*" >> "$SIGNING_LOG"
case "$*" in
  *--display*--requirements*) printf 'designated => (anchor apple generic and (identifier "ai.signet.cli") and (certificate leaf[subject.OU] = "${team}"))\\n' ;;
  *--display*) printf 'Identifier=ai.signet.cli\\nTeamIdentifier=${team}\\nAuthority=Developer ID Application: Signet AI (${team})\\n' ;;
esac
case "$*" in
  *-R*)
    if [ "\${SIGNING_REQUIREMENT_FAILURE:-0}" = "1" ]; then exit 1; fi
    ;;
esac
`,
		{ mode: 0o700 },
	);
	return { binary, log, path: bin, runnerTemp };
}

test("cleans the temporary keychain directory when password generation fails", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			RUNNER_TEMP: fixture.runnerTemp,
			SIGNING_OPENSSL_FAILURE: "1",
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});

	expect(result.exitCode).not.toBe(0);
	expect(await readdir(fixture.runnerTemp)).toEqual([]);
});

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
			RUNNER_TEMP: fixture.runnerTemp,
			SIGNING_LOG: fixture.log,
			SIGNING_AMBIGUOUS_IDENTITY: "1",
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
	expect(calls).toContain("security:find-identity ");
	expect(calls).not.toContain("security:find-identity -p ");
	const keychainLine = calls
		.split(String.fromCharCode(10))
		.find((call) => call.startsWith("security:create-keychain -p "));
	const keychain = keychainLine?.split(" ").at(-1);
	expect(keychain).toBeDefined();
	expect(calls).toContain(`security:find-identity ${keychain}`);
	expect(calls).toContain("codesign:--force --timestamp --identifier ai.signet.cli");
	expect(calls).toContain("--sign Developer ID Application: Signet AI (TEAM123456)");
	expect(calls).toContain("--requirements =designated => anchor apple generic");
	expect(calls).toContain("-R =anchor apple generic and identifier");
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

test("refuses to report success when the signed binary fails the team requirement", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			SIGNING_LOG: fixture.log,
			SIGNING_REQUIREMENT_FAILURE: "1",
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});

	expect(result.exitCode).not.toBe(0);
});

test("reports certificate import results and identity lookup errors", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			RUNNER_TEMP: fixture.runnerTemp,
			SIGNING_LOG: fixture.log,
			SIGNING_IDENTITY_LOOKUP_FAILURE: "1",
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("1 certificate imported.");
	expect(output).toContain("1 identity imported.");
	expect(output).toContain("The specified item could not be found in the keychain.");
	expect(output).not.toContain("Signed and verified");
});

test("identifies the keychain stage when macOS rejects a security operation", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			SIGNING_LOG: fixture.log,
			SIGNING_SECURITY_FAILURE: "set-key-partition-list",
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("Configuring code-signing key access");
	expect(output).not.toContain("Signed and verified");
});
