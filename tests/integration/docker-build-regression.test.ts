import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const dockerfile = readFileSync(join(rootDir, "deploy/docker/Dockerfile"), "utf8");
const dockerImageWorkflow = readFileSync(join(rootDir, ".github/workflows/docker-image.yml"), "utf8");
const dockerignore = readFileSync(join(rootDir, ".dockerignore"), "utf8");
const openclawPackageJson = JSON.parse(
	readFileSync(join(rootDir, "integrations/openclaw/memory-adapter/package.json"), "utf8"),
);
const daemonPackageJson = JSON.parse(readFileSync(join(rootDir, "platform/daemon/package.json"), "utf8"));
const desktopPackageJson = JSON.parse(readFileSync(join(rootDir, "surfaces/desktop/package.json"), "utf8"));
const openclawBuild =
	typeof openclawPackageJson === "object" &&
	openclawPackageJson !== null &&
	"scripts" in openclawPackageJson &&
	typeof openclawPackageJson.scripts === "object" &&
	openclawPackageJson.scripts !== null &&
	"build" in openclawPackageJson.scripts &&
	typeof openclawPackageJson.scripts.build === "string"
		? openclawPackageJson.scripts.build
		: undefined;
const daemonCopySkills =
	typeof daemonPackageJson === "object" &&
	daemonPackageJson !== null &&
	"scripts" in daemonPackageJson &&
	typeof daemonPackageJson.scripts === "object" &&
	daemonPackageJson.scripts !== null &&
	"copy:skills" in daemonPackageJson.scripts &&
	typeof daemonPackageJson.scripts["copy:skills"] === "string"
		? daemonPackageJson.scripts["copy:skills"]
		: undefined;
const desktopBuild =
	typeof desktopPackageJson === "object" &&
	desktopPackageJson !== null &&
	"scripts" in desktopPackageJson &&
	typeof desktopPackageJson.scripts === "object" &&
	desktopPackageJson.scripts !== null &&
	"build:desktop" in desktopPackageJson.scripts &&
	typeof desktopPackageJson.scripts["build:desktop"] === "string"
		? desktopPackageJson.scripts["build:desktop"]
		: undefined;
const desktopTypecheck =
	typeof desktopPackageJson === "object" &&
	desktopPackageJson !== null &&
	"scripts" in desktopPackageJson &&
	typeof desktopPackageJson.scripts === "object" &&
	desktopPackageJson.scripts !== null &&
	"typecheck" in desktopPackageJson.scripts &&
	typeof desktopPackageJson.scripts.typecheck === "string"
		? desktopPackageJson.scripts.typecheck
		: undefined;
const desktopHomepage =
	typeof desktopPackageJson === "object" &&
	desktopPackageJson !== null &&
	"homepage" in desktopPackageJson &&
	typeof desktopPackageJson.homepage === "string"
		? desktopPackageJson.homepage
		: undefined;
const openclawEntry = readFileSync(join(rootDir, "integrations/openclaw/memory-adapter/src/index.ts"), "utf8");

function getBuildCommands(source: string): string[] {
	return source
		.split("\n")
		.filter((line) => line.startsWith("RUN bun run "))
		.map((line) => line.replace("RUN bun run ", "").trim());
}

describe("Docker build pipeline regression guard", () => {
	it("uses shared build scripts instead of hardcoded connector filters", () => {
		expect(dockerfile).toContain("RUN bun run build:deps");
		expect(dockerfile).not.toContain("--filter '@signet/connector-");
	});

	it("keeps source buckets available in the Docker build context", () => {
		expect(dockerfile).toContain("COPY dist ./dist");
		expect(dockerignore).toContain("!dist/signetai/**");
		expect(dockerignore).toContain("dist/signetai/dist");
	});

	it("runs the Docker daemon entrypoint through the native Signet binary", () => {
		const entrypoint = readFileSync(join(rootDir, "deploy/docker/entrypoint.sh"), "utf8");

		expect(dockerfile).toContain("RUN bun run build:native-bun");
		expect(dockerfile).toContain("COPY --from=build /app/dist/native/signet ./bin/signet");
		expect(dockerfile).toContain("ENV SIGNET_DAEMON_ENTRYPOINT=1");
		expect(dockerfile).toContain("COPY --from=build /app/dist/signetai/templates ./dist/signetai/templates");
		expect(dockerfile).toContain("chmod +x ./bin/signet ");
		expect(entrypoint).toContain("exec /app/bin/signet");
		expect(entrypoint).not.toContain("exec /app/bin/signet-daemon");
		expect(entrypoint).not.toContain("exec bun /app/dist/signetai/dist/daemon.js");
	});

	it("keeps the shared prebuild sequence aligned before packaging signetai", () => {
		expect(getBuildCommands(dockerfile)).toEqual([
			"build:core",
			"build:connector-base",
			"build:opencode-plugin",
			"build:native",
			"build:oh-my-pi-extension",
			"build:connector-oh-my-pi",
			"build:pi-extension",
			"build:connector-pi",
			"build:deps",
			"build:dashboard",
			"build:signetai",
			"build:native-bun",
		]);
	});

	it("keeps the OpenClaw adapter build Docker-safe when bundling @signetai/core", () => {
		expect(openclawEntry).toContain('from "@signetai/core"');
		expect(openclawBuild).toContain("--external better-sqlite3");
	});

	it("keeps desktop release builds aligned with workspace dependency order", () => {
		expect(desktopBuild).toBeDefined();
		if (!desktopBuild) return;
		expect(desktopBuild).toStartWith("bun run build:core");
		expect(desktopBuild).toContain("bun run build:daemon");
		expect(desktopBuild.indexOf("bun run build:core")).toBeLessThan(desktopBuild.indexOf("bun run build:daemon"));
	});

	it("keeps desktop typecheck aligned with workspace dependency order", () => {
		expect(desktopTypecheck).toBeDefined();
		if (!desktopTypecheck) return;
		expect(desktopTypecheck).toStartWith("bun run build:tray");
		expect(desktopTypecheck).toContain("tsc -p tsconfig.json --noEmit");
	});

	it("keeps Electron Builder from auto-publishing during tag builds", () => {
		expect(desktopBuild).toBeDefined();
		if (!desktopBuild) return;
		expect(desktopBuild).toContain("electron-builder --publish never");
	});

	it("uses a cross-platform skills copy script for daemon builds", () => {
		expect(daemonCopySkills).toBe("bun ../../scripts/copy-skills.ts");
		expect(daemonCopySkills).not.toContain("cp -r");
	});

	it("keeps desktop Linux package metadata complete for deb generation", () => {
		expect(desktopHomepage).toBe("https://signetai.sh");
	});

	it("fails stable Docker release CI when GHCR latest is not publicly pullable", () => {
		expect(dockerImageWorkflow).toContain("Verify public GHCR latest pull");
		expect(dockerImageWorkflow).toContain("if: ${{ !contains(github.ref_name, '-') }}");
		expect(dockerImageWorkflow).toContain(
			'DOCKER_CONFIG="${tmp_config}" docker manifest inspect ghcr.io/signet-ai/signet:latest',
		);
		expect(dockerImageWorkflow).toContain("is not publicly pullable");
	});
});
