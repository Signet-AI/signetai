import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const packageJson = join(root, "dist/signetai/package.json");
const launcher = join(root, "dist/signetai/bin/signet-mcp.js");

describe("published native signet-mcp package", () => {
	test("manifest points at the native launcher and includes it", () => {
		expect(existsSync(packageJson)).toBe(true);
		const pkg = JSON.parse(readFileSync(packageJson, "utf8")) as { bin?: Record<string, string>; files?: string[] };
		expect(pkg.bin?.["signet-mcp"]).toBe("bin/signet-mcp.js");
		expect(pkg.files ?? []).toContain("bin/signet-mcp.js");
		expect(pkg.files ?? []).toContain("runtime");
		expect(pkg.bin?.["signet-mcp"]).not.toContain("mcp-stdio");
	});

	test("launcher is a tracked executable Node adapter with no archived or JS daemon fallback", () => {
		expect(existsSync(launcher)).toBe(true);
		expect(statSync(launcher).isFile()).toBe(true);
		const source = readFileSync(launcher, "utf8");
		expect(source.startsWith("#!/usr/bin/env node")).toBe(true);
		expect(source).toContain("SIGNET_RUST_MCP_BIN");
		expect(source).toContain("rust-daemon");
		expect(source).not.toMatch(/platform\/daemon-rs|mcp-stdio\.js|require\(['"](?:bun|tsx|ts-node)/);
	});
});
