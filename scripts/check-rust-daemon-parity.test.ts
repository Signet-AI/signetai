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
});
