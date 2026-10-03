import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { smokeEnvironment } from "./installed-desktop-smoke.ts";

const desktop = resolve(fileURLToPath(import.meta.url), "../..");
const workflow = readFileSync(resolve(desktop, "../../.github/workflows/desktop-installed-smoke.yml"), "utf8");

describe("installed desktop smoke", () => {
	test("isolates home and workspace while retaining only host-required service variables", () => {
		const home = "/tmp/isolated-home";
		const workspace = "/tmp/isolated-home/.agents";
		const env = smokeEnvironment(home, workspace);
		expect(env.HOME).toBe(home);
		expect(env.SIGNET_PATH).toBe(workspace);
		expect(env.SIGNET_DAEMON_RUNTIME).toBe("bun-js");
		expect(env.XDG_RUNTIME_DIR).toBe(resolve(home, "run"));
		for (const key of ["TEMP", "TMP", "TMPDIR"]) expect(env[key]).toBe(resolve(home, "tmp"));
		expect(env.LANG).toBe("C");
		if (process.platform === "darwin") expect(env.CFFIXED_USER_HOME).toBe(home);
		if (process.platform !== "darwin") expect(env.CFFIXED_USER_HOME).toBeUndefined();
		expect(env.DBUS_SESSION_BUS_ADDRESS).toEqual(process.env.SIGNET_SMOKE_DBUS_ADDRESS);
		expect(env.PATH).not.toContain(process.env.PATH ?? "never");
		expect(env.NODE_PATH).toBeUndefined();
		expect(env.SIGNET_BUN_PATH).toBeUndefined();
	});
	test("installer workflow executes an installed-resource smoke on supported operating systems", () => {
		expect(workflow).toContain("ubuntu-22.04");
		expect(workflow).toContain("macos-14");
		expect(workflow).toContain("windows-latest");
		expect(workflow).toContain("bun surfaces/desktop/scripts/installed-desktop-smoke.ts");
		expect(workflow).toContain("SIGNET_DESKTOP_SMOKE_INSTALLER");
	});
});
