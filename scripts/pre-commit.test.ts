import { describe, expect, test } from "bun:test";
import {
	buildClosure,
	buildOrder,
	isBiomeCandidate,
	isWorkspaceSpec,
	typecheckCandidates,
	type WorkspaceInfo,
	readWorkspaces,
} from "./pre-commit";

function workspace(
	dir: string,
	name: string,
	workspaceDependencies: readonly string[] = [],
	hasTypecheck = true,
	hasBuild = true,
	version = "0.226.28",
): WorkspaceInfo {
	return { dir, hasBuild, hasTypecheck, name, version, workspaceDependencies };
}

const WORKSPACES: readonly WorkspaceInfo[] = [
	workspace("libs/connector-base", "@signet/connector-base"),
	workspace("libs/sdk", "@signet/sdk", ["@signet/core"], false),
	workspace("integrations/oh-my-pi/connector", "@signet/connector-oh-my-pi"),
	workspace("integrations/pi/extension", "@signet/pi-extension", ["@signet/core", "@signet/pi-extension-base"]),
	workspace("integrations/pi/extension-base", "@signet/pi-extension-base", [], false),
	workspace("platform/core", "@signet/core"),
	workspace("surfaces/web", "@signet/web", [], false),
];

describe("typecheckCandidates", () => {
	test("maps a staged source file to its owning workspace only", () => {
		const targets = typecheckCandidates(["platform/core/src/index.ts"], WORKSPACES);
		expect([...targets]).toEqual(["@signet/core"]);
	});

	test("selects only the owning workspace; its dependencies are covered by the build closure", () => {
		const targets = typecheckCandidates(["integrations/pi/extension/src/main.ts"], WORKSPACES);
		expect([...targets]).toEqual(["@signet/pi-extension"]);
	});

	test("runs no typechecks for a staged change in a workspace without a typecheck script", () => {
		const targets = typecheckCandidates(["libs/sdk/src/client.ts"], WORKSPACES);
		expect(targets.size).toBe(0);
	});

	test("selects the deepest workspace for nested directories", () => {
		const nested = [
			workspace("integrations/pi", "@signet/pi"),
			workspace("integrations/pi/extension", "@signet/pi-extension"),
		];
		const targets = typecheckCandidates(["integrations/pi/extension/src/main.ts"], nested);
		expect([...targets]).toEqual(["@signet/pi-extension"]);
	});

	test("normalizes Windows path separators", () => {
		const targets = typecheckCandidates(["integrations\\pi\\extension\\src\\main.ts"], WORKSPACES);
		expect([...targets]).toEqual(["@signet/pi-extension"]);
	});

	test("widens to every typecheck-capable workspace for shared root files", () => {
		for (const shared of ["package.json", "tsconfig.json", "bun.lock", "bunfig.toml", "biome.json"]) {
			const targets = typecheckCandidates([shared], WORKSPACES);
			expect([...targets].sort()).toEqual([
				"@signet/connector-base",
				"@signet/connector-oh-my-pi",
				"@signet/core",
				"@signet/pi-extension",
			]);
		}
	});

	test("widens to every typecheck-capable workspace for shared tooling", () => {
		for (const shared of ["scripts/pre-commit.ts", "tests/integration/daemon.test.ts"]) {
			const targets = typecheckCandidates([shared], WORKSPACES);
			expect([...targets].sort()).toEqual([
				"@signet/connector-base",
				"@signet/connector-oh-my-pi",
				"@signet/core",
				"@signet/pi-extension",
			]);
		}
	});

	test("returns no targets for documentation-only changes", () => {
		const targets = typecheckCandidates(["README.md", "docs/guide.md", "web/marketing/src/pages.md"], WORKSPACES);
		expect(targets.size).toBe(0);
	});

	test("returns no targets when a workspace's only staged file is documentation", () => {
		const targets = typecheckCandidates(["integrations/pi/extension/README.md"], WORKSPACES);
		expect(targets.size).toBe(0);
	});

	test("selects the owning workspace for non-TypeScript code files", () => {
		const targets = typecheckCandidates(["integrations/oh-my-pi/connector/assets/config.json"], WORKSPACES);
		expect([...targets]).toEqual(["@signet/connector-oh-my-pi"]);
	});

	test("returns no targets for paths outside every workspace", () => {
		const targets = typecheckCandidates(["screenshots/app.png"], WORKSPACES);
		expect(targets.size).toBe(0);
	});

	test("returns no targets for an empty staged set", () => {
		expect(typecheckCandidates([], WORKSPACES).size).toBe(0);
	});
});

describe("buildClosure", () => {
	test("returns the target plus its transitive workspace dependencies", () => {
		const closure = buildClosure(["@signet/pi-extension"], WORKSPACES);
		expect([...closure].sort()).toEqual(["@signet/core", "@signet/pi-extension", "@signet/pi-extension-base"]);
	});

	test("returns a target with no dependencies unchanged", () => {
		const closure = buildClosure(["@signet/core"], WORKSPACES);
		expect([...closure]).toEqual(["@signet/core"]);
	});

	test("ignores unknown names", () => {
		const closure = buildClosure(["@signet/nonexistent"], WORKSPACES);
		expect(closure.size).toBe(0);
	});

	test("handles an empty target list", () => {
		expect(buildClosure([], WORKSPACES).size).toBe(0);
	});
});

describe("buildOrder", () => {
	test("orders providers before their dependents", () => {
		const closure = buildClosure(["@signet/pi-extension"], WORKSPACES);
		const order = buildOrder(closure, WORKSPACES);
		expect(order).toEqual(["@signet/core", "@signet/pi-extension-base", "@signet/pi-extension"]);
	});

	test("excludes build-excluded and build-less workspaces", () => {
		const closure = buildClosure(
			["@signet/daemon"],
			[workspace("platform/core", "@signet/core"), workspace("platform/daemon", "@signet/daemon", ["@signet/core"])],
		);
		const order = buildOrder(closure, [
			workspace("platform/core", "@signet/core"),
			workspace("platform/daemon", "@signet/daemon", ["@signet/core"]),
		]);
		expect(order).toEqual(["@signet/core"]);
	});

	test("emits nothing when the closure is empty", () => {
		expect(buildOrder(new Set(), WORKSPACES)).toEqual([]);
	});

	test("mirrors bun workspace linking semantics", () => {
		expect(isWorkspaceSpec("workspace:*", "0.226.28")).toBe(true);
		expect(isWorkspaceSpec("0.226.28", "0.226.28")).toBe(true);
		expect(isWorkspaceSpec("^0.226.28", "0.226.28")).toBe(false);
		expect(isWorkspaceSpec("0.226.27", "0.226.28")).toBe(false);
	});

	test("derives pinned-version edges from the live workspace manifests", async () => {
		const workspaces = await readWorkspaces();
		const connector = workspaces.find((workspace) => workspace.name === "@signet/connector-claude-code");
		expect(connector?.workspaceDependencies).toContain("@signet/core");
		expect(connector?.workspaceDependencies).toContain("@signet/connector-base");
		const core = workspaces.find((workspace) => workspace.name === "@signet/core");
		expect(core?.workspaceDependencies).toContain("@signet/native");
		const daemon = workspaces.find((workspace) => workspace.name === "@signet/daemon");
		expect(daemon?.workspaceDependencies).toContain("@signet/native");
	});
});

describe("isBiomeCandidate", () => {
	test("accepts supported source files", () => {
		expect(isBiomeCandidate("platform/core/src/index.ts")).toBe(true);
		expect(isBiomeCandidate("surfaces/dashboard/src/App.astro")).toBe(true);
	});

	test("rejects non-code files", () => {
		expect(isBiomeCandidate("README.md")).toBe(false);
		expect(isBiomeCandidate("screenshots/app.png")).toBe(false);
	});

	test("rejects excluded directories", () => {
		expect(isBiomeCandidate("references/vendored/pkg/index.ts")).toBe(false);
		expect(isBiomeCandidate("platform/core/generated/schema.ts")).toBe(false);
	});
});
