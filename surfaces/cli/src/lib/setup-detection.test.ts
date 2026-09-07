import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectExistingSetup, type SetupDetection } from "./setup-detection.js";

const TMP = join(tmpdir(), `signet-setup-detection-test-${Date.now()}`);
const ENVIRONMENT_KEYS = [
	"HOME",
	"USERPROFILE",
	"HERMES_HOME",
	"HERMES_REPO",
	"KIMI_CODE_HOME",
	"KIMI_SHARE_DIR",
	"PATH",
	"PI_CODING_AGENT_DIR",
	"XDG_CONFIG_HOME",
] as const;
const ORIGINAL_ENVIRONMENT = new Map<string, string | undefined>(
	ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
);
type Harness = keyof SetupDetection["harnesses"];

afterEach(() => {
	for (const key of ENVIRONMENT_KEYS) {
		const value = ORIGINAL_ENVIRONMENT.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
	mkdirSync(TMP, { recursive: true });
	process.env.HOME = TMP;
	process.env.PATH = join(TMP, "bin");
	for (const key of ENVIRONMENT_KEYS) {
		if (key !== "HOME" && key !== "PATH") delete process.env[key];
	}
});

function expectDetected(harness: Harness): void {
	expect(detectExistingSetup(TMP).harnesses[harness]).toBe(true);
}

describe("detectExistingSetup", () => {
	test("detects identity files without requiring a harness", () => {
		writeFileSync(join(TMP, "AGENTS.md"), "agent rules\n");

		const detection = detectExistingSetup(TMP);

		expect(detection.identityFiles).toEqual(["AGENTS.md"]);
		expect(Object.values(detection.harnesses).every((value) => value === false)).toBe(true);
	});

	const detectedHarnesses: readonly {
		readonly name: string;
		readonly harness: Harness;
		readonly setup: () => void;
	}[] = [
		{
			name: "detects Hermes Agent in the default ~/.hermes install path",
			harness: "hermesAgent",
			setup: () => mkdirSync(join(TMP, ".hermes", "plugins", "memory"), { recursive: true }),
		},
		{
			name: "detects Hermes Agent from HERMES_HOME without HERMES_REPO",
			harness: "hermesAgent",
			setup: () => {
				const hermesHome = join(TMP, "custom-hermes-home");
				process.env.HERMES_HOME = hermesHome;
				mkdirSync(join(hermesHome, "plugins", "memory"), { recursive: true });
			},
		},
		{
			name: "detects Hermes Agent in the managed ~/.hermes/hermes-agent checkout",
			harness: "hermesAgent",
			setup: () => mkdirSync(join(TMP, ".hermes", "hermes-agent", "plugins", "memory"), { recursive: true }),
		},
		{
			name: "detects Hermes Agent before the Signet memory plugin is installed",
			harness: "hermesAgent",
			setup: () => {
				const hermesRepo = join(TMP, "hermes-agent");
				process.env.HERMES_REPO = hermesRepo;
				mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
			},
		},
		{
			name: "detects ForgeCode from the default ~/.forge config path",
			harness: "forge",
			setup: () => {
				mkdirSync(join(TMP, ".forge"), { recursive: true });
				writeFileSync(join(TMP, ".forge", ".mcp.json"), "{}\n");
			},
		},
		{
			name: "detects ForgeCode from the legacy ~/forge config path",
			harness: "forge",
			setup: () => {
				mkdirSync(join(TMP, "forge"), { recursive: true });
				writeFileSync(join(TMP, "forge", ".forge.toml"), "# config\n");
			},
		},
		{
			name: "detects Kimi from the current ~/.kimi config home",
			harness: "kimi",
			setup: () => {
				mkdirSync(join(TMP, ".kimi"), { recursive: true });
				writeFileSync(join(TMP, ".kimi", "config.toml"), "[loop_control]\nmax_steps = 10\n");
			},
		},
		{
			name: "detects Kimi from the legacy KIMI_CODE_HOME override",
			harness: "kimi",
			setup: () => {
				const legacyHome = join(TMP, "legacy-kimi");
				process.env.KIMI_CODE_HOME = legacyHome;
				mkdirSync(legacyHome, { recursive: true });
				writeFileSync(join(legacyHome, "config.toml"), "[loop_control]\nmax_steps = 10\n");
			},
		},
		{
			name: "detects an Oh My Pi agent directory through the integration detector",
			harness: "ohMyPi",
			setup: () => mkdirSync(join(TMP, ".omp", "agent"), { recursive: true }),
		},
		{
			name: "detects a Pi agent directory through the integration detector",
			harness: "pi",
			setup: () => mkdirSync(join(TMP, ".pi", "agent"), { recursive: true }),
		},
	];

	for (const { name, harness, setup } of detectedHarnesses) {
		test(name, () => {
			setup();
			expectDetected(harness);
		});
	}

	test("uses USERPROFILE when HOME is unavailable", () => {
		const userProfile = join(TMP, "user-profile");
		delete process.env.HOME;
		process.env.USERPROFILE = userProfile;
		mkdirSync(join(userProfile, ".omp", "agent"), { recursive: true });
		mkdirSync(join(userProfile, ".pi", "agent"), { recursive: true });

		expectDetected("ohMyPi");
		expectDetected("pi");
	});

	test("detects configured Oh My Pi and Pi directories", () => {
		const agentDir = join(TMP, "shared-agent");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		mkdirSync(agentDir, { recursive: true });

		expectDetected("ohMyPi");
		expectDetected("pi");
	});

	test("does not report a missing Oh My Pi or Pi directory", () => {
		expect(existsSync(join(TMP, ".omp", "agent"))).toBe(false);
		expect(existsSync(join(TMP, ".pi", "agent"))).toBe(false);
		const detection = detectExistingSetup(TMP);
		expect(detection.harnesses.ohMyPi).toBe(false);
		expect(detection.harnesses.pi).toBe(false);
	});
});
