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
if [ "$1" = create-keychain ]; then
  printf 'created-keychain:%s\\n' "$4" >> "$SIGNING_LOG"
  : > "$4"
fi
if [ "\${SIGNING_SECURITY_FAILURE:-}" = "$1" ]; then
  printf 'fixture security error\\n' >&2
  exit 1
fi
if [ "$1" = import ]; then
  printf '1 certificate imported.\\n1 identity imported.\\n'
fi
if [ "$1" = "list-keychains" ]; then
  state_file="\${SIGNING_LOG}.keychain-state"
  if [ "$4" = "-s" ]; then
    printf 'restore-args:%s|%s\\n' "$5" "$6" >> "$SIGNING_LOG"
    if [ "\${SIGNING_KEYCHAIN_SET_FAILURE_PARTIAL:-0}" = "1" ] && [ "$5" != "fixture login.keychain" ]; then
      printf 'temporary-list-mutated:%s\\n' "$5" >> "$SIGNING_LOG"
      printf ' "%s"\\n' "$5" > "$state_file"
      exit 1
    fi
    if [ "\${SIGNING_KEYCHAIN_RESTORE_FAILURE:-0}" = "1" ] && [ "$5" = "fixture login.keychain" ] && [ "$6" = "fixture-secondary.keychain" ]; then
      printf 'fixture keychain restore error\\n' >&2
      exit 1
    fi
    case "$5" in
      "$RUNNER_TEMP"/signet-macos-signing.*/signing.keychain-db)
        printf ' "%s"\\n' "$5" > "$state_file"
        ;;
      *)
        if [ -n "$SIGNING_KEYCHAIN_LIST" ]; then
          printf '%s\\n' "$SIGNING_KEYCHAIN_LIST" > "$state_file"
        else
          : > "$state_file"
          shift 4
          for keychain_path in "$@"; do
            printf ' "%s"\\n' "$keychain_path" >> "$state_file"
          done
        fi
        ;;
    esac
  else
    query_count_file="\${SIGNING_LOG}.keychain-query-count"
    query_count=0
    if [ -f "$query_count_file" ]; then
      query_count="$(cat "$query_count_file")"
    fi
    query_count=$((query_count + 1))
    printf '%s\\n' "$query_count" > "$query_count_file"
    if [ "\${SIGNING_KEYCHAIN_VERIFY_READ_FAILURES:-0}" = "1" ] && { [ "$query_count" -eq 2 ] || [ "$query_count" -eq 3 ]; }; then
      exit 1
    fi
    if [ -f "$state_file" ]; then
      cat "$state_file"
    elif [ "\${SIGNING_KEYCHAIN_EMPTY_LIST:-0}" = "1" ]; then
      :
    elif [ "\${SIGNING_KEYCHAIN_EMPTY_ENTRY:-0}" = "1" ]; then
      printf ' ""\\n "fixture-secondary.keychain"\\n'
    elif [ "\${SIGNING_KEYCHAIN_NUL_ENTRY:-0}" = "1" ]; then
      printf ' "fixture\\000.keychain"\\n "fixture-secondary.keychain"\\n'
    elif [ -n "$SIGNING_KEYCHAIN_LIST" ]; then
      printf '%s\\n' "$SIGNING_KEYCHAIN_LIST"
    else
      printf ' "fixture login.keychain"\\n "fixture-secondary.keychain"\\n'
    fi
  fi
fi
if [ "$1" = find-identity ]; then
  case "\${SIGNING_IDENTITY_OUTPUT_MODE:-valid}" in
    missing) printf '0 valid identities found.\\n' ;;
    lowercase) printf '1) 0123456789abcdef0123456789abcdef01234567 "Developer ID Application: Signet AI (TEAM123456)"\\n1 valid identities found.\\n' ;;
    unrelated) printf '1) 1123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Signet AI (TEAM123456)"\\n1 valid identities found.\\n' ;;
    ambiguous) printf '1) 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Signet AI (TEAM123456)"\\n2) 1123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Signet AI (TEAM123456)"\\n2 valid identities found.\\n' ;;
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
	for (const mode of ["missing", "unrelated", "ambiguous", "malformed", "query-error"] as const) {
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

test("runs a same-runner signing diagnostic without changing the default search list", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			RUNNER_TEMP: fixture.runnerTemp,
			SIGNING_LOG: fixture.log,
			SIGNING_DIAGNOSTIC_PROBE: "true",
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
	const calls = await readFile(fixture.log, "utf8");

	expect(result.exitCode).toBe(0);
	expect(output).toContain(
		"Signing diagnostic probe: explicit_keychain_status=0, search_list_status=0, search_list_restore_status=0",
	);
	const forcedSigningCalls = calls.split("\n").filter((line) => line.startsWith("codesign:--force "));
	expect(forcedSigningCalls).toHaveLength(3);
	expect(forcedSigningCalls[0]).toContain("--keychain ");
	expect(forcedSigningCalls[1]).not.toContain("--keychain ");
	expect(calls).toContain("restore-args:fixture login.keychain|fixture-secondary.keychain");
	const temporaryKeychain =
		calls
			.split("\n")
			.find((line) => line.startsWith("created-keychain:"))
			?.slice("created-keychain:".length) ?? "missing-keychain";
	expect(calls).toContain(`security:list-keychains -d user -s ${temporaryKeychain}`);
	expect(calls).toContain(`security:delete-keychain ${temporaryKeychain}`);
});

test("preserves literal backslashes in keychain search-list paths", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const backslash = String.fromCharCode(92);
	const keychainList = `    "fixture${backslash}tail.keychain"  ${String.fromCharCode(10)}"fixture-secondary.keychain"`;
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			RUNNER_TEMP: fixture.runnerTemp,
			SIGNING_LOG: fixture.log,
			SIGNING_KEYCHAIN_LIST: keychainList,
			SIGNING_DIAGNOSTIC_PROBE: "true",
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
	const calls = await readFile(fixture.log, "utf8");

	expect(result.exitCode).toBe(0);
	expect(output).toContain("search_list_restore_status=0");
	expect(calls).toContain(`restore-args:fixture${backslash}tail.keychain|fixture-secondary.keychain`);
});

test("rejects an ambiguous embedded quote in keychain path output before search-list mutation", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const keychainList = ` "fixture"quoted.keychain"${String.fromCharCode(10)} "fixture-secondary.keychain"`;
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			RUNNER_TEMP: fixture.runnerTemp,
			SIGNING_LOG: fixture.log,
			SIGNING_KEYCHAIN_LIST: keychainList,
			SIGNING_DIAGNOSTIC_PROBE: "true",
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
	const calls = await readFile(fixture.log, "utf8");

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("::error::Could not parse original user keychain search list for diagnostic probe");
	expect(calls).not.toContain("security:list-keychains -d user -s");
	expect(calls).not.toContain(` ${fixture.binary}`);
});

test("refuses to continue signing when the diagnostic cannot read the original keychain search list", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			RUNNER_TEMP: fixture.runnerTemp,
			SIGNING_LOG: fixture.log,
			SIGNING_SECURITY_FAILURE: "list-keychains",
			SIGNING_DIAGNOSTIC_PROBE: "true",
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
	const calls = await readFile(fixture.log, "utf8");

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("::error::Could not read original user keychain search list for diagnostic probe");
	expect(calls).not.toContain(` ${fixture.binary}`);
});

test("rejects an empty quoted keychain path before changing the search list", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			RUNNER_TEMP: fixture.runnerTemp,
			SIGNING_LOG: fixture.log,
			SIGNING_KEYCHAIN_EMPTY_ENTRY: "1",
			SIGNING_DIAGNOSTIC_PROBE: "true",
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
	const calls = await readFile(fixture.log, "utf8");

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("::error::Could not parse original user keychain search list for diagnostic probe");
	expect(calls).not.toContain("security:list-keychains -d user -s");
	expect(calls).not.toContain(` ${fixture.binary}`);
});

test("rejects NUL bytes in keychain search-list output before changing the search list", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			RUNNER_TEMP: fixture.runnerTemp,
			SIGNING_LOG: fixture.log,
			SIGNING_KEYCHAIN_NUL_ENTRY: "1",
			SIGNING_DIAGNOSTIC_PROBE: "true",
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
	const calls = await readFile(fixture.log, "utf8");

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("::error::Original user keychain search list contains NUL bytes");
	expect(calls).not.toContain("security:list-keychains -d user -s");
	expect(calls).not.toContain(` ${fixture.binary}`);
});

test("refuses to sign when the diagnostic cannot restore the original keychain search list", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			RUNNER_TEMP: fixture.runnerTemp,
			SIGNING_LOG: fixture.log,
			SIGNING_KEYCHAIN_RESTORE_FAILURE: "1",
			SIGNING_DIAGNOSTIC_PROBE: "true",
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
	const calls = await readFile(fixture.log, "utf8");

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("::error::Could not restore original user keychain search list after diagnostic probe");
	expect(output).toContain("security list-keychains -d user -s fixture\\ login.keychain fixture-secondary.keychain");
	expect(calls).not.toContain(` ${fixture.binary}`);
	expect(
		calls.split("\n").filter((line) => line === "restore-args:fixture login.keychain|fixture-secondary.keychain"),
	).toHaveLength(2);
});

test("removes the temporary keychain when a fresh read confirms it is no longer referenced", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			RUNNER_TEMP: fixture.runnerTemp,
			SIGNING_LOG: fixture.log,
			SIGNING_KEYCHAIN_VERIFY_READ_FAILURES: "1",
			SIGNING_DIAGNOSTIC_PROBE: "true",
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
	const calls = await readFile(fixture.log, "utf8");
	const keychainState = await readFile(`${fixture.log}.keychain-state`, "utf8");
	const temporaryKeychain =
		calls
			.split("\n")
			.find((line) => line.startsWith("created-keychain:"))
			?.slice("created-keychain:".length) ?? "missing-keychain";

	expect(result.exitCode).not.toBe(0);
	expect(keychainState).toBe(' "fixture login.keychain"\n "fixture-secondary.keychain"\n');
	expect(output).toContain("current list does not reference the temporary keychain");
	expect(output).not.toContain("Temporary keychain retained");
	expect(calls).toContain(`security:delete-keychain ${temporaryKeychain}`);
	expect(await Bun.file(temporaryKeychain).exists()).toBe(false);
	expect(await readdir(fixture.runnerTemp)).toHaveLength(0);
});

test("restores the original list and removes the temporary keychain after a partial setter failure", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			RUNNER_TEMP: fixture.runnerTemp,
			SIGNING_LOG: fixture.log,
			SIGNING_KEYCHAIN_SET_FAILURE_PARTIAL: "1",
			SIGNING_DIAGNOSTIC_PROBE: "true",
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
	const calls = await readFile(fixture.log, "utf8");
	const keychainState = await readFile(`${fixture.log}.keychain-state`, "utf8");
	const temporaryKeychain =
		calls
			.split("\n")
			.find((line) => line.startsWith("created-keychain:"))
			?.slice("created-keychain:".length) ?? "missing-keychain";

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("Could not set temporary user keychain search list for diagnostic probe");
	expect(calls).toContain(`temporary-list-mutated:${temporaryKeychain}`);
	expect(keychainState).toBe(' "fixture login.keychain"\n "fixture-secondary.keychain"\n');
	expect(calls).toContain("restore-args:fixture login.keychain|fixture-secondary.keychain");
	expect(calls).toContain(`security:delete-keychain ${temporaryKeychain}`);
	expect(await Bun.file(temporaryKeychain).exists()).toBe(false);
	expect(await readdir(fixture.runnerTemp)).toHaveLength(0);
});

test("preserves and restores an initially empty user keychain search list", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			RUNNER_TEMP: fixture.runnerTemp,
			SIGNING_LOG: fixture.log,
			SIGNING_KEYCHAIN_EMPTY_LIST: "1",
			SIGNING_DIAGNOSTIC_PROBE: "true",
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
	const calls = await readFile(fixture.log, "utf8");
	const keychainState = await readFile(`${fixture.log}.keychain-state`, "utf8");
	const temporaryKeychain =
		calls
			.split("\n")
			.find((line) => line.startsWith("created-keychain:"))
			?.slice("created-keychain:".length) ?? "missing-keychain";

	expect(result.exitCode).toBe(0);
	expect(output).toContain("search_list_restore_status=0");
	expect(keychainState).toBe("");
	expect(calls).toContain("restore-args:|");
	expect(calls).toContain(`security:delete-keychain ${temporaryKeychain}`);
	expect(await Bun.file(temporaryKeychain).exists()).toBe(false);
	expect(await readdir(fixture.runnerTemp)).toHaveLength(0);
});

test("preserves the temporary keychain when search-list mutation and restoration both fail", async () => {
	const fixture = await signingFixture();
	const script = resolve(import.meta.dir, "sign-macos-native.sh");
	const result = Bun.spawnSync(["bash", script, fixture.binary], {
		cwd: resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			RUNNER_TEMP: fixture.runnerTemp,
			SIGNING_LOG: fixture.log,
			SIGNING_KEYCHAIN_SET_FAILURE_PARTIAL: "1",
			SIGNING_KEYCHAIN_RESTORE_FAILURE: "1",
			SIGNING_DIAGNOSTIC_PROBE: "true",
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
	const calls = await readFile(fixture.log, "utf8");
	const keychainState = await readFile(`${fixture.log}.keychain-state`, "utf8");
	const temporaryKeychain =
		calls
			.split("\n")
			.find((line) => line.startsWith("created-keychain:"))
			?.slice("created-keychain:".length) ?? "missing-keychain";

	expect(result.exitCode).not.toBe(0);
	expect(calls).toContain(`temporary-list-mutated:${temporaryKeychain}`);
	expect(keychainState).toBe(` "${temporaryKeychain}"\n`);
	expect(output).toContain("Could not set temporary user keychain search list for diagnostic probe");
	expect(output).toContain(
		`Temporary keychain remains in the user search list and is preserved at ${temporaryKeychain}`,
	);
	expect(calls).not.toContain("security:delete-keychain");
	expect(await Bun.file(temporaryKeychain).exists()).toBe(true);
	const temporaryDirectories = await readdir(fixture.runnerTemp);
	expect(temporaryDirectories).toHaveLength(1);
	expect(await readdir(join(fixture.runnerTemp, temporaryDirectories[0] ?? ""))).toEqual(["signing.keychain-db"]);
});

test("signs only with the Keychain identity whose certificate fingerprint matches", async () => {
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
	expect(calls).toContain("security:set-key-partition-list -S apple-tool:,apple: -s -k ");
	expect(calls).toContain("--sign Developer ID Application: Signet AI (TEAM123456)");
	expect(calls).not.toContain("--sign 0123456789ABCDEF0123456789ABCDEF01234567");
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
