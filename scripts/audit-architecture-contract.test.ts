import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	analyzeSourceTree,
	canonicalizeBaselineInventory,
	loadBaseline,
	renderReport,
} from "./audit-architecture-contract";

test("the committed baseline reproduces the current source and package inventory", () => {
	const baseline = loadBaseline();
	const current = analyzeSourceTree();
	expect(canonicalizeBaselineInventory(current)).toEqual(baseline);
	expect(current.summary.runtimeCycles).toBe(0);
	expect(current.summary.computedLoads).toBe(2);
	expect(current.summary.unresolvedEdges).toBeGreaterThanOrEqual(0);
	expect(current.generatedArtifacts.length).toBeGreaterThan(0);
	expect(current.generatedArtifactManifest).toHaveLength(4);
	expect(current.summary.packages).toBe(34);
});

test("structural edge identities survive unrelated line insertion", () => {
	const root = mkdtempSync(join("/mnt/work/hermes-scratch", "architecture-contract-"));
	try {
		writeFileSync(join(root, "types.ts"), "export interface Item { value: string; }\n");
		writeFileSync(
			join(root, "consumer.ts"),
			'import type { Item } from "./types";\nexport const value: Item = { value: "ok" };\n',
		);
		const first = analyzeSourceTree({ root, sourceRoot: root });
		writeFileSync(
			join(root, "consumer.ts"),
			'\n// unrelated lines must not churn structural identities\nimport type { Item } from "./types";\nexport const value: Item = { value: "ok" };\n',
		);
		const second = analyzeSourceTree({ root, sourceRoot: root });
		expect(second.sourceFiles.map((file) => file.id)).toEqual(first.sourceFiles.map((file) => file.id));
		expect(second.sourceEdges.map((edge) => edge.id)).toEqual(first.sourceEdges.map((edge) => edge.id));
		expect(second.typeCycles).toEqual(first.typeCycles);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the source graph separates type-only cycles from runtime cycles", () => {
	const root = mkdtempSync(join("/mnt/work/hermes-scratch", "architecture-cycle-"));
	try {
		writeFileSync(join(root, "a.ts"), 'export { type B } from "./b";\n');
		writeFileSync(join(root, "b.ts"), 'export { type A } from "./a";\n');
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.summary.runtimeCycles).toBe(0);
		expect(inventory.summary.typeCycles).toBe(1);
		expect(inventory.typeCycles[0]?.nodes).toEqual(["a.ts", "b.ts"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("manifested outputs are measured and excluded from handwritten source files", () => {
	const root = mkdtempSync(join("/mnt/work/hermes-scratch", "architecture-artifacts-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-root" }));
		writeFileSync(join(root, "normal-output.ts"), "export const generated = true;\n");
		writeFileSync(join(root, "handwritten.ts"), "export const handwritten = true;\n");
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "fixture-bundle.ts"), "export const bundled = true;\n");
		mkdirSync(join(root, "scripts"));
		writeFileSync(join(root, "scripts", "generate.ts"), "// outputs missing-output.ts and normal-output.ts\n");
		writeFileSync(
			join(root, "scripts", "architecture-generated-artifacts.json"),
			JSON.stringify({
				version: 1,
				artifacts: [
					{
						path: "missing-output.ts",
						owner: "fixture-root",
						source: "src",
						generatedBy: "scripts/generate.ts",
					},
					{
						path: "normal-output.ts",
						owner: "fixture-root",
						source: "src",
						generatedBy: "scripts/generate.ts",
					},
				],
			}),
		);
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.generatedArtifacts).toContainEqual({
			path: "normal-output.ts",
			lines: 2,
			bytes: 31,
			materialized: true,
			reason: "manifested-output",
		});
		expect(inventory.generatedArtifacts).toContainEqual({
			path: "src/fixture-bundle.ts",
			lines: 2,
			bytes: 29,
			materialized: true,
			reason: "bundle-name",
		});
		expect(inventory.sourceFiles.map((file) => file.path)).toEqual(["handwritten.ts", "scripts/generate.ts"]);
		expect(renderReport(inventory)).toContain("`missing-output.ts`");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("manifest provenance rejects a handwritten file hidden by a fake entry", () => {
	const root = mkdtempSync(join("/mnt/work/hermes-scratch", "architecture-manifest-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-root" }));
		writeFileSync(join(root, "handwritten.ts"), "export const handwritten = true;\n");
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "scripts"));
		writeFileSync(join(root, "scripts", "generate.ts"), "// outputs generated.ts\n");
		writeFileSync(
			join(root, "scripts", "architecture-generated-artifacts.json"),
			JSON.stringify({
				version: 1,
				artifacts: [
					{
						path: "handwritten.ts",
						owner: "fixture-root",
						source: "src",
						generatedBy: "scripts/generate.ts",
					},
				],
			}),
		);
		expect(() => analyzeSourceTree({ root, sourceRoot: root })).toThrow("does not identify its output");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("optional workspace dependencies are included in runtime and all package graphs", () => {
	const root = mkdtempSync(join("/mnt/work/hermes-scratch", "architecture-packages-"));
	try {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "fixture-root", optionalDependencies: { "fixture-child": "workspace:*" } }),
		);
		mkdirSync(join(root, "packages", "child"), { recursive: true });
		writeFileSync(join(root, "packages", "child", "package.json"), JSON.stringify({ name: "fixture-child" }));
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.packages.find((item) => item.name === "fixture-root")?.optionalDependencies).toEqual([
			"fixture-child",
		]);
		expect(inventory.packageRuntimeEdges).toContainEqual({ from: "", to: "packages/child" });
		expect(inventory.packageAllEdges).toContainEqual({ from: "", to: "packages/child" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("literal dynamic loads enter the graph and computed loads enter the ledger", () => {
	const root = mkdtempSync(join("/mnt/work/hermes-scratch", "architecture-loads-"));
	try {
		writeFileSync(join(root, "target.ts"), "export const target = true;\n");
		writeFileSync(
			join(root, "loader.ts"),
			[
				'void import("./target.js");',
				'const moduleName = "./target";',
				"void require(moduleName);",
				"void import(runtimePath);",
			].join("\n"),
		);
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceEdges.filter((edge) => edge.kind === "dynamic-import")).toHaveLength(1);
		expect(inventory.sourceEdges.filter((edge) => edge.kind === "require")).toHaveLength(1);
		expect(inventory.computedLoads).toHaveLength(1);
		expect(inventory.computedLoads[0]?.kind).toBe("dynamic-import");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("manifested build materialization does not churn the canonical baseline", () => {
	const root = mkdtempSync(join("/mnt/work/hermes-scratch", "architecture-materialization-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-root" }));
		mkdirSync(join(root, "source"));
		mkdirSync(join(root, "scripts"));
		writeFileSync(join(root, "source", "entry.ts"), "export const entry = true;\n");
		writeFileSync(join(root, "scripts", "generate.ts"), "// outputs generated.ts\n");
		writeFileSync(
			join(root, "scripts", "architecture-generated-artifacts.json"),
			JSON.stringify({
				version: 1,
				artifacts: [
					{
						path: "generated.ts",
						owner: "fixture-root",
						source: "source",
						generatedBy: "scripts/generate.ts",
					},
				],
			}),
		);
		const beforeBuild = analyzeSourceTree({ root, sourceRoot: root });
		writeFileSync(join(root, "generated.ts"), "export const generated = true;\n");
		const afterBuild = analyzeSourceTree({ root, sourceRoot: root });
		expect(canonicalizeBaselineInventory(afterBuild)).toEqual(canonicalizeBaselineInventory(beforeBuild));
		expect(afterBuild.generatedArtifacts).toContainEqual({
			path: "generated.ts",
			lines: 2,
			bytes: 31,
			materialized: true,
			reason: "manifested-output",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("shadowed bindings keep computed runtime loads in the ledger", () => {
	const root = mkdtempSync(join("/mnt/work/hermes-scratch", "architecture-scope-"));
	try {
		writeFileSync(join(root, "target.ts"), "export const target = true;\n");
		writeFileSync(
			join(root, "loader.ts"),
			[
				"export function load(path: string) { return import(path); }",
				'export function literal() { const path = "./target"; return require(path); }',
			].join("\n"),
		);
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.computedLoads).toHaveLength(1);
		expect(inventory.computedLoads[0]?.kind).toBe("dynamic-import");
		expect(inventory.sourceEdges).toContainEqual(
			expect.objectContaining({ kind: "require", specifier: "./target", to: "target.ts", runtime: true }),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
