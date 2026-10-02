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
SIGNING_LOG="\${SIGNING_LOG:-\${0%/*}/signing.log}"
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
    if [ "\${SIGNING_KEYCHAIN_SET_FAILURE_NO_MUTATION:-0}" = "1" ] && [ "$5" != "fixture login.keychain" ]; then
      printf 'fixture keychain list setter failed before mutation\\n' >&2
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
        if [ -n "$SIGNING_KEYCHAIN_RESTORED_LIST" ]; then
          printf '%s\\n' "$SIGNING_KEYCHAIN_RESTORED_LIST" > "$state_file"
        elif [ -n "$SIGNING_KEYCHAIN_LIST" ]; then
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
    if [ "\${SIGNING_KEYCHAIN_VERIFY_READ_FAILURES:-0}" = "1" ] && [ "$query_count" -eq 2 ]; then
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
SIGNING_LOG="\${SIGNING_LOG:-\${0%/*}/signing.log}"
printf 'codesign:%s\\n' "$*" >> "$SIGNING_LOG"
case "$*" in
  *--sign*)
    if [ "\${SIGNING_CODESIGN_REQUIRE_SEARCH_LIST:-0}" = "1" ]; then
      state_file="\${SIGNING_LOG}.keychain-state"
      case "$*" in
        *--keychain*)
          printf 'fixture expected keychain through the user search list\\n' >&2
          exit 1
          ;;
        *)
          if ! grep -Fq "$RUNNER_TEMP/" "$state_file"; then
            printf 'fixture temporary keychain is not in the user search list\\n' >&2
            exit 1
          fi
          ;;
      esac
    fi
    ;;
esac
case "$*" in
  *--display*--requirements*) printf 'designated => (anchor apple generic and (identifier "ai.signet.cli") and (certificate leaf[subject.OU] = "${team}"))\\n' ;;
  *--display*) printf 'Identifier=ai.signet.cli\\nTeamIdentifier=${team}\\nAuthority=Developer ID Application: Signet AI (${team})\\n' ;;
esac
if [ "$1" = "--verify" ]; then
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-R" ]; then
      if [ "\${SIGNING_VERIFIER_TEAM_ID:-${team}}" != "$APPLE_TEAM_ID" ]; then
        printf 'fixture designated requirement mismatch\\n' >&2
        exit 1
      fi
      break
    fi
    shift
  done
fi
`,
		{ mode: 0o700 },
	);
	return { binary, log, path: bin, runnerTemp };
}

type SigningFixture = Awaited<ReturnType<typeof signingFixture>>;
type SigningResult = ReturnType<typeof Bun.spawnSync>;

const signingScript = resolve(import.meta.dir, "sign-macos-native.sh");
const signingDirectory = resolve(import.meta.dir, "..");

function runSigning(fixture: SigningFixture, environment: Record<string, string> = {}): SigningResult {
	return Bun.spawnSync(["bash", signingScript, fixture.binary], {
		cwd: signingDirectory,
		env: {
			...process.env,
			PATH: `${fixture.path}${delimiter}${process.env.PATH ?? ""}`,
			MACOS_CERTIFICATE_P12: "cGsi",
			MACOS_CERTIFICATE_PASSWORD: "fixture-password",
			APPLE_TEAM_ID: "TEAM123456",
			...environment,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
}

function signingOutput(result: SigningResult): string {
	return `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
}

test("cleans the temporary keychain directory when password generation fails", async () => {
	const fixture = await signingFixture();
	const result = runSigning(fixture, {
		RUNNER_TEMP: fixture.runnerTemp,
		SIGNING_OPENSSL_FAILURE: "1",
	});

	expect(result.exitCode).not.toBe(0);
	expect(await readdir(fixture.runnerTemp)).toEqual([]);
});

test("uses OpenSSL's legacy provider when the PKCS#12 reader supports it", async () => {
	const fixture = await signingFixture();
	const result = runSigning(fixture, {
		SIGNING_OPENSSL_REQUIRE_LEGACY: "1",
	});
	const output = signingOutput(result);

	expect(result.exitCode).toBe(0);
	expect(output).toContain("Signed and verified");
});

test("does not request OpenSSL's legacy provider when the PKCS#12 reader lacks it", async () => {
	const fixture = await signingFixture();
	const result = runSigning(fixture, {
		SIGNING_OPENSSL_LEGACY_SUPPORTED: "0",
	});
	const output = signingOutput(result);

	expect(result.exitCode).toBe(0);
	expect(output).toContain("Signed and verified");
});

test("accepts only a well-formed Keychain identity row and keeps lookup output private", async () => {
	for (const mode of ["missing", "unrelated", "ambiguous", "malformed", "query-error"] as const) {
		const fixture = await signingFixture();
		const result = runSigning(fixture, {
			SIGNING_LOG: fixture.log,
			SIGNING_IDENTITY_OUTPUT_MODE: mode,
		});
		const output = signingOutput(result);
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
	const result = runSigning(fixture, {
		RUNNER_TEMP: fixture.runnerTemp,
		SIGNING_LOG: fixture.log,
		SIGNING_IDENTITY_OUTPUT_MODE: "lowercase",
	});
	const output = signingOutput(result);

	expect(output).toContain("Signed and verified");
	expect(result.exitCode).toBe(0);
});

test("accepts a semantically restored search list with different formatting", async () => {
	const fixture = await signingFixture();
	const originalList = '    "fixture login.keychain"  \n	 "fixture-secondary.keychain"	';
	const restoredList = '"fixture login.keychain"\n  "fixture-secondary.keychain"';
	const result = runSigning(fixture, {
		RUNNER_TEMP: fixture.runnerTemp,
		SIGNING_LOG: fixture.log,
		SIGNING_KEYCHAIN_LIST: originalList,
		SIGNING_KEYCHAIN_RESTORED_LIST: restoredList,
	});
	const output = signingOutput(result);
	const keychainState = await readFile(`${fixture.log}.keychain-state`, "utf8");

	expect(result.exitCode).toBe(0);
	expect(output).toContain("Signed and verified");
	expect(keychainState).toBe(`${restoredList}\n`);
});

test("signs through the temporary user search list without an explicit keychain selector", async () => {
	const fixture = await signingFixture();
	const result = runSigning(fixture, {
		RUNNER_TEMP: fixture.runnerTemp,
		SIGNING_LOG: fixture.log,
		SIGNING_CODESIGN_REQUIRE_SEARCH_LIST: "1",
	});
	const output = signingOutput(result);
	const calls = await readFile(fixture.log, "utf8");
	const keychainState = await readFile(`${fixture.log}.keychain-state`, "utf8");
	const temporaryKeychain =
		calls
			.split("\n")
			.find((line) => line.startsWith("created-keychain:"))
			?.slice("created-keychain:".length) ?? "missing-keychain";
	const signingCalls = calls
		.split("\n")
		.filter((line) => line.startsWith("codesign:--force") && line.includes(" --sign "));

	expect(result.exitCode).toBe(0);
	expect(output).toContain("Signed and verified");
	expect(calls).toContain(`security:list-keychains -d user -s ${temporaryKeychain}`);
	expect(calls).toContain("restore-args:fixture login.keychain|fixture-secondary.keychain");
	expect(signingCalls.some((line) => !line.includes("--keychain "))).toBe(true);
	expect(keychainState).toBe(' "fixture login.keychain"\n "fixture-secondary.keychain"\n');
});

afterAll(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("preserves literal backslashes in keychain search-list paths", async () => {
	const fixture = await signingFixture();
	const backslash = String.fromCharCode(92);
	const keychainList = `    "fixture${backslash}tail.keychain"  ${String.fromCharCode(10)}"fixture-secondary.keychain"`;
	const result = runSigning(fixture, {
		RUNNER_TEMP: fixture.runnerTemp,
		SIGNING_LOG: fixture.log,
		SIGNING_KEYCHAIN_LIST: keychainList,
	});
	const output = signingOutput(result);
	const calls = await readFile(fixture.log, "utf8");

	expect(result.exitCode).toBe(0);
	expect(output).toContain("Signed and verified");
	expect(calls).toContain(`restore-args:fixture${backslash}tail.keychain|fixture-secondary.keychain`);
});

test("rejects an ambiguous embedded quote in keychain path output before search-list mutation", async () => {
	const fixture = await signingFixture();
	const keychainList = ` "fixture"quoted.keychain"${String.fromCharCode(10)} "fixture-secondary.keychain"`;
	const result = runSigning(fixture, {
		RUNNER_TEMP: fixture.runnerTemp,
		SIGNING_LOG: fixture.log,
		SIGNING_KEYCHAIN_LIST: keychainList,
	});
	const output = signingOutput(result);
	const calls = await readFile(fixture.log, "utf8");

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("::error::Could not parse original user keychain search list");
	expect(calls).not.toContain("security:list-keychains -d user -s");
	expect(calls).not.toContain(` ${fixture.binary}`);
});

test("refuses production signing when it cannot read the list needed for safe restoration", async () => {
	const fixture = await signingFixture();
	const result = runSigning(fixture, {
		RUNNER_TEMP: fixture.runnerTemp,
		SIGNING_LOG: fixture.log,
		SIGNING_SECURITY_FAILURE: "list-keychains",
	});
	const output = signingOutput(result);
	const calls = await readFile(fixture.log, "utf8");

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("::error::Could not read original user keychain search list");
	expect(calls).not.toContain(` ${fixture.binary}`);
});

test("rejects an empty quoted keychain path before changing the search list", async () => {
	const fixture = await signingFixture();
	const result = runSigning(fixture, {
		RUNNER_TEMP: fixture.runnerTemp,
		SIGNING_LOG: fixture.log,
		SIGNING_KEYCHAIN_EMPTY_ENTRY: "1",
	});
	const output = signingOutput(result);
	const calls = await readFile(fixture.log, "utf8");

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("::error::Could not parse original user keychain search list");
	expect(calls).not.toContain("security:list-keychains -d user -s");
	expect(calls).not.toContain(` ${fixture.binary}`);
});

test("rejects NUL bytes in keychain search-list output before changing the search list", async () => {
	const fixture = await signingFixture();
	const result = runSigning(fixture, {
		RUNNER_TEMP: fixture.runnerTemp,
		SIGNING_LOG: fixture.log,
		SIGNING_KEYCHAIN_NUL_ENTRY: "1",
	});
	const output = signingOutput(result);
	const calls = await readFile(fixture.log, "utf8");

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("::error::Original user keychain search list contains NUL bytes");
	expect(calls).not.toContain("security:list-keychains -d user -s");
	expect(calls).not.toContain(` ${fixture.binary}`);
});

test("fails signing and preserves recovery data when the original search list cannot be restored", async () => {
	const fixture = await signingFixture();
	const result = runSigning(fixture, {
		RUNNER_TEMP: fixture.runnerTemp,
		SIGNING_LOG: fixture.log,
		SIGNING_KEYCHAIN_RESTORE_FAILURE: "1",
	});
	const output = signingOutput(result);
	const calls = await readFile(fixture.log, "utf8");

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("::error::Could not restore original user keychain search list after signing");
	expect(output).toContain("security list-keychains -d user -s fixture\\ login.keychain fixture-secondary.keychain");
	expect(calls).toContain(` ${fixture.binary}`);
	expect(output).not.toContain("Signed and verified");
	expect(calls).not.toContain("security:delete-keychain");
	expect(
		calls.split("\n").filter((line) => line === "restore-args:fixture login.keychain|fixture-secondary.keychain"),
	).toHaveLength(2);
});

test("restores the original list after a transient search-list read failure", async () => {
	const fixture = await signingFixture();
	const result = runSigning(fixture, {
		RUNNER_TEMP: fixture.runnerTemp,
		SIGNING_LOG: fixture.log,
		SIGNING_KEYCHAIN_VERIFY_READ_FAILURES: "1",
	});
	const output = signingOutput(result);
	const calls = await readFile(fixture.log, "utf8");
	const keychainState = await readFile(`${fixture.log}.keychain-state`, "utf8");
	const temporaryKeychain =
		calls
			.split("\n")
			.find((line) => line.startsWith("created-keychain:"))
			?.slice("created-keychain:".length) ?? "missing-keychain";

	expect(result.exitCode).not.toBe(0);
	expect(keychainState).toBe(' "fixture login.keychain"\n "fixture-secondary.keychain"\n');
	expect(output).toContain("Could not restore original user keychain search list after signing");
	expect(output).not.toContain("recovery files are preserved");
	expect(calls).toContain(`security:delete-keychain ${temporaryKeychain}`);
	expect(await Bun.file(temporaryKeychain).exists()).toBe(false);
	expect(await readdir(fixture.runnerTemp)).toHaveLength(0);
});

test("cleans up normally when the temporary-list setter fails without mutating state", async () => {
	const fixture = await signingFixture();
	const result = runSigning(fixture, {
		RUNNER_TEMP: fixture.runnerTemp,
		SIGNING_LOG: fixture.log,
		SIGNING_KEYCHAIN_SET_FAILURE_NO_MUTATION: "1",
	});
	const output = signingOutput(result);
	const calls = await readFile(fixture.log, "utf8");

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("Could not set temporary user keychain search list for signing");
	expect(output).not.toContain("Could not restore the original user keychain search list");
	expect(output).not.toContain("recovery files are preserved");
	expect(calls).not.toContain(`codesign:--force`);
	expect(calls).toContain("security:delete-keychain");
	expect(await readdir(fixture.runnerTemp)).toHaveLength(0);
});

test("preserves recovery data when the search list diverges without referencing the temporary keychain", async () => {
	const fixture = await signingFixture();
	const restoredList = '"fixture login.keychain"';
	const result = runSigning(fixture, {
		RUNNER_TEMP: fixture.runnerTemp,
		SIGNING_LOG: fixture.log,
		SIGNING_KEYCHAIN_RESTORED_LIST: restoredList,
	});
	const output = signingOutput(result);
	const calls = await readFile(fixture.log, "utf8");
	const temporaryKeychain =
		calls
			.split("\n")
			.find((line) => line.startsWith("created-keychain:"))
			?.slice("created-keychain:".length) ?? "missing-keychain";
	const recoveryDirectory = temporaryKeychain.replace(/signing\.keychain-db$/, "");

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("state=different");
	expect(output).toContain("recovery files are preserved");
	expect(await Bun.file(temporaryKeychain).exists()).toBe(true);
	expect(await Bun.file(`${recoveryDirectory}original-keychain-search-list.txt`).exists()).toBe(true);
	expect(await readdir(fixture.runnerTemp)).toHaveLength(1);
});

test("restores the original list and removes the temporary keychain after a partial setter failure", async () => {
	const fixture = await signingFixture();
	const result = runSigning(fixture, {
		RUNNER_TEMP: fixture.runnerTemp,
		SIGNING_LOG: fixture.log,
		SIGNING_KEYCHAIN_SET_FAILURE_PARTIAL: "1",
	});
	const output = signingOutput(result);
	const calls = await readFile(fixture.log, "utf8");
	const keychainState = await readFile(`${fixture.log}.keychain-state`, "utf8");
	const temporaryKeychain =
		calls
			.split("\n")
			.find((line) => line.startsWith("created-keychain:"))
			?.slice("created-keychain:".length) ?? "missing-keychain";

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("Could not set temporary user keychain search list for signing");
	expect(calls).toContain(`temporary-list-mutated:${temporaryKeychain}`);
	expect(keychainState).toBe(' "fixture login.keychain"\n "fixture-secondary.keychain"\n');
	expect(calls).toContain("restore-args:fixture login.keychain|fixture-secondary.keychain");
	expect(calls).toContain(`security:delete-keychain ${temporaryKeychain}`);
	expect(await Bun.file(temporaryKeychain).exists()).toBe(false);
	expect(await readdir(fixture.runnerTemp)).toHaveLength(0);
});

test("preserves and restores an initially empty user keychain search list", async () => {
	const fixture = await signingFixture();
	const result = runSigning(fixture, {
		RUNNER_TEMP: fixture.runnerTemp,
		SIGNING_LOG: fixture.log,
		SIGNING_KEYCHAIN_EMPTY_LIST: "1",
	});
	const output = signingOutput(result);
	const calls = await readFile(fixture.log, "utf8");
	const keychainState = await readFile(`${fixture.log}.keychain-state`, "utf8");
	const temporaryKeychain =
		calls
			.split("\n")
			.find((line) => line.startsWith("created-keychain:"))
			?.slice("created-keychain:".length) ?? "missing-keychain";

	expect(result.exitCode).toBe(0);
	expect(output).toContain("Signed and verified");
	expect(keychainState).toBe("");
	expect(calls).toContain("restore-args:|");
	expect(calls).toContain(`security:delete-keychain ${temporaryKeychain}`);
	expect(await Bun.file(temporaryKeychain).exists()).toBe(false);
	expect(await readdir(fixture.runnerTemp)).toHaveLength(0);
});

test("preserves the temporary keychain when search-list mutation and restoration both fail", async () => {
	const fixture = await signingFixture();
	const result = runSigning(fixture, {
		RUNNER_TEMP: fixture.runnerTemp,
		SIGNING_LOG: fixture.log,
		SIGNING_KEYCHAIN_SET_FAILURE_PARTIAL: "1",
		SIGNING_KEYCHAIN_RESTORE_FAILURE: "1",
	});
	const output = signingOutput(result);
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
	expect(output).toContain("Could not set temporary user keychain search list for signing");
	expect(output).toContain("state=referenced. The temporary keychain and recovery files are preserved");
	expect(calls).not.toContain("security:delete-keychain");
	expect(await Bun.file(temporaryKeychain).exists()).toBe(true);
	const temporaryDirectories = await readdir(fixture.runnerTemp);
	expect(temporaryDirectories).toHaveLength(1);
	expect((await readdir(join(fixture.runnerTemp, temporaryDirectories[0] ?? ""))).sort()).toEqual(
		["current-keychain-search-list.txt", "original-keychain-search-list.txt", "signing.keychain-db"].sort(),
	);
});

test("signs only with the Keychain identity whose certificate fingerprint matches", async () => {
	const fixture = await signingFixture();
	const result = runSigning(fixture, {
		RUNNER_TEMP: fixture.runnerTemp,
		SIGNING_LOG: fixture.log,
	});
	const output = signingOutput(result);
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
	const result = runSigning(fixture, {
		SIGNING_LOG: fixture.log,
	});
	const output = signingOutput(result);
	const calls = await readFile(fixture.log, "utf8").catch(() => "");

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("Imported certificate is not a Developer ID Application identity for the configured team");
	expect(calls).not.toContain("codesign:");
});

test("rejects a signed binary when codesign verification sees a different team", async () => {
	const fixture = await signingFixture();
	const result = runSigning(fixture, {
		SIGNING_LOG: fixture.log,
		SIGNING_VERIFIER_TEAM_ID: "OTHERTEAM",
	});
	const output = signingOutput(result);
	const calls = await readFile(fixture.log, "utf8");

	expect(result.exitCode).not.toBe(0);
	expect(calls).toContain("codesign:--verify --strict --verbose=2 -R =anchor apple generic");
	expect(calls).toContain('certificate leaf[subject.OU] = "TEAM123456"');
	expect(output).not.toContain("Signed and verified");
});

test("refuses a certificate whose team differs", async () => {
	const fixture = await signingFixture("OTHERTEAM");
	const result = runSigning(fixture, {
		RUNNER_TEMP: fixture.runnerTemp,
		SIGNING_LOG: fixture.log,
	});
	const output = signingOutput(result);
	const calls = await readFile(fixture.log, "utf8").catch(() => "");

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("Imported certificate is not a Developer ID Application identity for the configured team");
	expect(calls).not.toContain("codesign:");
});

test("refuses a certificate with a different Developer ID certificate type", async () => {
	const fixture = await signingFixture("TEAM123456", "Developer ID Installer");
	const result = runSigning(fixture, {
		RUNNER_TEMP: fixture.runnerTemp,
		SIGNING_LOG: fixture.log,
	});
	const output = signingOutput(result);
	const calls = await readFile(fixture.log, "utf8").catch(() => "");

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("Imported certificate is not a Developer ID Application identity for the configured team");
	expect(calls).not.toContain("codesign:");
});

test("identifies the keychain stage when macOS rejects a security operation", async () => {
	const fixture = await signingFixture();
	const result = runSigning(fixture, {
		SIGNING_LOG: fixture.log,
		SIGNING_SECURITY_FAILURE: "set-key-partition-list",
	});
	const output = signingOutput(result);

	expect(result.exitCode).not.toBe(0);
	expect(output).toContain("Configuring code-signing key access");
	expect(output).not.toContain("Signed and verified");
});
