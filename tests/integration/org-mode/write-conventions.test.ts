import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import ts from "typescript";

const root = resolve(import.meta.dir, "../../..");
function source(path: string): ts.SourceFile {
	return ts.createSourceFile(path, readFileSync(resolve(root, path), "utf8"), ts.ScriptTarget.Latest, true);
}
function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
	inspect(node);
	ts.forEachChild(node, (child) => visit(child, inspect));
}
test("tracked test descriptions do not contain lane labels", () => {
	const paths = execFileSync("git", ["ls-files", "*.test.ts"], { cwd: root, encoding: "utf8" })
		.trim()
		.split("\n")
		.filter((path) => path.endsWith(".test.ts"));
	const labels: string[] = [];
	for (const path of paths)
		visit(source(path), (node) => {
			if (!ts.isCallExpression(node)) return;
			const name = node.expression.getText();
			if (!/^(test|it|describe)(\.|$)/.test(name)) return;
			const title = node.arguments[0];
			if (title && ts.isStringLiteralLike(title) && /\b(?:L[0-5]|l[0-5]-review-authors)\b/.test(title.text))
				labels.push(`${path}: ${title.text}`);
		});
	expect(labels).toEqual([]);
});
test("purge composite keys are built without string replacement", () => {
	const replacements: string[] = [];
	visit(source("platform/core/src/migrations/177-classifications.ts"), (node) => {
		if (!ts.isFunctionDeclaration(node) || node.name?.text !== "installEvidencePurgeLifecycle") return;
		visit(node, (child) => {
			if (
				ts.isCallExpression(child) &&
				ts.isPropertyAccessExpression(child.expression) &&
				["replace", "replaceAll"].includes(child.expression.name.text)
			)
				replacements.push(child.expression.getText());
		});
	});
	expect(replacements).toEqual([]);
});
test("source indexing cannot invent a daemon agent for an unadopted source", () => {
	const fallbacks: string[] = [];
	visit(source("platform/daemon/src/routes/sources-routes.ts"), (node) => {
		if (!ts.isFunctionDeclaration(node) || node.name?.text !== "executeSourceIndexJob") return;
		visit(node, (child) => {
			if (ts.isCallExpression(child) && child.expression.getText() === "resolveDaemonAgentId")
				fallbacks.push(child.getText());
		});
	});
	expect(fallbacks).toEqual([]);
});
test("denied-write sweep detects updates that preserve table row counts", () => {
	const file = source("tests/integration/org-mode/l4-write-sweep.test.ts");
	let initializer: string | undefined;
	visit(file, (node) => {
		if (ts.isVariableDeclaration(node) && node.name.getText() === "snapshot" && node.initializer)
			initializer = node.initializer.getText(file);
	});
	if (!initializer) throw new Error("Missing denied-write snapshot");
	const js = ts.transpileModule(`const snapshot=${initializer};`, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
	}).outputText;
	const factory = new Function("sweep", "assert", "createHash", `${js}\nreturn snapshot;`);
	const db = new Database(":memory:");
	try {
		db.exec("CREATE TABLE memories(id TEXT PRIMARY KEY,content TEXT);INSERT INTO memories VALUES('evidence','before')");
		const snapshot: unknown = Reflect.apply(factory, undefined, [
			{ read: (callback: (db: Database) => unknown) => callback(db) },
			assert,
			createHash,
		]);
		if (typeof snapshot !== "function") throw new Error("Invalid snapshot");
		const before: unknown = Reflect.apply(snapshot, undefined, []);
		db.exec("UPDATE memories SET content='after' WHERE id='evidence'");
		expect(Reflect.apply(snapshot, undefined, [])).not.toEqual(before);
	} finally {
		db.close();
	}
});
