import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { createDbAccessorLifecycle } from "./accessor-lifecycle";

const ROOT = join(import.meta.dir, "..", "..");

function source(relativePath: string): string {
	return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function imports(path: string): string[] {
	const file = join(ROOT, path);
	const text = readFileSync(file, "utf8");
	const specifiers = [...text.matchAll(/(?:from|import\()\s*"(\.{1,2}\/[^"]+)"/g)].map((match) => match[1] ?? "");
	return specifiers.map((specifier) => relative(ROOT, join(dirname(file), specifier)).replace(/\.(ts|js)$/, ""));
}

describe("DB foundation dependency invariant", () => {
	it("prevents accessor and vacuum primitives from importing owner orchestration", () => {
		const accessor = imports("db/owner/accessor.ts");
		const vacuum = imports("db/maintenance/vacuum.ts");

		expect(accessor).not.toContain("db/owner/runtime");
		expect(accessor).not.toContain("agents/identity/agent-id");
		expect(accessor).not.toContain("db/maintenance/vacuum-worker");
		expect(vacuum).not.toContain("db/owner/runtime");
	});
});

describe("close participant lifecycle", () => {
	it("preserves owner-before-cache order and rejects registration during close", async () => {
		const lifecycle = createDbAccessorLifecycle();
		const closed: string[] = [];
		let duringCloseError: unknown;
		lifecycle.register({
			name: "test-agent-scope-cache",
			order: 200,
			close: () => {
				closed.push("agent-scope-cache");
			},
		});
		lifecycle.register({
			name: "test-db-owner",
			order: 100,
			close: () => {
				closed.push("db-owner");
				try {
					lifecycle.register({
						name: "during-close-participant",
						order: 300,
						close: () => undefined,
					});
				} catch (error) {
					duringCloseError = error;
				}
			},
		});

		await lifecycle.close(undefined);

		expect(closed).toEqual(["db-owner", "agent-scope-cache"]);
		expect(duringCloseError).toBeInstanceOf(Error);
		expect((duringCloseError as Error).message).toContain("registered after close started");
		lifecycle.register({
			name: "next-lifecycle-participant",
			order: 300,
			close: () => {
				closed.push("next-lifecycle-participant");
			},
		});
		await lifecycle.close(undefined);
		expect(closed).toEqual([
			"db-owner",
			"agent-scope-cache",
			"db-owner",
			"agent-scope-cache",
			"next-lifecycle-participant",
		]);
	});

	it("reopens after a participant failure without caching the rejected close", async () => {
		const lifecycle = createDbAccessorLifecycle();
		let attempts = 0;
		lifecycle.register({
			name: "flaky-participant",
			order: 100,
			close: () => {
				attempts += 1;
				if (attempts === 1) throw new Error("simulated close failure");
			},
		});

		await expect(lifecycle.close(undefined)).rejects.toThrow("simulated close failure");
		lifecycle.register({
			name: "reinitialized-participant",
			order: 200,
			close: () => undefined,
		});
		await lifecycle.close(undefined);
		expect(attempts).toBe(2);
	});
});

describe("owner transport purity", () => {
	it("keeps DB owner transport independent of Dreaming implementations", () => {
		const runtime = imports("db/owner/runtime.ts");
		const dreaming = runtime.filter(
			(target) =>
				target.startsWith("dreaming/") ||
				target === "ontology/graph/quality" ||
				target === "inference/providers/dreaming-token-worker",
		);

		expect(runtime).not.toContain("ontology/graph/hygiene");
		expect(dreaming).toEqual([]);
	});

	it("keeps the knowledge graph independent of Dreaming composition", () => {
		const graph = source("../../ontology/graph/knowledge-graph.ts");
		const sourceFile = ts.createSourceFile("knowledge-graph.ts", graph, ts.ScriptTarget.Latest, true);
		const importsDreamingAtRuntime = sourceFile.statements.some((statement) => {
			if (
				!ts.isImportDeclaration(statement) ||
				!ts.isStringLiteral(statement.moduleSpecifier) ||
				statement.moduleSpecifier.text !== "../../dreaming/passes/dreaming"
			) {
				return false;
			}
			const importClause = statement.importClause;
			if (importClause === undefined) return true;
			if (importClause.isTypeOnly) return false;
			if (importClause.name !== undefined) return true;
			const bindings = importClause.namedBindings;
			if (bindings === undefined) return false;
			if (ts.isNamespaceImport(bindings)) return true;
			return bindings.elements.some((specifier) => !specifier.isTypeOnly);
		});

		expect(importsDreamingAtRuntime).toBe(false);
	});
});
