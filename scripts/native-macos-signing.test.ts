import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

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
  pkcs12)
    if [ "\${2:-}" = "-help" ]; then
      if [ "\${SIGNING_OPENSSL_LEGACY_SUPPORTED:-1}" = "1" ]; then
        printf '%s\\n' 'Usage: pkcs12 [options] -legacy enables legacy provider'
      else
        printf '%s\\n' 'Usage: pkcs12 [options]'
      fi
      exit 0
    fi
    case " $* " in
      *" -legacy "*)
        if [ "\${SIGNING_OPENSSL_LEGACY_SUPPORTED:-1}" != "1" ]; then
          printf 'legacy provider is unavailable in this fixture\\n' >&2
          exit 1
        fi
        ;;
      *)
        if [ "\${SIGNING_OPENSSL_REQUIRE_LEGACY:-0}" = "1" ]; then
          printf 'legacy provider required for fixture\\n' >&2
          exit 1
        fi
        ;;
    esac
    printf 'fixture-certificate\\n'
    ;;
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
if [ "$1" = find-identity ]; then
  case "\${SIGNING_IDENTITY_OUTPUT_MODE:-valid}" in
    missing) printf '0 valid identities found.\\n' ;;
    lowercase) printf '1) 0123456789abcdef0123456789abcdef01234567 "Developer ID Application: Signet AI (TEAM123456)"\\n1 valid identities found.\\n' ;;
    unrelated) printf 'Warning: fingerprint 0123456789ABCDEF0123456789ABCDEF01234567 was not listed\\n0 valid identities found.\\n' ;;
    malformed) printf '1. 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Signet AI (TEAM123456)"\\n1 valid identities found.\\n' ;;
    query-error)
      printf 'Lookup failed for fingerprint 0123456789ABCDEF0123456789ABCDEF01234567\\n' >&2
      exit 1
      ;;
    *) printf '1) 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Signet AI (TEAM123456)"\\n1 valid identities found.\\n' ;;
  esac
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

test("uses OpenSSL's legacy provider when the PKCS#12 reader supports it", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			SIGNING_OPENSSL_REQUIRE_LEGACY: "1",
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;

	expect(result.exitCode).toBe(0);
	expect(output).toContain("Signed and verified");
});

test("does not request OpenSSL's legacy provider when the PKCS#12 reader lacks it", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			SIGNING_OPENSSL_LEGACY_SUPPORTED: "0",
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;

	expect(result.exitCode).toBe(0);
	expect(output).toContain("Signed and verified");
});

test("accepts only a well-formed Keychain identity row and keeps lookup output private", async () => {
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	for (const mode of ["missing", "unrelated", "malformed", "query-error"] as const) {
		const fixture = await signingFixture();
		const result = Bun.spawnSync(["bash", script, fixture.binary], {
			cwd: resolve(import.meta.dir, ".."),
			env: {
				...process.env,
				PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
				SIGNING_LOG: fixture.log,
				SIGNING_IDENTITY_OUTPUT_MODE: mode,
				MACOS_CERTIFICATE_P12: "cGsi",
				MACOS_CERTIFICATE_PASSWORD: "fixture-password",
				APPLE_TEAM_ID: "TEAM123456",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
		const calls = await readFile(fixture.log, "utf8").catch(() => "");
		const queryStatus = mode === "query-error" ? 1 : 0;

		expect(result.exitCode).not.toBe(0);
		expect(output).toContain(`query_status=${queryStatus}, expected_identity_listed=no`);
		expect(output).not.toContain("Developer ID Application");
		expect(output).not.toContain("0123456789ABCDEF0123456789ABCDEF01234567");
		expect(calls).not.toContain("codesign:");
	}
});

test("matches a lowercase Keychain fingerprint case-insensitively", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			RUNNER_TEMP: fixture.runnerTemp,
			SIGNING_LOG: fixture.log,
			SIGNING_IDENTITY_OUTPUT_MODE: "lowercase",
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;

	expect(output).toContain("Signed and verified");
	expect(result.exitCode).toBe(0);
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
	expect(calls).toContain("--sign 0123456789ABCDEF0123456789ABCDEF01234567");
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
	expect(output).toContain("Imported certificate is not a Developer ID Application identity for the configured team");
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

test("refuses a certificate whose team differs", async () => {
	const fixture = await signingFixture("OTHERTEAM");
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			RUNNER_TEMP: fixture.runnerTemp,
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
	expect(output).toContain("Imported certificate is not a Developer ID Application identity for the configured team");
	expect(calls).not.toContain("codesign:");
});

test("refuses a certificate with a different Developer ID certificate type", async () => {
	const fixture = await signingFixture("TEAM123456", "Developer ID Installer");
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			RUNNER_TEMP: fixture.runnerTemp,
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
