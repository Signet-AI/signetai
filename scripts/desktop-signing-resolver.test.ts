import { test, expect } from "bun:test";

const workflowPath = ".github/workflows/desktop-build.yml";
const signingSecrets = [
	"APPLE_CERTIFICATE",
	"APPLE_CERTIFICATE_PASSWORD",
	"APPLE_SIGNING_IDENTITY",
	"APPLE_ID",
	"APPLE_APP_SPECIFIC_PASSWORD",
	"APPLE_TEAM_ID",
	"APPLE_API_KEY",
	"APPLE_API_KEY_ID",
	"APPLE_API_ISSUER",
	"APPLE_KEYCHAIN",
	"APPLE_KEYCHAIN_PROFILE",
	"WINDOWS_CERTIFICATE",
	"WINDOWS_CERTIFICATE_PASSWORD",
] as const;

function environment(mode: string, outputPath: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) result[key] = value;
	}
	for (const key of signingSecrets) result[key] = "";
	result.SIGNING_MODE_INPUT = mode;
	result.RUNNER = "macos-14";
	result.GITHUB_OUTPUT = outputPath;
	result.GITHUB_REF = "refs/tags/v0.199.12";
	return result;
}

function resolverScript(workflow: string): string {
	const stepStart = workflow.indexOf("      - name: Resolve signing mode");
	const runStart = workflow.indexOf("        run: |\n", stepStart);
	const runEnd = workflow.indexOf("\n      - name: Configure Electron signing", runStart);
	expect(stepStart).toBeGreaterThanOrEqual(0);
	expect(runStart).toBeGreaterThan(stepStart);
	expect(runEnd).toBeGreaterThan(runStart);
	const body = workflow.slice(runStart + "        run: |\n".length, runEnd);
	return body
		.split("\n")
		.map((line) => (line.length === 0 ? line : line.slice(10)))
		.join("\n")
		.replaceAll("${{ matrix.runner }}", "${RUNNER}");
}

function runResolver(mode: string, script: string): { exitCode: number; output: string } {
	const outputPath = `/tmp/signet-desktop-signing-${process.pid}-${Date.now()}`;
	const result = Bun.spawnSync({
		cmd: ["bash", "-c", script],
		env: environment(mode, outputPath),
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
	try {
		Bun.file(outputPath).delete();
	} catch {
		// The resolver may exit before creating GITHUB_OUTPUT.
	}
	return { exitCode: result.exitCode, output };
}

test("macOS tag auto signing falls back to self-signed when secrets are absent", async () => {
	const script = resolverScript(await Bun.file(workflowPath).text());
	const result = runResolver("auto", script);
	expect(result.exitCode).toBe(0);
	expect(result.output).toContain("Desktop signing mode: self-signed");
	expect(result.output).toContain("::warning::Official signing secrets missing; using self-signed mode:");
});

test("explicit macOS official signing still fails when secrets are absent", async () => {
	const script = resolverScript(await Bun.file(workflowPath).text());
	const result = runResolver("official", script);
	expect(result.exitCode).not.toBe(0);
	expect(result.output).toContain("signing_mode=official but required signing/notarization secrets are missing");
});
