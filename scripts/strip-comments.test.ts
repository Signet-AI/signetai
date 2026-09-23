import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCommentPurgePath, stripComments } from "./strip-comments";

test("strips TypeScript comments without changing comment-like syntax", () => {
	const source = [
		"const before = 1; // explanation",
		"const url = 'https://example.com/path';",
		"const pattern = /https?:\\/\\/example/;",
		"const text = `/* not a comment */`;",
		"/* block",
		" * explanation",
		" */",
		"const after = before + 1;",
	].join("\n");
	const result = stripComments(source, "src/example.ts");
	expect(result.removed).toBe(2);
	expect(result.content).toBe(
		[
			"const before = 1;",
			"const url = 'https://example.com/path';",
			"const pattern = /https?:\\/\\/example/;",
			"const text = `/* not a comment */`;",
			"const after = before + 1;",
		].join("\n"),
	);
});

test("removes complete comment lines and adjacent trailing whitespace", () => {
	const source = [
		"// explanation",
		"const first = 1; // explanation",
		"/* explanation",
		" * continued",
		" */",
		"const second = 2;",
		"",
	].join("\n");
	const result = stripComments(source, "src/example.ts");
	expect(result.removed).toBe(3);
	expect(result.content).toBe(["const first = 1;", "const second = 2;", ""].join("\n"));
	expect(result.content.split("\n").some((line: string) => /\s+$/.test(line))).toBeFalse();
});

test("refreshes line-based database site tokens after comments shift source lines", () => {
	const source = [
		"// heading",
		'getDbAccessor().withReadDb(() => value, "nested/example.ts:2");',
		'getDbAccessor().withReadDbAsync(() => value, { siteToken: "nested/example.ts:3" });',
		'const report = await readDiagnostics("nested/example.ts:4");',
		'getDbAccessor().withWriteTxAsync(() => value, { siteToken: "db:stable.write" });',
	].join("\n");
	const result = stripComments(source, "platform/daemon/src/nested/example.ts");
	expect(result.content).toContain('withReadDb(() => value, "nested/example.ts:1")');
	expect(result.content).toContain('siteToken: "nested/example.ts:2"');
	expect(result.content).toContain('readDiagnostics("nested/example.ts:3")');
	expect(result.content).toContain('siteToken: "db:stable.write"');
});

test("does not leave extra blank lines at file boundaries or around removed sections", () => {
	const cases = [
		{ source: "[test]\n\n# explanation\n", path: "bunfig.toml", expected: "[test]\n" },
		{ source: "// explanation\n\nconst value = 1;\n", path: "src/example.ts", expected: "const value = 1;\n" },
		{
			source: "const before = 1;\n\n// explanation\n\nconst after = 2;\n",
			path: "src/example.ts",
			expected: "const before = 1;\n\nconst after = 2;\n",
		},
	] as const;
	for (const sample of cases) expect(stripComments(sample.source, sample.path).content).toBe(sample.expected);
});

test("preserves semantic directives, shebangs, and legal notices", () => {
	const source = [
		"#!/usr/bin/env bun",
		"// @ts-expect-error LEGACY_SYNC_DB_ACCESS",
		"legacyCall();",
		"// biome-ignore lint/suspicious/noExplicitAny: boundary",
		"const value: any = input;",
		"// DYNAMIC_SITE_TOKEN: runtime caller attribution",
		"//# sourceMappingURL=index.js.map",
		"// Copyright 2026 Signet AI",
		"const joined = left/* prose */right;",
	].join("\n");
	const result = stripComments(source, "src/example.ts");
	expect(result.removed).toBe(1);
	expect(result.content).toContain("@ts-expect-error LEGACY_SYNC_DB_ACCESS");
	expect(result.content).toContain("biome-ignore lint/suspicious/noExplicitAny");
	expect(result.content).toContain("DYNAMIC_SITE_TOKEN: runtime caller attribution");
	expect(result.content).toContain("//# sourceMappingURL=index.js.map");
	expect(result.content).toContain("// Copyright 2026 Signet AI");
	expect(result.content).toContain("left right");
	expect(stripComments(result.content, "src/example.ts")).toEqual({ content: result.content, removed: 0 });
});

test("strips hash comments without touching quoted hashes or directives", () => {
	const python = [
		"#!/usr/bin/env python3",
		"# explanation",
		"value = '# not a comment' # trailing",
		"other = 1  # type: ignore[arg-type]",
		'block = """# inside a string"""',
	].join("\n");
	const result = stripComments(python, "tools/example.py");
	expect(result.removed).toBe(2);
	expect(result.content).toBe(
		[
			"#!/usr/bin/env python3",
			"value = '# not a comment'",
			"other = 1  # type: ignore[arg-type]",
			'block = """# inside a string"""',
		].join("\n"),
	);

	const yaml = [
		"name: signet # explanation",
		'url: "https://example.com/#fragment"',
		"# yamllint disable rule:line-length",
	].join("\n");
	const yamlResult = stripComments(yaml, ".github/example.yml");
	expect(yamlResult.removed).toBe(1);
	expect(yamlResult.content).toContain("name: signet");
	expect(yamlResult.content).toContain("# yamllint disable");
});

test("preserves hashes inside YAML block scalar payloads", () => {
	const source = [
		"# explanation",
		"message: |",
		"  # literal payload",
		"  text # still payload",
		"next: value # explanation",
		"folded: >-",
		"  text",
		"  # folded payload",
		"# explanation",
		"done: true",
	].join("\n");
	const result = stripComments(source, "config/example.yml");
	expect(result.removed).toBe(3);
	expect(result.content).toBe(
		[
			"message: |",
			"  # literal payload",
			"  text # still payload",
			"next: value",
			"folded: >-",
			"  text",
			"  # folded payload",
			"done: true",
		].join("\n"),
	);
});

test("strips shell comments from YAML run blocks without changing heredoc payloads", () => {
	const source = [
		"steps:",
		"  - run: |",
		"      # explanation",
		"      cat <<'EOF'",
		"      # literal payload",
		"      EOF",
		'      read value <<< "$input"',
		"      # explanation after here-string",
		"      echo done # explanation",
	].join("\n");
	const result = stripComments(source, ".github/workflows/example.yml");
	expect(result.removed).toBe(3);
	expect(result.content).not.toContain("# explanation");
	expect(result.content).toContain("      # literal payload");
});

test("preserves hashes inside shell and Dockerfile heredoc payloads", () => {
	const shell = [
		"#!/bin/sh",
		"# explanation",
		"cat <<'EOF'",
		"# literal payload",
		"value # still payload",
		"EOF",
		"echo done # explanation",
	].join("\n");
	const shellResult = stripComments(shell, "scripts/example.sh");
	expect(shellResult.removed).toBe(2);
	expect(shellResult.content).toContain("# literal payload\nvalue # still payload");

	const dockerfile = ["RUN <<-EOF", "	# literal payload", "	EOF", "# explanation"].join("\n");
	const dockerResult = stripComments(dockerfile, "deploy/Dockerfile");
	expect(dockerResult.removed).toBe(1);
	expect(dockerResult.content).toContain("	# literal payload");
});

test("recognizes shell operator comment boundaries without changing parameter expansion", () => {
	const parameterExpansion = 'echo "${' + 'value#prefix}"';
	const source = ["echo ok;# explanation", "echo ok &&# explanation", `${parameterExpansion} # explanation`].join("\n");
	const result = stripComments(source, "scripts/example.sh");
	expect(result.removed).toBe(3);
	expect(result.content).toBe(["echo ok;", "echo ok &&", parameterExpansion].join("\n"));
});

test("limits shell operator comment boundaries to YAML run blocks", () => {
	const source = ["value: foo;# literal", "run: |", "  echo ok;# explanation"].join("\n");
	const result = stripComments(source, ".github/workflows/example.yml");
	expect(result.removed).toBe(1);
	expect(result.content).toContain("value: foo;# literal");
	expect(result.content).toContain("  echo ok;");
});

test("strips C-family, CSS, JSONC, and SQL comments without changing literals", () => {
	const rust = [
		'let url = "https://example.com"; // explanation',
		'let raw = r#"/* not a comment */"#;',
		"let value = left/* prose */right;",
	].join("\n");
	const rustResult = stripComments(rust, "platform/native/src/example.rs");
	expect(rustResult.removed).toBe(2);
	expect(rustResult.content).toContain('let url = "https://example.com";');
	expect(rustResult.content).toContain('r#"/* not a comment */"#');
	expect(rustResult.content).toContain("left right");

	const css = '.card { background: url("https://example.com/a/*literal*/"); /* explanation */ color: red; }';
	const cssResult = stripComments(css, "web/style.css");
	expect(cssResult.removed).toBe(1);
	expect(cssResult.content).toContain('url("https://example.com/a/*literal*/")');

	const sql = ["SELECT '-- literal' AS value; -- explanation", "SELECT 1 /* prose */ + 2;"].join("\n");
	const sqlResult = stripComments(sql, "platform/core/schema.sql");
	expect(sqlResult.removed).toBe(2);
	expect(sqlResult.content).toContain("SELECT '-- literal' AS value;");
	expect(sqlResult.content).toContain("SELECT 1  + 2;");
});

test("strips Astro frontmatter, markup, expression, script, and style comments", () => {
	const source = [
		"---",
		"// explanation",
		"const url = 'https://example.com';",
		"---",
		"<!-- explanation -->",
		"<div>{/* explanation */}</div>",
		"<script>const value = '// literal'; // explanation</script>",
		"<style>.card { color: red; /* explanation */ }</style>",
	].join("\n");
	const result = stripComments(source, "web/page.astro");
	expect(result.removed).toBe(5);
	expect(result.content).toContain("const url = 'https://example.com';");
	expect(result.content).toContain("<div>{}</div>");
	expect(result.content).toContain("const value = '// literal';");
	expect(result.content).not.toContain("explanation");
});

test("selects maintained source, tests, scripts, and configs only", () => {
	const included = [
		"platform/core/src/index.ts",
		"platform/core/src/index.test.ts",
		"scripts/release.sh",
		".github/workflows/ci.yml",
		"web/marketing/src/page.astro",
		"web/marketing/public/index.html",
		"surfaces/dashboard/src/style.css",
		"surfaces/desktop/build/entitlements.mac.plist",
		"web/marketing/public/install.ps1",
		"deploy/docker/Dockerfile",
		".githooks/pre-commit",
		"surfaces/cli/templates/agent.yaml.template",
		"integrations/example/plugin.cjs",
	];
	const excluded = [
		"dist/signetai/index.js",
		"integrations/forge/connector/dist/index.js",
		"libs/sdk/src/generated/client.ts",
		"platform/native/Cargo.lock",
		"bun.lock",
		"references/example.ts",
		"vendor/library.js",
		"scripts/vector-repair-compiled-fixture.ts",
		"THIRD_PARTY_LICENSES.md",
		"LICENSE",
		"docs/guide.md",
		"web/docs/src/content/docs/guide.mdx",
		"docs/example.ts",
		"web/docs/src/content.config.ts",
		"assets/style.css",
		"image.png",
		"web/public/logo.svg",
		"web/marketing/public/redesign-home-mockup.html",
		"platform/core/src/child-process.ts",
		"src/generated-client.ts",
		"generated.ts",
	];
	for (const path of included) expect(isCommentPurgePath(path), path).toBeTrue();
	for (const path of excluded) expect(isCommentPurgePath(path), path).toBeFalse();
});

test("strips HTML, XML, PowerShell, and extensionless config comments", () => {
	const html =
		"<!-- explanation --><script>const value = '// literal'; // explanation\n</script><style>/* explanation */</style>";
	const htmlResult = stripComments(html, "web/index.html");
	expect(htmlResult.removed).toBe(3);
	expect(htmlResult.content).toContain("const value = '// literal';");

	const xmlResult = stripComments("<plist><!-- explanation --><dict/></plist>", "build/app.plist");
	expect(xmlResult).toEqual({ content: "<plist><dict/></plist>", removed: 1 });

	const powerShell = [
		"#requires -Version 7",
		"<# explanation #>",
		"$url = 'https://example.com/#fragment' # explanation",
	].join("\n");
	const powerShellResult = stripComments(powerShell, "install.ps1");
	expect(powerShellResult.removed).toBe(2);
	expect(powerShellResult.content).toContain("#requires -Version 7");
	expect(powerShellResult.content).toContain("'https://example.com/#fragment'");

	const dockerfile = ["# syntax=docker/dockerfile:1", "# explanation", "FROM alpine # explanation"].join("\n");
	const dockerResult = stripComments(dockerfile, "deploy/docker/Dockerfile");
	expect(dockerResult.removed).toBe(2);
	expect(dockerResult.content).toContain("# syntax=docker/dockerfile:1");
});

test("check and write modes operate on tracked eligible files deterministically", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-strip-comments-"));
	try {
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "dist"));
		writeFileSync(join(root, "src/example.ts"), "// explanation\nexport const value = 1;\n");
		writeFileSync(join(root, "src/untracked.ts"), "// untracked\nexport const value = 2;\n");
		writeFileSync(join(root, "dist/example.ts"), "// generated\nexport const value = 3;\n");
		expect(Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: root }).exitCode).toBe(0);
		expect(Bun.spawnSync({ cmd: ["git", "add", "src/example.ts", "dist/example.ts"], cwd: root }).exitCode).toBe(0);
		const script = fileURLToPath(new URL("./strip-comments.ts", import.meta.url));
		const check = Bun.spawnSync({ cmd: [process.execPath, script, "--check"], cwd: root });
		expect(check.exitCode).toBe(1);
		expect(check.stdout.toString()).toContain("src/example.ts");
		expect(check.stdout.toString()).toContain("1 file would change");
		const write = Bun.spawnSync({ cmd: [process.execPath, script, "--write"], cwd: root });
		expect(write.exitCode).toBe(0);
		expect(write.stdout.toString()).toContain("1 file changed");
		expect(readFileSync(join(root, "src/example.ts"), "utf8")).toBe("export const value = 1;\n");
		expect(readFileSync(join(root, "src/untracked.ts"), "utf8")).toContain("// untracked");
		expect(readFileSync(join(root, "dist/example.ts"), "utf8")).toContain("// generated");
		expect(Bun.spawnSync({ cmd: [process.execPath, script, "--check"], cwd: root }).exitCode).toBe(0);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("package scripts expose stable check and write commands", () => {
	const packageSource = readFileSync(join(import.meta.dir, "../package.json"), "utf8");
	expect(packageSource).toContain('"comments:check": "bun scripts/strip-comments.ts --check"');
	expect(packageSource).toContain('"comments:write": "bun scripts/strip-comments.ts --write"');
});

test("preserves compiler, bundler, coverage, and language-server directives", () => {
	const typeScript = [
		'/// <reference types="vite/client" />',
		"// @vitest-environment jsdom",
		"const value = /* @__PURE__ */ factory();",
	].join("\n");
	expect(stripComments(typeScript, "src/env.d.ts")).toEqual({ content: typeScript, removed: 0 });
	const python = ["if unavailable:  # pragma: no cover", "# ruff: noqa"].join("\n");
	expect(stripComments(python, "plugin.py")).toEqual({ content: python, removed: 0 });
	const yaml = "# yaml-language-server: $schema=https://example.com/schema.json";
	expect(stripComments(yaml, "config.yml")).toEqual({ content: yaml, removed: 0 });
	const yamlHuman = ["# coding:", "# fmt: prose"].join("\n");
	expect(stripComments(yamlHuman, "config.yml")).toEqual({ content: "", removed: 2 });
	const pythonEncoding = "# -*- coding: utf-8 -*-";
	expect(stripComments(pythonEncoding, "plugin.py")).toEqual({ content: pythonEncoding, removed: 0 });
	const docker = "# check=error=true";
	expect(stripComments(docker, "Dockerfile")).toEqual({ content: docker, removed: 0 });
});

test("does not mistake regular expressions or JSX text for comments", () => {
	const source = [
		"const expression = /[//]/; // explanation",
		'const view = <a href="https://example.com">// visible text</a>; // explanation',
	].join("\n");
	const result = stripComments(source, "src/view.tsx");
	expect(result.removed).toBe(2);
	expect(result.content).toBe(
		["const expression = /[//]/;", 'const view = <a href="https://example.com">// visible text</a>;'].join("\n"),
	);
});

test("distinguishes Rust character literals from lifetimes", () => {
	const source = ["let letter = 'a'; // explanation", "fn borrow<'a>(value: &'a str) {} // explanation"].join("\n");
	const result = stripComments(source, "platform/native/src/lib.rs");
	expect(result.removed).toBe(2);
	expect(result.content).toBe(["let letter = 'a';", "fn borrow<'a>(value: &'a str) {}"].join("\n"));
});
