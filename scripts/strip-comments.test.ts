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

test("preserves semantic directives, shebangs, and legal notices", () => {
	const source = [
		"#!/usr/bin/env bun",
		"// @ts-expect-error LEGACY_SYNC_DB_ACCESS",
		"legacyCall();",
		"// biome-ignore lint/suspicious/noExplicitAny: boundary",
		"const value: any = input;",
		"//# sourceMappingURL=index.js.map",
		"// Copyright 2026 Signet AI",
		"const joined = left/* prose */right;",
	].join("\n");
	const result = stripComments(source, "src/example.ts");
	expect(result.removed).toBe(1);
	expect(result.content).toContain("@ts-expect-error LEGACY_SYNC_DB_ACCESS");
	expect(result.content).toContain("biome-ignore lint/suspicious/noExplicitAny");
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
