import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeSourceTree, loadBaseline } from "./audit-architecture-contract";

test("the committed baseline reproduces the current source and package inventory", () => {
	const baseline = loadBaseline();
	const current = analyzeSourceTree();
	expect(current).toEqual(baseline);
	expect(current.summary.runtimeCycles).toBe(0);
	expect(current.summary.computedLoads).toBe(2);
	expect(current.summary.unresolvedEdges).toBeGreaterThanOrEqual(0);
	expect(current.generatedArtifacts.length).toBeGreaterThan(0);
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
		writeFileSync(join(root, "a.ts"), 'import type { B } from "./b"; export type A = B;\n');
		writeFileSync(join(root, "b.ts"), 'import type { A } from "./a"; export type B = A;\n');
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.summary.runtimeCycles).toBe(0);
		expect(inventory.summary.typeCycles).toBe(1);
		expect(inventory.typeCycles[0]?.nodes).toEqual(["a.ts", "b.ts"]);
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
