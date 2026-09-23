import { chmodSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { resolveFreshRustDaemon } from "./lib/fresh-rust-daemon";

const makeExecutable = (path: string) => {
	writeFileSync(path, "#!/bin/sh\nexit 0\n");
	chmodSync(path, 0o755);
};

const installedRoot = () => {
	const root = mkdtempSync(join(tmpdir(), "signet-installed-"));
	const runtimeRoot = join(root, "dist", "signetai", "runtime", "rust-daemon");
	const runtime = join(runtimeRoot, `${process.platform}-${process.arch}`);
	mkdirSync(runtime, { recursive: true });
	mkdirSync(join(runtimeRoot, "dashboard"), { recursive: true });
	writeFileSync(join(runtimeRoot, "dashboard", "index.html"), "<!doctype html>");
	const binary = join(runtime, process.platform === "win32" ? "signet-daemon.exe" : "signet-daemon");
	makeExecutable(binary);
	return { root, binary, runtime };
};

describe("native packaging launcher contract", () => {
	it("selects the staged Rust binary and never a TypeScript daemon", () => {
		const { root, binary } = installedRoot();
		expect(resolveFreshRustDaemon(root)).toBe(binary);
	});

	it("fails closed when the staged binary is missing", () => {
		const { root, binary } = installedRoot();
		unlinkSync(binary);
		expect(() => resolveFreshRustDaemon(root)).toThrow(/fresh Rust daemon binary missing/);
	});

	it("fails closed when the staged dashboard runtime asset is missing", () => {
		const { root, runtime } = installedRoot();
		unlinkSync(join(runtime, "..", "dashboard", "index.html"));
		expect(() => resolveFreshRustDaemon(root)).toThrow(/dashboard runtime asset missing/);
	});

	it("keeps an explicit developer/test override available", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-dev-"));
		const binary = join(root, "custom-daemon");
		makeExecutable(binary);
		expect(resolveFreshRustDaemon(root, { SIGNET_RUST_DAEMON_BIN: binary, NODE_ENV: "test" })).toBe(binary);
	});
});
