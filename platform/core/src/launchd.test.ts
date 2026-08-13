import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { buildLaunchdEnvironment, buildLaunchdPlist, resolveLaunchdExecutable } from "./launchd";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("launchd environment", () => {
	it("adds the user's install prefixes when launchd supplies a minimal PATH", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-launchd-home-"));
		temporaryDirectories.push(home);
		const bunBin = join(home, ".bun", "bin");
		const userBin = join(home, "bin");
		mkdirSync(bunBin, { recursive: true });
		mkdirSync(userBin, { recursive: true });
		for (const [directory, name] of [
			[bunBin, "bun"],
			[userBin, "git"],
		] as const) {
			const executable = join(directory, name);
			writeFileSync(executable, "#!/bin/sh\n");
			chmodSync(executable, 0o755);
		}

		const environment = buildLaunchdEnvironment({
			environment: { HOME: home, PATH: "/usr/bin:/bin" },
			home,
		});

		expect(environment.PATH.split(":")).toContain(bunBin);
		expect(environment.PATH.split(":")).toContain(userBin);
		expect(environment.PATH.split(":")).toContain("/usr/bin");
	});

	it("resolves critical executables from the install-time PATH and preserves their directories", () => {
		const directory = mkdtempSync(join(tmpdir(), "signet-launchd-path-"));
		temporaryDirectories.push(directory);
		const bin = join(directory, "bin");
		mkdirSync(bin);
		for (const name of ["git", "bun", "npx", "python3"]) {
			const executable = join(bin, name);
			writeFileSync(executable, "#!/bin/sh\n");
			chmodSync(executable, 0o755);
		}

		const environment = buildLaunchdEnvironment({
			environment: { HOME: "/Users/user", PATH: bin },
			pathValue: bin,
			values: { SIGNET_PATH: "/Users/user/.agents" },
		});

		expect(resolveLaunchdExecutable("git", { environment: { HOME: "/Users/user" }, pathValue: bin })).toBe(
			join(bin, "git"),
		);
		expect(environment.PATH.split(":")).toContain(bin);
		expect(environment.HOME).toBe("/Users/user");
		expect(environment.SIGNET_PATH).toBe("/Users/user/.agents");
	});

	it("puts the resolved environment in the launchd plist", () => {
		const environment = buildLaunchdEnvironment({
			environment: { HOME: "/Users/user", PATH: "/Users/user/.bun/bin:/usr/bin" },
			values: { SIGNET_PATH: "/Users/user/.agents" },
		});
		const plist = buildLaunchdPlist({
			label: "ai.signet.daemon",
			programArguments: ["/Users/user/.bun/bin/bun", "/opt/signet/daemon.js"],
			environment,
			workingDirectory: "/Users/user/.agents",
			standardOutPath: "/dev/null",
			standardErrorPath: "/Users/user/.agents/.daemon/logs/startup.log",
		});

		expect(plist).toContain("<key>PATH</key>");
		expect(plist).toContain("/Users/user/.bun/bin");
		expect(plist).toContain("/usr/bin");
		expect(plist).toContain("<key>SIGNET_PATH</key>");
		expect(plist).toContain("<string>/Users/user/.agents</string>");
	});

	it("escapes plist values so PATH and workspace paths remain valid XML", () => {
		const plist = buildLaunchdPlist({
			label: "ai.signet.daemon",
			programArguments: ["/opt/signet/daemon.js"],
			environment: { PATH: "/Users/user/bin", SIGNET_PATH: "/Users/user/Work & Projects" },
			workingDirectory: "/Users/user/Work & Projects",
			standardOutPath: "/dev/null",
			standardErrorPath: "/Users/user/Work & Projects/startup.log",
		});

		expect(plist).toContain("Work &amp; Projects");
		expect(plist).not.toContain("Work & Projects");
	});
});
