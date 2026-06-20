#!/usr/bin/env bun
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

type Convertibility = "http-db" | "http-files" | "state-only" | "provider-mocked" | "runtime-specific";

type Signal = {
	line: number;
	kind: string;
	snippet: string;
};

type ManifestEntry = {
	behavior?: string;
	parityClassification?: string;
	nearestRustBehavior?: string;
	manifestFamily?: string;
};

type ReplayInventoryCase = {
	id: string;
	source: {
		file: string;
		testName: string;
		line: number;
	};
	behavioralFamily: string;
	convertibility: Convertibility;
	manifest?: ManifestEntry;
	detected: {
		routeStrings: string[];
		httpCalls: Signal[];
		dbSeedCalls: Signal[];
		fileSetup: Signal[];
		envSetup: Signal[];
		timerSetup: Signal[];
		providerMocks: Signal[];
	};
};

const repoRoot = process.cwd();
const testsRoot = join(repoRoot, "platform/daemon/src");
const manifestPath = join(repoRoot, "platform/daemon-rs/parity/03-test-corpus-manifest.md");
const outputPath = join(repoRoot, "platform/daemon-rs/contracts/replay-corpus/inventory.json");
const expectedTestFileCount = 167;

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(full);
	}
	return out;
}

function parseManifest(): Map<string, ManifestEntry> {
	const entries = new Map<string, ManifestEntry>();
	const markdown = readFileSync(manifestPath, "utf8");
	for (const line of markdown.split(/\r?\n/)) {
		const match = line.match(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/);
		if (!match) continue;
		const [, file, behavior, parityClassification, nearestRustBehavior] = match;
		entries.set(file, {
			behavior: behavior.trim(),
			parityClassification: parityClassification.trim(),
			nearestRustBehavior: nearestRustBehavior.trim(),
		});
	}

	let currentFamily: string | null = null;
	for (const line of markdown.split(/\r?\n/)) {
		const heading = line.match(/^### (.+?) \(\d+\)$/);
		if (heading) {
			currentFamily = heading[1].trim();
			continue;
		}
		const bullet = line.match(/^- `([^`]+)` - /);
		if (currentFamily && bullet) {
			const existing = entries.get(bullet[1]) ?? {};
			entries.set(bullet[1], { ...existing, manifestFamily: currentFamily });
		}
	}
	return entries;
}

function callName(expr: ts.Expression): string {
	if (ts.isIdentifier(expr)) return expr.text;
	if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
	if (ts.isCallExpression(expr)) return callName(expr.expression);
	return expr.getText();
}

function bunTestBaseName(expr: ts.Expression): "describe" | "test" | "it" | null {
	if (ts.isIdentifier(expr)) {
		return expr.text === "describe" || expr.text === "test" || expr.text === "it" ? expr.text : null;
	}
	if (ts.isPropertyAccessExpression(expr)) return bunTestBaseName(expr.expression);
	if (ts.isCallExpression(expr)) return bunTestBaseName(expr.expression);
	return null;
}

function stringValue(node: ts.Node | undefined): string | null {
	if (!node) return null;
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	return null;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
	return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function snippet(sourceFile: ts.SourceFile, node: ts.Node): string {
	return node
		.getText(sourceFile)
		.replace(/\s+/g, " ")
		.slice(0, 180);
}

function addSignal(target: Signal[], sourceFile: ts.SourceFile, node: ts.Node, kind: string): void {
	const signal = { line: lineOf(sourceFile, node), kind, snippet: snippet(sourceFile, node) };
	if (!target.some((item) => item.line === signal.line && item.kind === signal.kind && item.snippet === signal.snippet)) {
		target.push(signal);
	}
}

function routeCandidatesFromText(value: string): string[] {
	const routes = new Set<string>();
	const methodRoute = /\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\/(?:api|memory|health|v1)[^\s"'`)},]*)/g;
	for (const match of value.matchAll(methodRoute)) routes.add(`${match[1]} ${match[2]}`);

	const route = /(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)?(\/(?:api|memory|health|v1)[A-Za-z0-9_./:;?=&%+~#-]*)/g;
	for (const match of value.matchAll(route)) routes.add(match[1]);
	return [...routes];
}

function collectSignals(sourceFile: ts.SourceFile, node: ts.Node) {
	const routeStrings = new Set<string>();
	const httpCalls: Signal[] = [];
	const dbSeedCalls: Signal[] = [];
	const fileSetup: Signal[] = [];
	const envSetup: Signal[] = [];
	const timerSetup: Signal[] = [];
	const providerMocks: Signal[] = [];

	function visit(current: ts.Node): void {
		if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
			for (const route of routeCandidatesFromText(current.text)) routeStrings.add(route);
		}

		if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
			const left = current.left.getText(sourceFile);
			if (/process\.env\.|Bun\.env\./.test(left)) addSignal(envSetup, sourceFile, current, "env-assignment");
		}

		if (ts.isCallExpression(current)) {
			const expressionText = current.expression.getText(sourceFile);
			const name = callName(current.expression);
			if (/(^|\.)(request|fetch)$/.test(expressionText) || name === "fetch") {
				addSignal(httpCalls, sourceFile, current, name);
			}
			if (
				/\.prepare$|\.exec$|\.run$|\.query$/.test(expressionText) ||
				/(runMigrations|initDbAccessor|getDbAccessor|withWriteTx|txIngestEnvelope|seedMemory|insertMemory|createApiKey|listApiKeys|revokeApiKey|verifyApiKey)/.test(
					expressionText,
				)
			) {
				addSignal(dbSeedCalls, sourceFile, current, name);
			}
			if (
				/(mkdtempSync|mkdirSync|writeFileSync|readFileSync|rmSync|copyFileSync|symlinkSync|chmodSync|Bun\.write|Bun\.file)/.test(
					expressionText,
				)
			) {
				addSignal(fileSetup, sourceFile, current, name);
			}
			if (/(setTimeout|setInterval|clearTimeout|clearInterval|useFakeTimers|setSystemTime|mock\.date|sleep)/.test(expressionText)) {
				addSignal(timerSetup, sourceFile, current, name);
			}
			if (/(mock\.module|spyOn|mock\(|fetchMock|MockAgent|createServer|provider|embedding|OpenAI|Ollama|Discord|GitHub)/i.test(expressionText)) {
				addSignal(providerMocks, sourceFile, current, name);
			}
		}
		ts.forEachChild(current, visit);
	}
	visit(node);

	return {
		routeStrings: [...routeStrings].sort(),
		httpCalls: httpCalls.slice(0, 40),
		dbSeedCalls: dbSeedCalls.slice(0, 60),
		fileSetup: fileSetup.slice(0, 60),
		envSetup: envSetup.slice(0, 40),
		timerSetup: timerSetup.slice(0, 40),
		providerMocks: providerMocks.slice(0, 40),
	};
}

function unionSignals(a: Signal[], b: Signal[], max = 80): Signal[] {
	const merged: Signal[] = [];
	for (const signal of [...a, ...b]) {
		if (!merged.some((item) => item.line === signal.line && item.kind === signal.kind && item.snippet === signal.snippet)) {
			merged.push(signal);
		}
	}
	return merged.sort((left, right) => left.line - right.line).slice(0, max);
}

function inferFamily(file: string, testName: string, manifest?: ManifestEntry): string {
	if (manifest?.manifestFamily) return manifest.manifestFamily;
	const text = `${file} ${testName} ${manifest?.behavior ?? ""}`.toLowerCase();
	if (/auth|secret|api-key|bitwarden|onepassword/.test(text)) return "auth/secrets";
	if (/recall|search|ranking|timeline|temporal|umap|context-budget|subagent-context/.test(text)) return "recall/ranking";
	if (/pipeline|embedding|provider|model|worker|retention|maintenance|decision|extraction|synthesis|dream/.test(text)) return "pipeline stages";
	if (/memory|transaction|lineage|mutation|head|session-memory/.test(text)) return "memory/lineage";
	if (/ontology|knowledge|graph|entity|assertion|proposal|dependency/.test(text)) return "ontology";
	if (/scope|agent-id|request-scope|task-scope/.test(text)) return "scoping";
	if (/source|discord|github|obsidian|filesystem|document|connector/.test(text)) return "sources";
	if (/hook|prompt-submit|transcript|session/.test(text)) return "hooks/sessions";
	if (/marketplace/.test(text)) return "marketplace";
	if (/skill/.test(text)) return "skills";
	if (/mcp/.test(text)) return "mcp";
	if (/dashboard|identity/.test(text)) return "dashboard/identity";
	if (/analytics|telemetry|diagnostic/.test(text)) return "analytics/diagnostics";
	if (/scheduler|task/.test(text)) return "scheduler/tasks";
	if (/update|version/.test(text)) return "updates/version";
	return "misc routes";
}

function inferConvertibility(
	file: string,
	testName: string,
	family: string,
	detected: ReturnType<typeof collectSignals>,
	manifest?: ManifestEntry,
): Convertibility {
	const text = `${file} ${testName} ${family} ${manifest?.behavior ?? ""}`.toLowerCase();
	const hasRoute = detected.routeStrings.length > 0 || detected.httpCalls.length > 0;
	const hasDb = detected.dbSeedCalls.length > 0;
	const hasFiles = detected.fileSetup.length > 0;
	const hasProviderMock = detected.providerMocks.length > 0;

	if (
		/extraction-thread|synthesis-worker|async-yield|event-loop|socket|bind-with-retry|http-server|native-runtime-assets|package-bundle|plugins\/host|plugins\/manifest|scheduler\/spawn|scheduler\/worker|resource-monitor|single-flight|watcher|update-system|which|bun-socket|daemon-refactor/.test(
			text,
		)
	) {
		return "runtime-specific";
	}
	if (/git-sync|autocommit|launchd|systemd|process exit/.test(text)) return "runtime-specific";
	if (
		hasProviderMock ||
		/discord|github|obsidian|openai|ollama|llm|reranker|embedding-fetch|inference|provider|source-provider|source-fetch|native-embedding|graphiq/.test(
			text,
		)
	) {
		return "provider-mocked";
	}
	if (hasRoute && hasFiles) return "http-files";
	if (hasRoute) return hasDb ? "http-db" : "http-db";
	if (hasFiles && /route|api|dashboard|identity|memory-head|lineage|file-sync/.test(text)) return "http-files";
	return "state-only";
}

function slug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 96);
}

function findTests(sourceFile: ts.SourceFile): Array<{ name: string; line: number; node: ts.CallExpression }> {
	const tests: Array<{ name: string; line: number; node: ts.CallExpression }> = [];
	const describeStack: string[] = [];

	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node)) {
			const name = bunTestBaseName(node.expression);
			if (name === "describe") {
				const title = stringValue(node.arguments[0]) ?? "<dynamic describe>";
				const callback = node.arguments.find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
				if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
					describeStack.push(title);
					ts.forEachChild(callback.body, visit);
					describeStack.pop();
					return;
				}
			}
			if (name === "test" || name === "it") {
				const callback = node.arguments.find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
				if (!callback) {
					ts.forEachChild(node, visit);
					return;
				}
				const title = stringValue(node.arguments[0]) ?? "<dynamic test>";
				tests.push({ name: [...describeStack, title].join(" > "), line: lineOf(sourceFile, node), node });
				return;
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return tests;
}

const manifest = parseManifest();
const files = walk(testsRoot).sort();
const inventory: ReplayInventoryCase[] = [];
const coveredFiles = new Set<string>();

for (const absoluteFile of files) {
	const sourceText = readFileSync(absoluteFile, "utf8");
	const sourceFile = ts.createSourceFile(absoluteFile, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const repoFile = relative(repoRoot, absoluteFile);
	const manifestEntry = manifest.get(repoFile);
	const fileSignals = collectSignals(sourceFile, sourceFile);
	const tests = findTests(sourceFile);

	const cases = tests.length > 0 ? tests : [{ name: "<file-level>", line: 1, node: sourceFile as unknown as ts.CallExpression }];
	for (const testCase of cases) {
		coveredFiles.add(repoFile);
		const testSignals = collectSignals(sourceFile, testCase.node);
		const routeStrings = testSignals.routeStrings.length > 0 ? testSignals.routeStrings : fileSignals.routeStrings;
		const detected = {
			routeStrings,
			httpCalls: unionSignals(testSignals.httpCalls, testSignals.httpCalls.length ? [] : fileSignals.httpCalls, 12),
			dbSeedCalls: unionSignals(testSignals.dbSeedCalls, testSignals.dbSeedCalls.length ? [] : fileSignals.dbSeedCalls, 20),
			fileSetup: unionSignals(testSignals.fileSetup, testSignals.fileSetup.length ? [] : fileSignals.fileSetup, 20),
			envSetup: unionSignals(testSignals.envSetup, testSignals.envSetup.length ? [] : fileSignals.envSetup, 12),
			timerSetup: unionSignals(testSignals.timerSetup, testSignals.timerSetup.length ? [] : fileSignals.timerSetup, 12),
			providerMocks: unionSignals(testSignals.providerMocks, testSignals.providerMocks.length ? [] : fileSignals.providerMocks, 12),
		};
		const behavioralFamily = inferFamily(repoFile, testCase.name, manifestEntry);
		inventory.push({
			id: `${slug(repoFile.replace(/\.test\.ts$/, ""))}__${testCase.line}__${slug(testCase.name)}`,
			source: { file: repoFile, testName: testCase.name, line: testCase.line },
			behavioralFamily,
			convertibility: inferConvertibility(repoFile, testCase.name, behavioralFamily, detected, manifestEntry),
			...(manifestEntry ? { manifest: manifestEntry } : {}),
			detected,
		});
	}
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(inventory, null, 2)}\n`);

const convertibilityCounts = inventory.reduce<Record<string, number>>((acc, item) => {
	acc[item.convertibility] = (acc[item.convertibility] ?? 0) + 1;
	return acc;
}, {});

const warning = files.length === expectedTestFileCount ? "" : ` (expected ${expectedTestFileCount})`;
console.log(`wrote ${relative(repoRoot, outputPath)}`);
console.log(`classified testFiles=${files.length}${warning} coveredFiles=${coveredFiles.size} cases=${inventory.length}`);
console.log(`convertibility=${JSON.stringify(convertibilityCounts)}`);
