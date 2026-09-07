import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectExistingSetup } from "./setup-detection.js";

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

beforeEach(() => {
	mkdirSync(TMP, { recursive: true });
	process.env.HOME = TMP;
	process.env.PATH = join(TMP, "bin");
	for (const key of ENVIRONMENT_KEYS) {
		if (key === "HOME" || key === "PATH") continue;
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENVIRONMENT_KEYS) {
		const value = ORIGINAL_ENVIRONMENT.get(key);
		if (value === undefined) {
			delete process.env[key];
			continue;
		}
		process.env[key] = value;
	}
	rmSync(TMP, { recursive: true, force: true });
});

describe("detectExistingSetup", () => {
	test("detects identity files without requiring a harness", () => {
		writeFileSync(join(TMP, "AGENTS.md"), "agent rules\n");

		const detection = detectExistingSetup(TMP);

		expect(detection.identityFiles).toEqual(["AGENTS.md"]);
		expect(Object.values(detection.harnesses).every((value) => value === false)).toBe(true);
	});

	test("detects Hermes Agent in the default ~/.hermes install path", () => {
		mkdirSync(join(TMP, ".hermes", "plugins", "memory"), { recursive: true });

		const detection = detectExistingSetup(TMP);

		expect(detection.harnesses.hermesAgent).toBe(true);
	});

	test("detects Hermes Agent from HERMES_HOME without HERMES_REPO", () => {
		const hermesHome = join(TMP, "custom-hermes-home");
		process.env.HERMES_HOME = hermesHome;
		mkdirSync(join(hermesHome, "plugins", "memory"), { recursive: true });

		const detection = detectExistingSetup(TMP);

		expect(detection.harnesses.hermesAgent).toBe(true);
	});

	test("detects Hermes Agent in the managed ~/.hermes/hermes-agent checkout", () => {
		mkdirSync(join(TMP, ".hermes", "hermes-agent", "plugins", "memory"), { recursive: true });

		const detection = detectExistingSetup(TMP);

		expect(detection.harnesses.hermesAgent).toBe(true);
	});

	test("detects Hermes Agent before the Signet memory plugin is installed", () => {
		const hermesRepo = join(TMP, "hermes-agent");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		process.env.HERMES_REPO = hermesRepo;

		const detection = detectExistingSetup(TMP);

		expect(detection.harnesses.hermesAgent).toBe(true);
	});

	test("detects ForgeCode from the default ~/.forge config path", () => {
		mkdirSync(join(TMP, ".forge"), { recursive: true });
		writeFileSync(join(TMP, ".forge", ".mcp.json"), "{}\n");

		const detection = detectExistingSetup(TMP);

		expect(detection.harnesses.forge).toBe(true);
	});

	test("detects ForgeCode from the legacy ~/forge config path", () => {
		mkdirSync(join(TMP, "forge"), { recursive: true });
		writeFileSync(join(TMP, "forge", ".forge.toml"), "# config\n");

		const detection = detectExistingSetup(TMP);

		expect(detection.harnesses.forge).toBe(true);
	});

	test("detects Kimi from the current ~/.kimi config home", () => {
		mkdirSync(join(TMP, ".kimi"), { recursive: true });
		writeFileSync(join(TMP, ".kimi", "config.toml"), "[loop_control]\nmax_steps = 10\n");

		const detection = detectExistingSetup(TMP);

		expect(detection.harnesses.kimi).toBe(true);
	});

	test("detects Kimi from the legacy KIMI_CODE_HOME override", () => {
		const legacyHome = join(TMP, "legacy-kimi");
		process.env.KIMI_CODE_HOME = legacyHome;
		mkdirSync(legacyHome, { recursive: true });
		writeFileSync(join(legacyHome, "config.toml"), "[loop_control]\nmax_steps = 10\n");

		const detection = detectExistingSetup(TMP);

		expect(detection.harnesses.kimi).toBe(true);
	});

	test("detects an Oh My Pi agent directory through the integration detector", () => {
		mkdirSync(join(TMP, ".omp", "agent"), { recursive: true });

		const detection = detectExistingSetup(TMP);

		expect(detection.harnesses.ohMyPi).toBe(true);
	});

	test("detects a Pi agent directory through the integration detector", () => {
		mkdirSync(join(TMP, ".pi", "agent"), { recursive: true });

		const detection = detectExistingSetup(TMP);

		expect(detection.harnesses.pi).toBe(true);
	});

	test("uses USERPROFILE when HOME is unavailable", () => {
		const userProfile = join(TMP, "user-profile");
		Reflect.deleteProperty(process.env, "HOME");
		process.env.USERPROFILE = userProfile;
		mkdirSync(join(userProfile, ".omp", "agent"), { recursive: true });
		mkdirSync(join(userProfile, ".pi", "agent"), { recursive: true });

		const detection = detectExistingSetup(TMP);

		expect(detection.harnesses.ohMyPi).toBe(true);
		expect(detection.harnesses.pi).toBe(true);
	});

	test("detects configured Oh My Pi and Pi directories", () => {
		const agentDir = join(TMP, "shared-agent");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		mkdirSync(agentDir, { recursive: true });

		const detection = detectExistingSetup(TMP);

		expect(detection.harnesses.ohMyPi).toBe(true);
		expect(detection.harnesses.pi).toBe(true);
	});

	test("does not report a missing Oh My Pi or Pi directory", () => {
		expect(existsSync(join(TMP, ".omp", "agent"))).toBe(false);
		expect(existsSync(join(TMP, ".pi", "agent"))).toBe(false);

		const detection = detectExistingSetup(TMP);

		expect(detection.harnesses.ohMyPi).toBe(false);
		expect(detection.harnesses.pi).toBe(false);
	});
});
