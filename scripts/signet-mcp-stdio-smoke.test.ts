import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { detectNativePlatform, resolveNativeBinaryPath } from "../dist/signetai/bin/native-platforms.js";

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
		expect(source).toContain("resolveNativeBinaryPath");
		expect(source).not.toMatch(/platform\/daemon-rs|mcp-stdio\.js|require\(['"](?:bun|tsx|ts-node)/);
	});

	test("wrappers share one strict platform/package contract", () => {
		expect(detectNativePlatform("linux", "x64")).toBe("linux-x64");
		expect(resolveNativeBinaryPath({ packageDir: "/pkg", platform: "linux", arch: "x64", staged: true })).toBe(
			join("/pkg", "runtime", "rust-daemon", "linux-x64", "signet"),
		);
		expect(() => detectNativePlatform("freebsd", "x64")).toThrow("Unsupported platform");
		expect(() => detectNativePlatform("linux", "ia32")).toThrow("Unsupported platform");
	});
});
