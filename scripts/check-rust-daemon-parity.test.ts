import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

type Manifest = {
	readonly routes: readonly {
		readonly method: string;
		readonly path: string;
		readonly status: string;
	}[];
};

describe("rust daemon route parity manifest", () => {
	test("is current with TypeScript and Rust route mounts", () => {
		const result = spawnSync("bun", ["scripts/check-rust-daemon-parity.ts"], {
			cwd: process.cwd(),
			encoding: "utf8",
		});

		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});

	test("has no missing or malformed extracted routes", () => {
		const manifest = JSON.parse(
			readFileSync("platform/daemon-rs/contracts/route-parity.json", "utf8"),
		) as Manifest;

		const missing = manifest.routes.filter((route) => route.status === "missing");
		const malformed = manifest.routes.filter((route) => route.path.includes("{"));

		expect(missing.map((route) => `${route.method} ${route.path}`)).toEqual([]);
		expect(malformed.map((route) => `${route.method} ${route.path}`)).toEqual([]);
	});

	test("workflow runs for Rust daemon dependency changes", () => {
		const workflow = readFileSync(".github/workflows/rust-daemon-parity.yml", "utf8");

		expect(workflow).toContain('"platform/daemon-rs/Cargo.lock"');
		expect(workflow).toContain('"platform/daemon-rs/Cargo.toml"');
		expect(workflow).toContain('"platform/daemon-rs/crates/**"');
		expect(workflow).toContain("bun test scripts/check-rust-daemon-parity.test.ts");
		expect(workflow).toContain("bun scripts/check-rust-daemon-parity.ts");
	});
});
