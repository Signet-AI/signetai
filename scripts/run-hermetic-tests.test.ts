import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHermeticEnvironment } from "./run-hermetic-tests";

test("the hermetic environment moves home but keeps the Rust toolchain installation", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-hermetic-env-"));
	try {
		const env = buildHermeticEnvironment({ HOME: "/users/someone", PATH: "/bin" }, root);
		expect(env.HOME).toBe(join(root, "home"));
		expect(env.RUSTUP_HOME).toBe(join("/users/someone", ".rustup"));
		expect(env.CARGO_HOME).toBe(join("/users/someone", ".cargo"));
		const pinned = buildHermeticEnvironment(
			{ HOME: "/users/someone", RUSTUP_HOME: "/opt/rustup", CARGO_HOME: "/opt/cargo" },
			root,
		);
		expect(pinned.RUSTUP_HOME).toBe("/opt/rustup");
		expect(pinned.CARGO_HOME).toBe("/opt/cargo");
		const rustc = spawnSync("rustc", ["--print", "sysroot"], {
			env: buildHermeticEnvironment(process.env, root),
			encoding: "utf8",
		});
		expect(rustc.error).toBeUndefined();
		expect(rustc.stderr).toBe("");
		expect(rustc.status).toBe(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
