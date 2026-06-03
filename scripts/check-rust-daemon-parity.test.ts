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

type ParityRules = {
	readonly rules: {
		readonly endpoints: Record<
			string,
			{
				readonly deterministic?: readonly string[];
				readonly ignoreFields?: readonly string[];
			}
		>;
	};
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

	test("shadow rules compare prompt-submit injected context", () => {
		const rules = JSON.parse(
			readFileSync("platform/daemon-rs/contracts/parity-rules.json", "utf8"),
		) as ParityRules;

		const promptSubmit = rules.rules.endpoints["POST /api/hooks/user-prompt-submit"];

		expect(promptSubmit?.deterministic).toContain("inject");
		expect(promptSubmit?.ignoreFields ?? []).not.toContain("inject");
	});

	test("cutover scripts wait for current daemon health contract", () => {
		const shadowReplay = readFileSync("platform/daemon-rs/scripts/shadow-replay.sh", "utf8");
		const cutover = readFileSync("platform/daemon-rs/scripts/cutover.sh", "utf8");

		expect(shadowReplay).toContain('"status"[[:space:]]*:[[:space:]]*"healthy"');
		expect(cutover).toContain('"status"[[:space:]]*:[[:space:]]*"healthy"');
		expect(shadowReplay).not.toContain('grep -q \'"ok"\'');
		expect(cutover).not.toContain('grep -q "ok"');
	});
});
