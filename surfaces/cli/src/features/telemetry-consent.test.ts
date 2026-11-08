import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as prompts from "@inquirer/prompts";
import { parseRuntimeYaml } from "@signet/core";
import { Command } from "commander";
import { registerTelemetryCommands } from "../commands/telemetry.js";
import { registerUpdateCommands } from "../commands/update.js";
import { promptTelemetryConsent, readWorkspaceTelemetryConsent } from "./telemetry-consent.js";

let dir = "";
let workspace = "";
const originalEnv = { ...process.env };
const tty = process.stdin.isTTY;
let output: string[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "signet-consent-"));
	workspace = join(dir, "workspace");
	mkdirSync(workspace);
	process.env.HOME = dir;
	process.env.HERMES_HOME = join(dir, "hermes");
	process.env.XDG_CONFIG_HOME = join(dir, "config");
	delete process.env.HERMES_REPO;
	delete process.env.SIGNET_TELEMETRY_OPTOUT;
	writeFileSync(
		join(workspace, "agent.yaml"),
		"# Keep this comment\nagent:\n  name: Fixture\nmemory:\n  pipelineV2:\n    enabled: false\n",
	);
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	output = [];
	spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		output.push(args.join(" "));
	});
});
afterEach(() => {
	for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
	Object.assign(process.env, originalEnv);
	Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
	rmSync(dir, { recursive: true, force: true });
	spyOn(console, "log").mockRestore();
	spyOn(prompts, "confirm").mockRestore();
});

test.each([true, false])("TTY consent saves an explicit answer once: %s", async (enabled) => {
	const prompt = spyOn(prompts, "confirm").mockResolvedValue(enabled);
	await promptTelemetryConsent(workspace);
	expect(prompt).toHaveBeenCalledWith({ message: "Send anonymous usage data?", default: false });
	expect(output.join("\n")).toContain("Share anonymous usage data?");
	expect(output.join("\n")).toContain(
		"The npm package also sends one anonymous install count, version and platform only",
	);
	expect(readWorkspaceTelemetryConsent(workspace)).toBe(enabled);
	await promptTelemetryConsent(workspace);
	expect(prompt).toHaveBeenCalledTimes(1);
	expect(readFileSync(join(workspace, "agent.yaml"), "utf8")).toContain("# Keep this comment");
});

test.each(["missing", "malformed"])("consent never breaks the caller when agent.yaml is %s", async (state) => {
	const prompt = spyOn(prompts, "confirm").mockResolvedValue(true);
	if (state === "missing") rmSync(join(workspace, "agent.yaml"));
	else writeFileSync(join(workspace, "agent.yaml"), "memory: [\n");
	await promptTelemetryConsent(workspace);
	expect(prompt).not.toHaveBeenCalled();
});

test("cancelling the consent prompt writes nothing and asks again later", async () => {
	const cancelled = new Error("User force closed the prompt");
	cancelled.name = "ExitPromptError";
	spyOn(prompts, "confirm").mockRejectedValue(cancelled);
	await promptTelemetryConsent(workspace);
	expect(readWorkspaceTelemetryConsent(workspace)).toBeUndefined();
});

test.each(["non-tty", "1", "true"])("consent never prompts or writes for %s", async (reason) => {
	const prompt = spyOn(prompts, "confirm").mockResolvedValue(true);
	if (reason === "non-tty") Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
	else process.env.SIGNET_TELEMETRY_OPTOUT = reason;
	const before = readFileSync(join(workspace, "agent.yaml"), "utf8");
	await promptTelemetryConsent(workspace);
	expect(prompt).not.toHaveBeenCalled();
	expect(readFileSync(join(workspace, "agent.yaml"), "utf8")).toBe(before);
});

test("telemetry status and on/off commands preserve nested config and env precedence", async () => {
	const run = async (state?: string) => {
		const program = new Command();
		registerTelemetryCommands(program, { AGENTS_DIR: workspace, normalizeAgentPath: (path) => path });
		await program.parseAsync(["telemetry", ...(state ? [state] : []), "--path", workspace], { from: "user" });
	};
	await run();
	expect(output.at(-1)).toContain("not yet answered");
	for (const state of ["on", "off"]) {
		await run(state);
		await run();
		expect(output.at(-1)).toBe(`Usage data ${state}.`);
		const config = parseRuntimeYaml(readFileSync(join(workspace, "agent.yaml"), "utf8"));
		expect(config.pipelineV2).toBeUndefined();
		expect(config.memory).toEqual({ pipelineV2: { enabled: false, telemetryEnabled: state === "on" } });
	}
	process.env.SIGNET_TELEMETRY_OPTOUT = "1";
	await run("on");
	await run();
	expect(output.at(-1)).toContain("disabled by SIGNET_TELEMETRY_OPTOUT");
});

test("a successful interactive update asks once, not a failed or unattended install", async () => {
	const prompt = spyOn(prompts, "confirm").mockResolvedValue(false);
	let success = false;
	const run = async () => {
		const program = new Command();
		registerUpdateCommands(program, {
			AGENTS_DIR: workspace,
			MIN_AUTO_UPDATE_INTERVAL: 300,
			MAX_AUTO_UPDATE_INTERVAL: 604800,
			fetchFromDaemon: async <T>(path: string) =>
				(path.includes("check") ? { updateAvailable: true, latestVersion: "1.0.0" } : { success }) as T,
			configureHarnessHooks: async () => {},
			getTemplatesDir: () => dir,
			getSkillsSourceDir: () => dir,
			isOpenClawInstalled: () => false,
			isOhMyPiInstalled: () => false,
			isPiInstalled: () => false,
			syncBuiltinSkills: () => ({ installed: [], updated: [], skipped: [] }),
			detectInstallations: () => ({
				target: { kind: "package-manager", family: "bun", executablePath: "fixture" },
				installations: [],
				inactive: [],
			}),
		});
		await program.parseAsync(["update", "install"], { from: "user" });
	};
	const exit = spyOn(process, "exit").mockImplementation(() => {
		throw new Error("exit");
	});
	try {
		await expect(run()).rejects.toThrow("exit");
		expect(prompt).not.toHaveBeenCalled();
		success = true;
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		await run();
		expect(prompt).not.toHaveBeenCalled();
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		await run();
		await run();
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(readWorkspaceTelemetryConsent(workspace)).toBe(false);
	} finally {
		exit.mockRestore();
	}
});
