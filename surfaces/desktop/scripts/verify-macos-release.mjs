import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const releaseDirectory = resolve(process.argv[2] ?? join(scriptDirectory, "..", "release"));

function fail(message) {
	throw new Error(`[macOS release verification] ${message}`);
}

function attempt(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	if (result.error) fail(`${command} could not be executed: ${result.error.message}`);
	return { status: result.status, output };
}

function failure(command, args, result) {
	return `${command} ${args.join(" ")} failed with exit ${result.status ?? "unknown"}\n${result.output.trim()}`;
}

function run(command, args) {
	const result = attempt(command, args);
	if (result.status !== 0) fail(failure(command, args, result));
	return result.output;
}

function sleep(milliseconds) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const staplerRetryDelay = Number(process.env.SIGNET_STAPLER_RETRY_DELAY_MS ?? 30_000);
const staplerAttempts = 4;

function validateStapledTicket(appPath) {
	const args = ["stapler", "validate", appPath];
	for (let index = 1; ; index++) {
		const result = attempt("xcrun", args);
		if (result.status === 0) return;
		const transient = result.output.includes("NSURLErrorDomain");
		if (!transient || index === staplerAttempts) fail(failure("xcrun", args, result));
		console.warn(
			`stapler validate lost its network connection to Apple (attempt ${index}/${staplerAttempts}); retrying`,
		);
		sleep(staplerRetryDelay * index);
	}
}

function findApp(directory) {
	const entries = readdirSync(directory, { withFileTypes: true });
	for (const entry of entries) {
		const entryPath = join(directory, entry.name);
		if (entry.isDirectory() && entry.name.endsWith(".app")) return entryPath;
		if (entry.isDirectory()) {
			const nested = findApp(entryPath);
			if (nested) return nested;
		}
	}
	return null;
}

if (process.platform !== "darwin") {
	fail(`must run on macOS; current platform is ${process.platform}`);
}

const appPath = findApp(releaseDirectory);
if (!appPath) fail(`no .app bundle found under ${releaseDirectory}`);

console.log(`Verifying signed app bundle: ${appPath}`);
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
const signature = run("codesign", ["--display", "--verbose=4", appPath]);
if (signature.includes("Signature=adhoc")) fail("app has an ad-hoc signature, not a Developer ID signature");
if (!signature.includes("Authority=Developer ID Application:")) {
	fail("app is not signed by a Developer ID Application identity");
}
if (!signature.includes("TeamIdentifier=")) fail("signed app is missing a TeamIdentifier");

validateStapledTicket(appPath);

const quarantineDirectory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "signet-macos-quarantine-"));
const quarantinedAppPath = join(quarantineDirectory, "Signet.app");
try {
	run("ditto", [appPath, quarantinedAppPath]);
	run("xattr", ["-w", "com.apple.quarantine", "0081;00000000;Signet;Signet.app", quarantinedAppPath]);
	const quarantine = run("xattr", ["-p", "com.apple.quarantine", quarantinedAppPath]).trim();
	if (!quarantine) fail("could not confirm com.apple.quarantine on the Gatekeeper test copy");
	run("spctl", ["--assess", "--type", "execute", "--verbose=4", quarantinedAppPath]);
} finally {
	rmSync(quarantineDirectory, { recursive: true, force: true });
}

console.log(
	"macOS release verification passed: Developer ID signature, stapled notarization ticket, and quarantined Gatekeeper assessment are valid.",
);
