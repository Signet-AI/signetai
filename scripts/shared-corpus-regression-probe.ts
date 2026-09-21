#!/usr/bin/env bun
import { buildExecutionManifest, runnableManifestPaths, parseJUnitReport } from "./shared-corpus-runner";

const repo = process.argv[2] ?? ".";
const manifest = buildExecutionManifest(repo);
const entrypoints = runnableManifestPaths(manifest.protectedCorpus);
if (manifest.protectedCorpus.length !== 497) throw new Error(`protected corpus=${manifest.protectedCorpus.length}`);
if (entrypoints.length !== 482) throw new Error(`executable entrypoints=${entrypoints.length}; expected 482`);
const synthetic = parseJUnitReport(
	'<testsuite tests="2"><testcase classname="rust-shared-corpus-adapter" name="adapter-execution"/><testcase classname="real" name="database"/></testsuite>',
	["platform/core/src/database.test.ts"],
	0,
);
if (synthetic.tests !== 2 || synthetic.passed !== 2) throw new Error("actual-case parser regression");
console.log(
	JSON.stringify({
		protectedCorpus: manifest.protectedCorpus.length,
		executableEntrypoints: entrypoints.length,
		syntheticParserCases: synthetic.tests,
	}),
);
