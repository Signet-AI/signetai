import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const releaseDirectory = resolve(process.argv[2] ?? join(scriptDirectory, "..", "release"));

function fail(message) {
	throw new Error(`[macOS release verification] ${message}`);
}

function run(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	if (result.error) fail(`${command} could not be executed: ${result.error.message}`);
	if (result.status !== 0) {
		fail(`${command} ${args.join(" ")} failed with exit ${result.status ?? "unknown"}\n${output.trim()}`);
	}
	return output;
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

run("xcrun", ["stapler", "validate", appPath]);

const quarantineDirectory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "signet-macos-quarantine-"));
const quarantinedAppPath = join(quarantineDirectory, "Signet.app");
try {
	cpSync(appPath, quarantinedAppPath, { recursive: true });
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
