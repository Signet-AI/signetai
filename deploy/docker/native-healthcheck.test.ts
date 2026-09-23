import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");

const dockerfile = readFileSync(resolve(repo, "deploy/docker/Dockerfile"), "utf8");
const compose = readFileSync(resolve(repo, "deploy/docker/compose.yml"), "utf8");
const cargo = readFileSync(resolve(repo, "platform/rust-daemon/Cargo.toml"), "utf8");
const healthcheck = resolve(repo, "platform/rust-daemon/src/bin/signet-healthcheck.rs");

test("Docker healthcheck is a native unauthenticated readiness probe", () => {
	expect(cargo).toContain('name = "signet-healthcheck"');
	expect(readFileSync(healthcheck, "utf8")).toContain("/health/ready");
	expect(dockerfile).toContain("signet-healthcheck");
	expect(dockerfile).not.toContain("healthcheck.mjs");
	expect(compose).toContain('test: ["CMD", "/app/bin/signet-healthcheck"]');
	expect(compose).not.toContain("bun /app/deploy/docker/scripts/healthcheck.mjs");
});
