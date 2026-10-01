import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

const directories: string[] = [];

async function signingFixture(
	team = "TEAM123456",
	certificateType = "Developer ID Application",
): Promise<{
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
case "$1" in
  rand) printf 'fixture-keychain-password' ;;
  pkcs12) printf 'fixture-certificate\\n' ;;
  x509)
    cat >/dev/null
    case "$*" in
      *-subject*) printf '%s\\n' 'subject=CN=${certificateType}: Signet AI (${team}),OU=${team},O=Signet AI,C=US' ;;
      *) printf '%s\\n' 'SHA1 Fingerprint=01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67' ;;
    esac
    ;;
esac
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
if [ "$1" = find-identity ] && [ "\${SIGNING_IDENTITY_LOOKUP_FAILURE:-0}" = "unexpected" ]; then
  printf 'security: user interaction is not allowed.\\n' >&2
  exit 1
fi
if [ "$1" = find-identity ] && [ "$2" = "-p" ]; then
  echo 'security: SecPolicySearchCopyNext: The specified item could not be found in the keychain.' >&2
  exit 1
fi
if [ "$1" = find-identity ]; then
  if [ "$SIGNING_AMBIGUOUS_IDENTITY" = "1" ]; then
    printf '  1) BAD "Developer ID Application: Other(${team})"
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
    if [ "\${SIGNING_REQUIREMENT_FAILURE:-0}" = "1" ] || [ "${team}" != "$APPLE_TEAM_ID" ]; then
      printf 'fixture designated requirement mismatch\\n' >&2
      exit 1
    fi
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

afterAll(async () => {
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
	if (keychain === undefined) throw new Error("Signing did not create a temporary keychain");
	expect(dirname(dirname(keychain))).toBe(fixture.runnerTemp);
	expect(basename(dirname(keychain))).toMatch(/^signet-macos-signing\.[A-Za-z0-9]+$/);
	expect(basename(keychain)).toBe("signing.keychain-db");
	expect(calls).toContain(`security:find-identity ${keychain}`);
	const signingCalls = calls.split(String.fromCharCode(10)).filter((call) => call.startsWith("codesign:--force"));
	expect(signingCalls).toHaveLength(1);
	expect(signingCalls[0]).toContain(
		`--keychain ${keychain} --sign Developer ID Application: Signet AI (TEAM123456) ${fixture.binary}`,
	);
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

test("signs by the imported certificate fingerprint when identity enumeration fails", async () => {
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
	const calls = await readFile(fixture.log, "utf8").catch(() => "");

	expect(result.exitCode).toBe(0);
	expect(output).toContain("1 certificate imported.");
	expect(output).toContain("1 identity imported.");
	expect(output).toContain("The specified item could not be found in the keychain.");
	expect(output).toContain("Signing with the imported certificate SHA-1 fingerprint");
	expect(calls).toContain("--sign 0123456789ABCDEF0123456789ABCDEF01234567");
	expect(calls).toContain("-R =anchor apple generic and identifier");
	expect(calls).toContain("certificate leaf[subject.OU] =");
	expect(calls).toContain("TEAM123456");
});

test("refuses the fingerprint fallback after an unexpected identity lookup failure", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			RUNNER_TEMP: fixture.runnerTemp,
			SIGNING_LOG: fixture.log,
			SIGNING_IDENTITY_LOOKUP_FAILURE: "unexpected",
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
	expect(output).toContain("Unexpected security find-identity failure");
	expect(output).not.toContain("Signing with the imported certificate SHA-1 fingerprint");
	expect(calls).not.toContain("codesign:");
});

test("refuses a certificate-fingerprint fallback when its team differs", async () => {
	const fixture = await signingFixture("OTHERTEAM");
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
	const calls = await readFile(fixture.log, "utf8").catch(() => "");

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("Imported certificate is not a Developer ID Application identity for the configured team");
	expect(calls).not.toContain("codesign:");
});

test("refuses a certificate-fingerprint fallback for a different Developer ID certificate type", async () => {
	const fixture = await signingFixture("TEAM123456", "Developer ID Installer");
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
	const calls = await readFile(fixture.log, "utf8").catch(() => "");

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("Imported certificate is not a Developer ID Application identity for the configured team");
	expect(calls).not.toContain("codesign:");
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
