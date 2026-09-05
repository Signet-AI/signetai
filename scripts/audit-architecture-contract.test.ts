import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	analyzeSourceTree,
	canonicalizeBaselineInventory,
	compareArchitectureRatchet,
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

test("the pull-request workflow uses a protected evaluator and clean candidate checkout", () => {
	const workflow = readFileSync(join(import.meta.dir, "../.github/workflows/architecture-ratchet.yml"), "utf8");
	expect(workflow).toContain("on:\n  pull_request_target:");
	expect(workflow).not.toContain("on:\n  pull_request:");
	expect(workflow).toContain("name: Architecture audit and ratchet");
	expect(workflow).toContain("ref: ${{" + " github.event.pull_request.base.sha }}");
	expect(workflow).toContain("TRUSTED_AUDITOR: ${{" + " github.workspace }}/scripts/audit-architecture-contract.ts");
	expect(workflow).toContain('test -f "$TRUSTED_AUDITOR"');
	expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$BASE_SHA"');
	expect(workflow).toContain('git init --quiet "$CANDIDATE_REPO"');
	expect(workflow).toContain('git -C "$CANDIDATE_REPO" fetch --no-tags --depth=1 candidate "$HEAD_SHA"');
	expect(workflow).toContain('git -C "$CANDIDATE_REPO" --work-tree="$CANDIDATE_ROOT" read-tree --reset -u "$HEAD_SHA"');
	expect(workflow).not.toContain('git -C "$CANDIDATE_REPO" archive "$HEAD_SHA"');
	expect(workflow).toContain('git archive "$BASE_SHA" | tar -x -C "$BASE_ROOT"');
	expect(workflow).not.toContain("CANDIDATE_ROOT: ${{" + " github.workspace }}");
	expect(workflow).not.toContain("TRUSTED_AUDITOR_COMMIT");
	expect(workflow).not.toContain('git show "$TRUSTED_AUDITOR_COMMIT');
	expect(workflow).not.toContain("TRUSTED_AUDITOR: ${{ github.event.pull_request.head.sha");
	expect(workflow).not.toContain('git -C "$CANDIDATE_REPO" show');
	expect(workflow).toContain(
		"if: github.event_name == 'push'\n        run: bun test scripts/audit-architecture-contract.test.ts",
	);
	expect(workflow).toContain("github.event.pull_request.base.sha");
	expect(workflow).toContain("TRUSTED_AUDITOR");
	expect(workflow).toContain("await import(pathToFileURL(trustedAuditor).href)");
	expect(workflow).toContain("candidateRoot");
	expect(workflow).toContain(
		"analyzeSourceTree({\n              root: baseRoot,\n              sourceRoot: baseRoot,\n              validateGeneratedArtifacts: false,\n            })",
	);
	expect(workflow).toContain(
		"analyzeSourceTree({\n              root: candidateRoot,\n              sourceRoot: candidateRoot,\n              validateGeneratedArtifacts: true,\n            })",
	);
	expect(workflow).toContain("compareArchitectureRatchet(candidate, protectedBase)");
	expect(workflow).toContain("bun run audit:architecture");
	const targetAuditStart = workflow.indexOf("Audit pull request from a protected evaluator");
	const targetAuditEnd = workflow.indexOf("- name: Enforce architecture ratchet on main", targetAuditStart);
	expect(targetAuditStart).toBeGreaterThanOrEqual(0);
	expect(targetAuditEnd).toBeGreaterThan(targetAuditStart);
	const targetAudit = workflow.slice(targetAuditStart, targetAuditEnd);
	expect(targetAudit).not.toContain("bun install");
	expect(targetAudit).not.toContain("bun test");
	expect(targetAudit).not.toContain("bun run build");
	const protectedArchive = targetAudit.indexOf('git archive "$BASE_SHA"');
	const candidateCheckout = targetAudit.indexOf(
		'git -C "$CANDIDATE_REPO" --work-tree="$CANDIDATE_ROOT" read-tree --reset -u "$HEAD_SHA"',
	);
	const evaluator = targetAudit.indexOf("bun -e '");
	expect(protectedArchive).toBeGreaterThanOrEqual(0);
	expect(candidateCheckout).toBeGreaterThan(protectedArchive);
	expect(evaluator).toBeGreaterThan(candidateCheckout);
	expect(workflow).not.toContain(
		'import { analyzeSourceTree, writeBaseline } from "./scripts/audit-architecture-contract"',
	);
	expect(workflow).not.toContain("--write-baseline");
});

test("clean candidate checkout materializes tracked files ignored by git archive", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-clean-candidate-checkout-"));
	try {
		const repository = join(root, "repository");
		const candidate = join(root, "candidate");
		execFileSync("git", ["init", "--quiet", repository]);
		execFileSync("git", ["-C", repository, "config", "user.email", "architecture-test@example.invalid"]);
		execFileSync("git", ["-C", repository, "config", "user.name", "Architecture Test"]);
		writeFileSync(join(repository, ".gitattributes"), "hidden.ts export-ignore\n");
		writeFileSync(join(repository, "visible.ts"), "export const visible = true;\n");
		writeFileSync(join(repository, "hidden.ts"), "export const hidden = true;\n");
		execFileSync("git", ["-C", repository, "add", "--all"]);
		execFileSync("git", ["-C", repository, "commit", "--quiet", "-m", "fixture"]);
		const commit = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		const archive = execFileSync("git", ["-C", repository, "archive", commit]);
		const archivedPaths = execFileSync("tar", ["-tf", "-"], { input: archive, encoding: "utf8" });
		expect(archivedPaths).not.toContain("hidden.ts");

		mkdirSync(candidate);
		execFileSync("git", ["-C", repository, `--work-tree=${candidate}`, "read-tree", "--reset", "-u", commit]);
		expect(readFileSync(join(candidate, "hidden.ts"), "utf8")).toContain("hidden");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("structural edge identities survive unrelated line insertion", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-contract-"));
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
	const root = mkdtempSync(join(tmpdir(), "architecture-cycle-"));
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
	const root = mkdtempSync(join(tmpdir(), "architecture-artifacts-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-root" }));
		const normalOutput =
			"// Auto-generated by scripts/generate.ts\n// Architecture provenance: generatedBy=scripts/generate.ts\nexport const generated = true;\n";
		const bundleOutput =
			"// Auto-generated by scripts/generate.ts\n// Architecture provenance: generatedBy=scripts/generate.ts\nexport const bundled = true;\n";
		writeFileSync(join(root, "normal-output.ts"), normalOutput);
		writeFileSync(join(root, "handwritten.ts"), "export const handwritten = true;\n");
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "source.txt"), "source\n");
		writeFileSync(join(root, "src", "fixture-bundle.ts"), bundleOutput);
		mkdirSync(join(root, "scripts"));
		writeFileSync(
			join(root, "scripts", "generate.ts"),
			'import { join } from "node:path";\nimport { readFileSync, writeFileSync } from "node:fs";\n// Architecture provenance: source=src\n// src outputs missing-output.ts, normal-output.ts, and fixture-bundle.ts\nconst source = join(__dirname, "..", "src", "source.txt");\nreadFileSync(source, "utf8");\nconst normal = join(__dirname, "..", "normal-output.ts");\nconst bundle = join(__dirname, "..", "src", "fixture-bundle.ts");\nconst missing = join(__dirname, "..", "missing-output.ts");\nwriteFileSync(normal, "");\nwriteFileSync(bundle, "");\nwriteFileSync(missing, "");\n',
		);
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
					{
						path: "src/fixture-bundle.ts",
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
			lines: normalOutput.split("\n").length,
			bytes: Buffer.byteLength(normalOutput),
			materialized: true,
			reason: "manifested-output",
		});
		expect(inventory.generatedArtifacts).toContainEqual(
			expect.objectContaining({
				path: "src/fixture-bundle.ts",
				lines: bundleOutput.split("\n").length,
				bytes: Buffer.byteLength(bundleOutput),
				materialized: true,
				reason: "manifested-output",
			}),
		);
		expect(inventory.sourceFiles.map((file) => file.path)).toEqual(["handwritten.ts", "scripts/generate.ts"]);
		expect(renderReport(inventory)).toContain("`missing-output.ts`");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("protected comparison fails closed for an unmanifested generated-path cycle", () => {
	const baseRoot = mkdtempSync(join(tmpdir(), "architecture-protected-base-"));
	const candidateRoot = mkdtempSync(join(tmpdir(), "architecture-generated-cycle-"));
	try {
		mkdirSync(join(candidateRoot, "generated"));
		writeFileSync(join(candidateRoot, "generated", "a.ts"), 'import "./b";\nexport const a = true;\n');
		writeFileSync(join(candidateRoot, "generated", "b.ts"), 'import "./a";\nexport const b = true;\n');
		const protectedBase = analyzeSourceTree({ root: baseRoot, sourceRoot: baseRoot });
		expect(() => {
			const candidate = analyzeSourceTree({ root: candidateRoot, sourceRoot: candidateRoot });
			compareArchitectureRatchet(candidate, protectedBase);
		}).toThrow("Generated artifact generated/a.ts matches generated-path");
	} finally {
		rmSync(baseRoot, { recursive: true, force: true });
		rmSync(candidateRoot, { recursive: true, force: true });
	}
});

test("protected history allowlists generated artifacts before candidate manifests can hide them", () => {
	const baseRoot = mkdtempSync(join(tmpdir(), "architecture-protected-artifact-base-"));
	const candidateRoot = mkdtempSync(join(tmpdir(), "architecture-protected-artifact-candidate-"));
	try {
		for (const root of [baseRoot, candidateRoot]) {
			writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-root" }));
			mkdirSync(join(root, "src"));
			mkdirSync(join(root, "scripts"));
			writeFileSync(join(root, "src", "input.txt"), "trusted input\n");
		}
		const baseGenerator = [
			'import { readFileSync, writeFileSync } from "node:fs";',
			'import { join } from "node:path";',
			"// Architecture provenance: source=src",
			'readFileSync(join(__dirname, "..", "src", "input.txt"), "utf8");',
			'writeFileSync(join(__dirname, "..", "output.ts"), "");',
		].join("\n");
		writeFileSync(join(baseRoot, "scripts", "generate.ts"), baseGenerator);
		writeFileSync(
			join(candidateRoot, "scripts", "generate.ts"),
			[
				baseGenerator,
				'writeFileSync(join(__dirname, "..", "generated", "hidden.ts"), "");',
				'writeFileSync(join(__dirname, "..", "generated", "other.ts"), "");',
			].join("\n"),
		);
		mkdirSync(join(candidateRoot, "generated"));
		writeFileSync(
			join(candidateRoot, "generated", "hidden.ts"),
			'// Auto-generated by scripts/generate.ts\n// Architecture provenance: generatedBy=scripts/generate.ts\nimport "./other";\n',
		);
		writeFileSync(
			join(candidateRoot, "generated", "other.ts"),
			'// Auto-generated by scripts/generate.ts\n// Architecture provenance: generatedBy=scripts/generate.ts\nimport "./hidden";\n',
		);
		writeFileSync(
			join(candidateRoot, "scripts", "architecture-generated-artifacts.json"),
			JSON.stringify({
				version: 1,
				artifacts: [
					{
						path: "generated/hidden.ts",
						owner: "fixture-root",
						source: "src",
						generatedBy: "scripts/generate.ts",
					},
					{
						path: "generated/other.ts",
						owner: "fixture-root",
						source: "src",
						generatedBy: "scripts/generate.ts",
					},
				],
			}),
		);
		const protectedBase = analyzeSourceTree({
			root: baseRoot,
			sourceRoot: baseRoot,
			validateGeneratedArtifacts: false,
		});
		const candidate = analyzeSourceTree({ root: candidateRoot, sourceRoot: candidateRoot });
		expect(protectedBase.protectedGeneratedArtifactManifest).toContainEqual({
			path: "output.ts",
			owner: "fixture-root",
			source: "src",
			generatedBy: "scripts/generate.ts",
		});
		expect(candidate.sourceFiles.map((file) => file.path)).not.toContain("generated/hidden.ts");
		expect(candidate.sourceFiles.map((file) => file.path)).not.toContain("generated/other.ts");
		expect(compareArchitectureRatchet(candidate, protectedBase)).toContain(
			"generated artifact manifest entry generated/hidden.ts is not present in protected history",
		);
	} finally {
		rmSync(baseRoot, { recursive: true, force: true });
		rmSync(candidateRoot, { recursive: true, force: true });
	}
});

test("manifest provenance rejects marker text inside strings and template literals", () => {
	const sourceToken = "// Architecture provenance: source=src";
	const generatedToken = "// Architecture provenance: generatedBy=scripts/generate.ts";
	const generatedMarker = "// Auto-generated by scripts/generate.ts";
	const cases = [
		{
			name: "source string",
			generatorMarker: `const marker = ${JSON.stringify(sourceToken)};`,
			artifactSource:
				"// Auto-generated by scripts/generate.ts\n// Architecture provenance: generatedBy=scripts/generate.ts\nexport const generated = true;\n",
			error: "does not identify its source src",
		},
		{
			name: "source template literal",
			generatorMarker: ["const marker = `", sourceToken, "`;"].join("\n"),
			artifactSource:
				"// Auto-generated by scripts/generate.ts\n// Architecture provenance: generatedBy=scripts/generate.ts\nexport const generated = true;\n",
			error: "does not identify its source src",
		},
		{
			name: "generatedBy string",
			generatorMarker: "// Architecture provenance: source=src",
			artifactSource: `const marker = ${JSON.stringify(`${generatedMarker}\\n${generatedToken}`)};\nexport const generated = true;\n`,
			error: "is materialized without a provenance header naming scripts/generate.ts",
		},
		{
			name: "generatedBy template literal",
			generatorMarker: "// Architecture provenance: source=src",
			artifactSource: [
				"const marker = `",
				generatedMarker,
				generatedToken,
				"`;",
				"export const generated = true;",
				"",
			].join("\n"),
			error: "is materialized without a provenance header naming scripts/generate.ts",
		},
	];

	for (const fixture of cases) {
		const root = mkdtempSync(join(tmpdir(), `architecture-comment-trivia-${fixture.name.replaceAll(" ", "-")}-`));
		try {
			writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-root" }));
			mkdirSync(join(root, "src"));
			mkdirSync(join(root, "scripts"));
			writeFileSync(join(root, "output.ts"), fixture.artifactSource);
			writeFileSync(
				join(root, "scripts", "generate.ts"),
				[
					'import { join } from "node:path";',
					'import { writeFileSync } from "node:fs";',
					fixture.generatorMarker,
					'const output = join(__dirname, "..", "output.ts");',
					'writeFileSync(output, "");',
				].join("\n"),
			);
			writeFileSync(
				join(root, "scripts", "architecture-generated-artifacts.json"),
				JSON.stringify({
					version: 1,
					artifacts: [
						{
							path: "output.ts",
							owner: "fixture-root",
							source: "src",
							generatedBy: "scripts/generate.ts",
						},
					],
				}),
			);
			expect(() => analyzeSourceTree({ root, sourceRoot: root }), fixture.name).toThrow(fixture.error);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("manifest provenance rejects a handwritten file hidden by a fake entry", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-manifest-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-root" }));
		writeFileSync(join(root, "handwritten.ts"), "export const handwritten = true;\n");
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "scripts"));
		writeFileSync(
			join(root, "scripts", "generate.ts"),
			'import { join } from "node:path";\nimport { writeFileSync } from "node:fs";\n// Architecture provenance: source=src\n// src produces handwritten.ts\nconst output = join(__dirname, "..", "handwritten.ts");\nwriteFileSync(output, "");\n',
		);
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
		expect(() => analyzeSourceTree({ root, sourceRoot: root })).toThrow("without a provenance header");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("unmanifested generated markers, paths, and bundle names cannot hide source", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-unmanifested-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-root" }));
		writeFileSync(join(root, "rogue.ts"), "// Auto-generated by scripts/unknown.ts\nexport const rogue = true;\n");
		mkdirSync(join(root, "generated"));
		writeFileSync(join(root, "generated", "path-rogue.ts"), "export const rogue = true;\n");
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "name-bundle.ts"), "export const rogue = true;\n");
		expect(() => analyzeSourceTree({ root, sourceRoot: root })).toThrow(
			"not listed in scripts/architecture-generated-artifacts.json",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("optional workspace dependencies are included in runtime and all package graphs", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-packages-"));
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
	const root = mkdtempSync(join(tmpdir(), "architecture-loads-"));
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
	const root = mkdtempSync(join(tmpdir(), "architecture-materialization-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-root" }));
		mkdirSync(join(root, "source"));
		mkdirSync(join(root, "scripts"));
		writeFileSync(join(root, "source", "entry.ts"), "export const entry = true;\n");
		writeFileSync(
			join(root, "scripts", "generate.ts"),
			'import { join } from "node:path";\nimport { readFileSync, writeFileSync } from "node:fs";\n// Architecture provenance: source=source\n// source outputs generated.ts\nreadFileSync(join(__dirname, "..", "source", "entry.ts"), "utf8");\nwriteFileSync(join(__dirname, "..", "generated.ts"), "");\n',
		);
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
		const generatedOutput =
			"// Auto-generated by scripts/generate.ts\n// Architecture provenance: generatedBy=scripts/generate.ts\nexport const generated = true;\n";
		writeFileSync(join(root, "generated.ts"), generatedOutput);
		const afterBuild = analyzeSourceTree({ root, sourceRoot: root });
		expect(canonicalizeBaselineInventory(afterBuild)).toEqual(canonicalizeBaselineInventory(beforeBuild));
		expect(afterBuild.generatedArtifacts).toContainEqual({
			path: "generated.ts",
			lines: generatedOutput.split("\n").length,
			bytes: Buffer.byteLength(generatedOutput),
			materialized: true,
			reason: "manifested-output",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("shadowed bindings keep computed runtime loads in the ledger", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-scope-"));
	try {
		writeFileSync(join(root, "target.ts"), "export const target = true;\n");
		writeFileSync(
			join(root, "loader.ts"),
			[
				'const path = "./target";',
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

test("shadowed require bindings do not fabricate runtime edges or cycles", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-require-shadow-"));
	try {
		writeFileSync(join(root, "target.ts"), "export const target = true;\n");
		writeFileSync(
			join(root, "loader.ts"),
			['import "./target";', "const require = (_path: string) => undefined;", 'require("./target");'].join("\n"),
		);
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceEdges.filter((edge) => edge.kind === "require")).toHaveLength(0);
		expect(inventory.computedLoads).toContainEqual(expect.objectContaining({ kind: "require", path: "loader.ts" }));
		expect(inventory.summary.runtimeCycles).toBe(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("nested-block var shadowing keeps computed runtime loads in the ledger", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-var-scope-"));
	try {
		writeFileSync(join(root, "target.ts"), "export const target = true;\n");
		writeFileSync(
			join(root, "loader.ts"),
			[
				'const path = "./target";',
				"export function load(runtimePath: string) {",
				"	return import(path);",
				"	if (globalThis) { var path = runtimePath; }",
				"}",
			].join("\n"),
		);
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.computedLoads).toHaveLength(1);
		expect(inventory.computedLoads[0]?.kind).toBe("dynamic-import");
		expect(inventory.sourceEdges).not.toContainEqual(
			expect.objectContaining({ kind: "dynamic-import", specifier: "./target", to: "target.ts", runtime: true }),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("loop bindings do not leak into the enclosing scope after the loop", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-loop-scope-"));
	try {
		writeFileSync(join(root, "target.ts"), "export const target = true;\n");
		writeFileSync(
			join(root, "loader.ts"),
			[
				'const path = "./target";',
				'export function loadFor() { for (const path = "./other"; false; ) {} return import(path); }',
				"export function loadForIn() { for (const path in { other: true }) {} return import(path); }",
				'export function loadForOf() { for (const path of ["./other"]) {} return import(path); }',
			].join("\n"),
		);
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.computedLoads).toHaveLength(0);
		expect(inventory.sourceEdges.filter((edge) => edge.kind === "dynamic-import")).toHaveLength(3);
		expect(inventory.sourceEdges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "dynamic-import", specifier: "./target", to: "target.ts", runtime: true }),
			]),
		);
		expect(inventory.sourceEdges).not.toContainEqual(
			expect.objectContaining({ kind: "dynamic-import", specifier: "./other", runtime: true }),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ratchet rejects module, public-surface, and type-escape growth", () => {
	const baseline = loadBaseline();
	const first = baseline.sourceFiles[0];
	expect(first).toBeDefined();
	if (first === undefined) return;
	const current = {
		...baseline,
		sourceFiles: baseline.sourceFiles.map((module) =>
			module.path === first.path
				? {
						...module,
						logicalStatements: module.logicalStatements + 1,
						exports: module.exports + 1,
						typeEscapes: (module.typeEscapes ?? 0) + 1,
					}
				: module,
		),
	};
	const findings = compareArchitectureRatchet(current, baseline);
	expect(findings).toEqual(
		expect.arrayContaining([
			expect.stringContaining(`module growth in ${first.path}`),
			expect.stringContaining(`public-surface growth in ${first.path}`),
			expect.stringContaining(`type-escape growth in ${first.path}`),
		]),
	);
});

test("ratchet rejects runtime cycles and expanded type SCCs", () => {
	const baseline = loadBaseline();
	const existing = baseline.typeCycles[0];
	expect(existing).toBeDefined();
	if (existing === undefined) return;
	const current = {
		...baseline,
		runtimeCycles: [{ id: "runtime-cycle", nodes: ["a.ts", "b.ts"] }],
		summary: { ...baseline.summary, runtimeCycles: 1 },
		typeCycles: [{ id: "expanded-cycle", nodes: [...existing.nodes, "new.ts"] }],
	};
	const findings = compareArchitectureRatchet(current, baseline);
	expect(findings).toEqual(
		expect.arrayContaining([
			expect.stringContaining("runtime source cycles exceed the zero budget"),
			expect.stringContaining("new or expanded type-inclusive SCC expanded-cycle"),
		]),
	);
});

test("ratchet rejects new forbidden layer edges and routes/state importers", () => {
	const baseline = loadBaseline();
	const current = {
		...baseline,
		sourceEdges: [
			...baseline.sourceEdges,
			{
				id: "synthetic-boundary-edge",
				from: "platform/core/src/package-manager.ts",
				to: "platform/daemon/src/routes/state.ts",
				specifier: "./state",
				kind: "import" as const,
				runtime: true,
				line: 1,
			},
		],
	};
	const findings = compareArchitectureRatchet(current, baseline);
	expect(findings).toEqual(
		expect.arrayContaining([
			expect.stringContaining("new forbidden source-layer edge"),
			expect.stringContaining("new routes/state.ts importer platform/core/src/package-manager.ts"),
		]),
	);
});

test("configured tsconfig path aliases participate in runtime SCC detection", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-alias-cycle-"));
	try {
		writeFileSync(
			join(root, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } } }),
		);
		writeFileSync(join(root, "a.ts"), 'import { b } from "@/b";\nexport const a = b;\n');
		writeFileSync(join(root, "b.ts"), 'import { a } from "@/a";\nexport const b = a;\n');
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceEdges.filter((edge) => edge.to !== null)).toHaveLength(2);
		expect(inventory.summary.runtimeCycles).toBe(1);
		expect(inventory.sourceEdges.filter((edge) => edge.to === null)).toHaveLength(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ImportEquals bindings prevent local require calls from becoming runtime edges", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-import-equals-"));
	try {
		writeFileSync(join(root, "fake.ts"), "export const fake = true;\n");
		writeFileSync(join(root, "target.ts"), "export const target = true;\n");
		writeFileSync(join(root, "loader.ts"), 'import require = require("./fake");\nrequire("./target");\n');
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceEdges.filter((edge) => edge.kind === "require")).toHaveLength(0);
		expect(inventory.computedLoads).toContainEqual(expect.objectContaining({ kind: "require", path: "loader.ts" }));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ambient CommonJS require aliases and documented global forms retain runtime provenance", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-ambient-require-"));
	try {
		writeFileSync(join(root, "target.ts"), "export const target = true;\n");
		writeFileSync(
			join(root, "loader.ts"),
			[
				"const alias = require;",
				'alias("./target");',
				'globalThis.require("./target");',
				"const bound = require.bind(null);",
				'bound("./target");',
				"const { require: destructured } = globalThis;",
				'destructured("./target");',
			].join("\n"),
		);
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceEdges.filter((edge) => edge.kind === "require")).toHaveLength(4);
		expect(inventory.sourceEdges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "require", specifier: "./target", to: "target.ts", runtime: true }),
			]),
		);
		expect(inventory.computedLoads).toHaveLength(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ambient CommonJS assignments and default parameters retain runtime provenance", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-ambient-require-assignment-"));
	try {
		writeFileSync(join(root, "target.ts"), 'import "./loader";\nexport const target = true;\n');
		writeFileSync(
			join(root, "loader.ts"),
			[
				"let alias;",
				"alias = require;",
				'alias("./target");',
				"function load(loader = require) {",
				'	loader("./target");',
				"}",
				"load();",
			].join("\n"),
		);
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceEdges.filter((edge) => edge.kind === "require" && edge.to === "target.ts")).toHaveLength(2);
		expect(inventory.computedLoads.filter((load) => load.kind === "require")).toHaveLength(0);
		expect(inventory.summary.runtimeCycles).toBe(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("shadowed and reassigned ambient require forms fail closed into the computed ledger", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-ambient-require-shadow-"));
	try {
		writeFileSync(join(root, "target.ts"), "export const target = true;\n");
		writeFileSync(
			join(root, "loader.ts"),
			[
				"let alias = require;",
				"alias = (_path: string) => undefined;",
				'alias("./target");',
				"const globalThis = { require: (_path: string) => undefined };",
				'globalThis.require("./target");',
				"const require = (_path: string) => undefined;",
				'require.bind(null)("./target");',
			].join("\n"),
		);
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceEdges.filter((edge) => edge.kind === "require")).toHaveLength(0);
		expect(inventory.computedLoads.filter((load) => load.kind === "require")).toHaveLength(3);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("only the lexical canonical createRequire binding enables runtime require edges", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-create-require-"));
	try {
		writeFileSync(join(root, "target.ts"), "export const target = true;\n");
		writeFileSync(
			join(root, "loader.ts"),
			[
				'import { createRequire as canonical } from "node:module";',
				"function createRequire(_url: unknown) { return (_path: string) => undefined; }",
				"const require = createRequire(import.meta.url);",
				'require("./target");',
			].join("\n"),
		);
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceEdges.filter((edge) => edge.kind === "require")).toHaveLength(0);
		expect(inventory.computedLoads).toContainEqual(expect.objectContaining({ kind: "require", path: "loader.ts" }));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("lexical fake createRequire bindings stay computed even with an unaliased canonical import", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-create-require-shadow-"));
	try {
		writeFileSync(join(root, "target.ts"), "export const target = true;\n");
		writeFileSync(
			join(root, "loader.ts"),
			[
				'import { createRequire } from "node:module";',
				"function load() {",
				"	const require = createRequire(import.meta.url);",
				'	require("./target");',
				"	function createRequire(_url: unknown) { return (_path: string) => undefined; }",
				"}",
			].join("\n"),
		);
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceEdges.filter((edge) => edge.kind === "require")).toHaveLength(0);
		expect(inventory.computedLoads).toContainEqual(expect.objectContaining({ kind: "require", path: "loader.ts" }));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("outer canonical createRequire provenance survives an inner shadow", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-create-require-outer-scope-"));
	try {
		writeFileSync(join(root, "target.ts"), "export const target = true;\n");
		writeFileSync(
			join(root, "loader.ts"),
			[
				'import { createRequire } from "node:module";',
				"const require = createRequire(import.meta.url);",
				"function load() {",
				"function createRequire(_url: unknown) { return (_path: string) => undefined; }",
				'return require("./target");',
				"}",
			].join("\n"),
		);
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceEdges).toContainEqual(
			expect.objectContaining({ kind: "require", specifier: "./target", to: "target.ts", runtime: true }),
		);
		expect(inventory.computedLoads).not.toContainEqual(expect.objectContaining({ kind: "require", path: "loader.ts" }));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("named export-list growth trips the public-surface ratchet", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-export-list-"));
	try {
		writeFileSync(join(root, "target.ts"), "export const one = true;\nexport const two = true;\n");
		writeFileSync(join(root, "consumer.ts"), 'export { one } from "./target";\n');
		const baseline = analyzeSourceTree({ root, sourceRoot: root });
		writeFileSync(join(root, "consumer.ts"), 'export { one, two } from "./target";\n');
		const current = analyzeSourceTree({ root, sourceRoot: root });
		expect(current.sourceFiles.find((file) => file.path === "consumer.ts")?.exports).toBe(2);
		expect(compareArchitectureRatchet(current, baseline)).toContain(
			"public-surface growth in consumer.ts: 1 -> 2 exports",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("manifest output paths resolve identifiers in their lexical defining scope", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-manifest-output-scope-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-root" }));
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "scripts"));
		writeFileSync(
			join(root, "scripts", "generate.ts"),
			[
				'import { writeFileSync } from "node:fs";',
				'import { join } from "node:path";',
				'const output = join(__dirname, "real.ts");',
				"function later() {",
				'\tconst output = join(__dirname, "fake.ts");',
				"}",
				"// Architecture provenance: source=src",
				"// src output",
				'writeFileSync(output, "");',
			].join("\n"),
		);
		writeFileSync(
			join(root, "scripts", "architecture-generated-artifacts.json"),
			JSON.stringify({
				version: 1,
				artifacts: [
					{
						path: "scripts/fake.ts",
						owner: "fixture-root",
						source: "src",
						generatedBy: "scripts/generate.ts",
					},
				],
			}),
		);
		expect(() => analyzeSourceTree({ root, sourceRoot: root })).toThrow(
			"does not write its exact output scripts/fake.ts",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("manifest output paths reject mutable or reassigned bindings", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-manifest-output-mutable-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-root" }));
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "scripts"));
		writeFileSync(
			join(root, "scripts", "generate.ts"),
			[
				'import { writeFileSync } from "node:fs";',
				'import { join } from "node:path";',
				'let output = join(__dirname, "real.ts");',
				'output = join(__dirname, "fake.ts");',
				"// Architecture provenance: source=src",
				"// src output",
				'writeFileSync(output, "");',
			].join("\n"),
		);
		writeFileSync(
			join(root, "scripts", "architecture-generated-artifacts.json"),
			JSON.stringify({
				version: 1,
				artifacts: [
					{
						path: "scripts/fake.ts",
						owner: "fixture-root",
						source: "src",
						generatedBy: "scripts/generate.ts",
					},
				],
			}),
		);
		expect(() => analyzeSourceTree({ root, sourceRoot: root })).toThrow(
			"Generated artifact generator has no statically verifiable output path",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("manifest output paths require canonical path helper provenance", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-manifest-path-helper-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-root" }));
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "scripts"));
		writeFileSync(
			join(root, "scripts", "generate.ts"),
			[
				'import { writeFileSync } from "node:fs";',
				'const join = (_dir: string, _name: string) => "/outside/actual.ts";',
				"// Architecture provenance: source=src",
				"// src output",
				'writeFileSync(join(__dirname, "output.ts"), "");',
			].join("\n"),
		);
		writeFileSync(
			join(root, "scripts", "architecture-generated-artifacts.json"),
			JSON.stringify({
				version: 1,
				artifacts: [
					{
						path: "scripts/output.ts",
						owner: "fixture-root",
						source: "src",
						generatedBy: "scripts/generate.ts",
					},
				],
			}),
		);
		expect(() => analyzeSourceTree({ root, sourceRoot: root })).toThrow(
			"Generated artifact generator has no statically verifiable output path",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("manifest output paths require a canonical writeFileSync binding", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-manifest-writer-provenance-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-root" }));
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "scripts"));
		writeFileSync(
			join(root, "scripts", "generate.ts"),
			[
				'import { writeFileSync as realWriteFileSync } from "node:fs";',
				'import { join } from "node:path";',
				"// generates files under src",
				"{",
				"const writeFileSync = (_path: string, _content: string) => undefined;",
				'writeFileSync(join(__dirname, "fake.ts"), "");',
				"}",
				'realWriteFileSync(join(__dirname, "actual.ts"), "");',
			].join("\n"),
		);
		writeFileSync(
			join(root, "scripts", "architecture-generated-artifacts.json"),
			JSON.stringify({
				version: 1,
				artifacts: [
					{
						path: "scripts/fake.ts",
						owner: "fixture-root",
						source: "src",
						generatedBy: "scripts/generate.ts",
					},
				],
			}),
		);
		expect(() => analyzeSourceTree({ root, sourceRoot: root })).toThrow(
			"does not write its exact output scripts/fake.ts",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("non-wildcard path aliases do not match longer specifiers", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-exact-alias-"));
	try {
		writeFileSync(
			join(root, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@core": ["./core"] } } }),
		);
		writeFileSync(join(root, "core.ts"), 'import { value } from "./consumer";\nexport const core = value;\n');
		writeFileSync(join(root, "consumer.ts"), 'import { core } from "@core-extra";\nexport const value = core;\n');
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.summary.runtimeCycles).toBe(0);
		expect(inventory.sourceEdges).toContainEqual(
			expect.objectContaining({ from: "consumer.ts", specifier: "@core-extra", to: null }),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("manifest output paths must match the generator's resolved write target", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-manifest-output-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@signet/sdk" }));
		mkdirSync(join(root, "platform", "daemon", "src"), { recursive: true });
		mkdirSync(join(root, "libs", "sdk", "scripts"), { recursive: true });
		mkdirSync(join(root, "libs", "sdk", "src", "generated"), { recursive: true });
		writeFileSync(join(root, "platform", "daemon", "src", "daemon.ts"), "export const daemon = true;\n");
		writeFileSync(
			join(root, "libs", "sdk", "scripts", "generate-client.ts"),
			'import { join } from "node:path";\nimport { writeFileSync } from "node:fs";\n// Architecture provenance: source=platform/daemon/src/daemon.ts\n// generated from daemon.ts\nwriteFileSync(join(__dirname, "..", "src", "generated", "client.ts"), "");\n',
		);
		writeFileSync(
			join(root, "client.ts"),
			"/**\n * AUTO-GENERATED FILE — DO NOT EDIT\n * Generated by generate-client.ts\n */\nexport const hidden = true;\n",
		);
		mkdirSync(join(root, "scripts"));
		writeFileSync(
			join(root, "scripts", "architecture-generated-artifacts.json"),
			JSON.stringify({
				version: 1,
				artifacts: [
					{
						path: "client.ts",
						owner: "@signet/sdk",
						source: "platform/daemon/src/daemon.ts",
						generatedBy: "libs/sdk/scripts/generate-client.ts",
					},
				],
			}),
		);
		expect(() => analyzeSourceTree({ root, sourceRoot: root })).toThrow("does not write its exact output client.ts");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("manifest output paths resolve new URL targets exactly", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-manifest-url-output-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-root" }));
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "scripts", "fake-dir"), { recursive: true });
		writeFileSync(join(root, "src", "real-source.ts"), "export const source = true;\n");
		writeFileSync(
			join(root, "scripts", "generate.ts"),
			[
				'import { readFileSync, writeFileSync } from "node:fs";',
				'import { join } from "node:path";',
				'import { fileURLToPath } from "node:url";',
				"// Architecture provenance: source=src/real-source.ts",
				'readFileSync(join(__dirname, "..", "src", "real-source.ts"), "utf8");',
				'const output = join(fileURLToPath(new URL("./fake-dir", import.meta.url)), "child.ts");',
				'writeFileSync(output, "");',
			].join("\n"),
		);
		writeFileSync(
			join(root, "scripts", "architecture-generated-artifacts.json"),
			JSON.stringify({
				version: 1,
				artifacts: [
					{
						path: "scripts/fake-dir/child.ts",
						owner: "fixture-root",
						source: "src/real-source.ts",
						generatedBy: "scripts/generate.ts",
					},
				],
			}),
		);
		expect(() => analyzeSourceTree({ root, sourceRoot: root })).not.toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("namespace-local manifest bindings do not shadow an outer write", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-manifest-namespace-scope-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-root" }));
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "scripts"));
		writeFileSync(join(root, "src", "real-source.ts"), "export const source = true;\n");
		writeFileSync(
			join(root, "scripts", "generate.ts"),
			[
				'import { writeFileSync } from "node:fs";',
				'import { join } from "node:path";',
				"// Architecture provenance: source=src/real-source.ts",
				'const output = join(__dirname, "real.ts");',
				"namespace Hidden {",
				'	const output = join(__dirname, "fake.ts");',
				"}",
				'writeFileSync(output, "");',
			].join("\n"),
		);
		writeFileSync(
			join(root, "scripts", "architecture-generated-artifacts.json"),
			JSON.stringify({
				version: 1,
				artifacts: [
					{
						path: "scripts/fake.ts",
						owner: "fixture-root",
						source: "src/real-source.ts",
						generatedBy: "scripts/generate.ts",
					},
				],
			}),
		);
		expect(() => analyzeSourceTree({ root, sourceRoot: root })).toThrow(
			"does not write its exact output scripts/fake.ts",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("materialized provenance rejects near-name generator headers", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-manifest-header-spoof-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-root" }));
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "scripts"));
		writeFileSync(join(root, "src", "real-source.ts"), "export const source = true;\n");
		writeFileSync(
			join(root, "scripts", "generate.ts"),
			[
				'import { writeFileSync } from "node:fs";',
				'import { join } from "node:path";',
				"// Architecture provenance: source=src/real-source.ts",
				'writeFileSync(join(__dirname, "..", "output.ts"), "");',
			].join("\n"),
		);
		writeFileSync(join(root, "output.ts"), "// Auto-generated by not-generate.ts\nexport const output = true;\n");
		writeFileSync(
			join(root, "scripts", "architecture-generated-artifacts.json"),
			JSON.stringify({
				version: 1,
				artifacts: [
					{
						path: "output.ts",
						owner: "fixture-root",
						source: "src/real-source.ts",
						generatedBy: "scripts/generate.ts",
					},
				],
			}),
		);
		expect(() => analyzeSourceTree({ root, sourceRoot: root })).toThrow("without a provenance header");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("generator provenance rejects comment-only source-name spoofing", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-manifest-source-spoof-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-root" }));
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "scripts"));
		writeFileSync(join(root, "src", "real-source.ts"), "export const source = true;\n");
		writeFileSync(
			join(root, "scripts", "generate.ts"),
			[
				'import { writeFileSync } from "node:fs";',
				'import { join } from "node:path";',
				"// generated from real-source.ts (comment only; source is never read)",
				'writeFileSync(join(__dirname, "..", "output.ts"), "");',
			].join("\n"),
		);
		writeFileSync(
			join(root, "scripts", "architecture-generated-artifacts.json"),
			JSON.stringify({
				version: 1,
				artifacts: [
					{
						path: "output.ts",
						owner: "fixture-root",
						source: "src/real-source.ts",
						generatedBy: "scripts/generate.ts",
					},
				],
			}),
		);
		expect(() => analyzeSourceTree({ root, sourceRoot: root })).toThrow("does not identify its source");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("canonical createRequire aliases participate in runtime cycle detection", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-create-require-alias-cycle-"));
	try {
		writeFileSync(
			join(root, "loader.ts"),
			[
				'import { createRequire } from "node:module";',
				"const esmRequire = createRequire(import.meta.url);",
				'esmRequire("./target");',
			].join("\n"),
		);
		writeFileSync(join(root, "target.ts"), 'import "./loader";\nexport const target = true;\n');
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceEdges).toContainEqual(
			expect.objectContaining({ kind: "require", specifier: "./target", to: "target.ts", runtime: true }),
		);
		expect(inventory.computedLoads).toHaveLength(0);
		expect(inventory.summary.runtimeCycles).toBe(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inherited tsconfig aliases participate in runtime SCC detection", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-inherited-alias-cycle-"));
	try {
		mkdirSync(join(root, "configs"));
		mkdirSync(join(root, "pkg"));
		writeFileSync(
			join(root, "configs", "tsconfig.base.json"),
			JSON.stringify({ compilerOptions: { baseUrl: "..", paths: { "@/*": ["pkg/*"] } } }),
		);
		writeFileSync(join(root, "pkg", "tsconfig.json"), JSON.stringify({ extends: "../configs/tsconfig.base.json" }));
		writeFileSync(join(root, "pkg", "a.ts"), 'import { b } from "@/b";\nexport const a = b;\n');
		writeFileSync(join(root, "pkg", "b.ts"), 'import { a } from "@/a";\nexport const b = a;\n');
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceEdges.filter((edge) => edge.to !== null)).toHaveLength(2);
		expect(inventory.sourceEdges.filter((edge) => edge.to === null)).toHaveLength(0);
		expect(inventory.summary.runtimeCycles).toBe(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("invalid tsconfig files fail closed instead of dropping path aliases", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-invalid-tsconfig-"));
	try {
		writeFileSync(join(root, "tsconfig.json"), "{ invalid json");
		writeFileSync(join(root, "entry.ts"), "export const entry = true;\n");
		expect(() => analyzeSourceTree({ root, sourceRoot: root })).toThrow(
			"Unable to read TypeScript configuration tsconfig.json",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test(".cts and .mts modules are inventoried and resolved as runtime edges", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-cts-mts-cycle-"));
	try {
		writeFileSync(join(root, "loader.cts"), 'import "./target.mts";\nexport const loader = true;\n');
		writeFileSync(join(root, "target.mts"), 'import "./loader.cts";\nexport const target = true;\n');
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceFiles.map((file) => file.path)).toEqual(["loader.cts", "target.mts"]);
		expect(inventory.sourceEdges.filter((edge) => edge.to !== null)).toHaveLength(2);
		expect(inventory.summary.runtimeCycles).toBe(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("unmanifested marker text in strings and trailing comments is not generated debt", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-marker-false-positive-"));
	try {
		writeFileSync(
			join(root, "source.ts"),
			[
				'export const stringMarker = "AUTO-GENERATED FILE";',
				"export const templateMarker = `Auto-generated by a tool`;",
				"export const trailingComment = true; // AUTO-GENERATED from a tool",
			].join("\n"),
		);
		expect(() => analyzeSourceTree({ root, sourceRoot: root })).not.toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("type-escape counts only actual TypeScript suppression directives", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-type-escape-trivia-"));
	try {
		writeFileSync(
			join(root, "source.ts"),
			[
				'export const stringMarker = "@ts-ignore";',
				"// prose mentioning @ts-expect-error is not a directive",
				"// @ts-ignore intentional test fixture",
				"/* @ts-expect-error another intentional fixture */",
			].join("\n"),
		);
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceFiles[0]?.typeEscapes).toBe(2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pull-request ratchets compare against the protected base, not a refreshed local baseline", () => {
	const protectedBaseline = loadBaseline();
	const first = protectedBaseline.sourceFiles[0];
	expect(first).toBeDefined();
	if (first === undefined) return;
	const debtAddedToCheckout = {
		...protectedBaseline,
		sourceFiles: protectedBaseline.sourceFiles.map((module) =>
			module.path === first.path ? { ...module, logicalStatements: module.logicalStatements + 1 } : module,
		),
	};
	const locallyRefreshedBaseline = canonicalizeBaselineInventory(debtAddedToCheckout);
	expect(compareArchitectureRatchet(debtAddedToCheckout, locallyRefreshedBaseline)).toEqual([]);
	expect(compareArchitectureRatchet(debtAddedToCheckout, protectedBaseline)).toContain(
		`module growth in ${first.path}: ${first.logicalStatements} -> ${first.logicalStatements + 1} logical statements`,
	);
});

test("canonical createRequire factory and result aliases retain runtime provenance", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-create-require-forms-"));
	try {
		writeFileSync(join(root, "target.ts"), 'import "./loader";\nexport const target = true;\n');
		const forms = [
			["let result", "let req = createRequire(import.meta.url);"],
			["var result", "var req = createRequire(import.meta.url);"],
			[
				"namespace result",
				'import * as module from "node:module";\nconst req = module.createRequire(import.meta.url);',
			],
			[
				"namespace factory alias",
				'import * as module from "node:module";\nconst factory = module.createRequire;\nconst req = factory(import.meta.url);',
			],
			["factory alias", "const factory = createRequire;\nconst req = factory(import.meta.url);"],
		] as const;
		for (const [name, declaration] of forms) {
			writeFileSync(
				join(root, "loader.ts"),
				[
					...(name.startsWith("namespace") ? [] : ['import { createRequire } from "node:module";']),
					declaration,
					'req("./target");',
				].join("\n"),
			);
			const inventory = analyzeSourceTree({ root, sourceRoot: root });
			expect(inventory.computedLoads, name).toHaveLength(0);
			expect(inventory.sourceEdges, name).toContainEqual(
				expect.objectContaining({ kind: "require", specifier: "./target", to: "target.ts", runtime: true }),
			);
			expect(inventory.summary.runtimeCycles, name).toBe(1);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("createRequire assignments and default parameters retain runtime provenance", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-create-require-assignment-"));
	try {
		writeFileSync(join(root, "target.ts"), 'import "./loader";\nexport const target = true;\n');
		writeFileSync(
			join(root, "loader.ts"),
			[
				'import { createRequire } from "node:module";',
				"let factory;",
				"factory = createRequire;",
				"let req;",
				"req = factory(import.meta.url);",
				'req("./target");',
				"function load(factory = createRequire, req = factory(import.meta.url)) {",
				'	req("./target");',
				"}",
				"load();",
			].join("\n"),
		);
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceEdges.filter((edge) => edge.kind === "require" && edge.to === "target.ts")).toHaveLength(2);
		expect(inventory.computedLoads.filter((load) => load.kind === "require")).toHaveLength(0);
		expect(inventory.summary.runtimeCycles).toBe(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("destructuring assignments propagate canonical loader provenance", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-loader-destructuring-assignment-"));
	try {
		writeFileSync(join(root, "target.ts"), 'import "./loader";\nexport const target = true;\n');
		writeFileSync(
			join(root, "loader.ts"),
			[
				'import { createRequire } from "node:module";',
				"let ambient;",
				"({ ambient } = { ambient: require });",
				'ambient("./target");',
				"let req;",
				"[req] = [createRequire(import.meta.url)];",
				'req("./target");',
			].join("\n"),
		);
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceEdges.filter((edge) => edge.kind === "require" && edge.to === "target.ts")).toHaveLength(2);
		expect(inventory.computedLoads.filter((load) => load.kind === "require")).toHaveLength(0);
		expect(inventory.summary.runtimeCycles).toBe(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reassigned createRequire result aliases remain visible as computed loads", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-create-require-reassignment-"));
	try {
		writeFileSync(join(root, "target.ts"), "export const target = true;\n");
		writeFileSync(
			join(root, "loader.ts"),
			[
				'import { createRequire } from "node:module";',
				"let req = createRequire(import.meta.url);",
				"req = (_path: string) => undefined;",
				'req("./target");',
			].join("\n"),
		);
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceEdges).not.toContainEqual(expect.objectContaining({ kind: "require", to: "target.ts" }));
		expect(inventory.computedLoads).toContainEqual(expect.objectContaining({ kind: "require", path: "loader.ts" }));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reassigned createRequire factory aliases conservatively retain result loads", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-create-require-factory-reassignment-"));
	try {
		writeFileSync(join(root, "target.ts"), "export const target = true;\n");
		writeFileSync(
			join(root, "loader.ts"),
			[
				'import { createRequire } from "node:module";',
				"let factory = createRequire;",
				"factory = (_url: string) => (_path: string) => undefined;",
				"const req = factory(import.meta.url);",
				'req("./target");',
			].join("\n"),
		);
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceEdges).not.toContainEqual(expect.objectContaining({ kind: "require", to: "target.ts" }));
		expect(inventory.computedLoads).toContainEqual(expect.objectContaining({ kind: "require", path: "loader.ts" }));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("destructuring and loop assignment targets invalidate createRequire results and factories", () => {
	const cases = [
		["object result", "let req = createRequire(import.meta.url);\n({ req } = fake);\n"],
		["array result", "let req = createRequire(import.meta.url);\n[req] = [fake];\n"],
		["for-of result", "let req = createRequire(import.meta.url);\nfor (req of values) {}\n"],
		["for-in result", "let req = createRequire(import.meta.url);\nfor (req in values) {}\n"],
		["object factory", "let factory = createRequire;\n({ factory } = fake);\nconst req = factory(import.meta.url);\n"],
		["array factory", "let factory = createRequire;\n[factory] = [fake];\nconst req = factory(import.meta.url);\n"],
		[
			"for-of factory",
			"let factory = createRequire;\nfor (factory of values) {}\nconst req = factory(import.meta.url);\n",
		],
		[
			"for-in factory",
			"let factory = createRequire;\nfor (factory in values) {}\nconst req = factory(import.meta.url);\n",
		],
	] as const;
	for (const [name, reassignment] of cases) {
		const root = mkdtempSync(join(tmpdir(), `architecture-create-require-${name.replaceAll(" ", "-")}-`));
		try {
			writeFileSync(join(root, "target.ts"), 'import "./loader";\nexport const target = true;\n');
			writeFileSync(
				join(root, "loader.ts"),
				['import { createRequire } from "node:module";', reassignment, 'req("./target");'].join("\n"),
			);
			const inventory = analyzeSourceTree({ root, sourceRoot: root });
			expect(inventory.sourceEdges, name).not.toContainEqual(
				expect.objectContaining({ kind: "require", to: "target.ts", runtime: true }),
			);
			expect(inventory.computedLoads, name).toContainEqual(
				expect.objectContaining({ kind: "require", path: "loader.ts" }),
			);
			expect(inventory.summary.runtimeCycles, name).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("tracked TypeScript under target, build, and built remains in the audited source graph", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-excluded-source-directories-"));
	try {
		for (const directory of ["target", "build", "built"]) {
			mkdirSync(join(root, directory));
			writeFileSync(join(root, directory, "entry.ts"), `import "./hidden";\nexport const entry = true;\n`);
			writeFileSync(join(root, directory, "hidden.ts"), `import "./entry";\nexport const hidden = true;\n`);
		}
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceFiles.map((file) => file.path)).toEqual([
			"build/entry.ts",
			"build/hidden.ts",
			"built/entry.ts",
			"built/hidden.ts",
			"target/entry.ts",
			"target/hidden.ts",
		]);
		expect(inventory.summary.runtimeCycles).toBe(3);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("generated-looking TypeScript under excluded directory names is validated", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-excluded-generated-source-"));
	try {
		mkdirSync(join(root, "target"));
		writeFileSync(join(root, "target", "hidden.ts"), "// AUTO-GENERATED FILE\nexport const hidden = true;\n");
		expect(() => analyzeSourceTree({ root, sourceRoot: root })).toThrow(
			"Generated artifact target/hidden.ts matches generated-marker",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("path aliases apply to every file in the parsed project, including external files", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-external-alias-cycle-"));
	try {
		mkdirSync(join(root, "pkg"));
		mkdirSync(join(root, "shared"));
		writeFileSync(
			join(root, "pkg", "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { baseUrl: "..", paths: { "@/*": ["shared/*"] } },
				include: ["../shared/**/*.ts"],
			}),
		);
		writeFileSync(join(root, "shared", "a.ts"), 'import { b } from "@/b";\nexport const a = b;\n');
		writeFileSync(join(root, "shared", "b.ts"), 'import { a } from "@/a";\nexport const b = a;\n');
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceEdges.filter((edge) => edge.to !== null)).toHaveLength(2);
		expect(inventory.sourceEdges.filter((edge) => edge.to === null)).toHaveLength(0);
		expect(inventory.summary.runtimeCycles).toBe(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("explicit cjs and mjs specifiers prefer their TypeScript counterparts before generic sources", () => {
	const root = mkdtempSync(join(tmpdir(), "architecture-explicit-module-counterparts-"));
	try {
		writeFileSync(join(root, "loader.cts"), 'import "./target.cjs";\nexport const loader = true;\n');
		writeFileSync(join(root, "target.cts"), 'import "./loader.cts";\nexport const target = true;\n');
		writeFileSync(join(root, "target.ts"), "export const collision = true;\n");
		writeFileSync(join(root, "loader.mts"), 'import "./other.mjs";\nexport const loader = true;\n');
		writeFileSync(join(root, "other.mts"), 'import "./loader.mts";\nexport const other = true;\n');
		writeFileSync(join(root, "other.ts"), "export const collision = true;\n");
		const inventory = analyzeSourceTree({ root, sourceRoot: root });
		expect(inventory.sourceEdges).toContainEqual(
			expect.objectContaining({ from: "loader.cts", specifier: "./target.cjs", to: "target.cts" }),
		);
		expect(inventory.sourceEdges).toContainEqual(
			expect.objectContaining({ from: "loader.mts", specifier: "./other.mjs", to: "other.mts" }),
		);
		expect(inventory.summary.runtimeCycles).toBe(2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
