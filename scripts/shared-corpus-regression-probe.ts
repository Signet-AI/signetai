#!/usr/bin/env bun
import { buildExecutionManifest, runnableManifestPaths, parseJUnitReport } from "./shared-corpus-runner";

const repo = process.argv[2] ?? ".";
const manifest = buildExecutionManifest(repo);
const entrypoints = runnableManifestPaths(manifest.protectedCorpus);
if (manifest.protectedCorpus.length !== 497) throw new Error(`protected corpus=${manifest.protectedCorpus.length}`);
if (entrypoints.length !== 481) throw new Error(`executable entrypoints=${entrypoints.length}; expected 481`);
const actualOnly = parseJUnitReport(
	'<testsuite tests="1"><testcase classname="real" name="database"/></testsuite>',
	["platform/core/src/database.test.ts", "platform/daemon/src/workspace-startup.test.ts"],
	0,
);
if (actualOnly.tests !== 1 || actualOnly.passed !== 1 || !actualOnly.incomplete)
	throw new Error("actual-case parser accepted a synthetic or missing testcase");
console.log(
	JSON.stringify({
		protectedCorpus: manifest.protectedCorpus.length,
		executableEntrypoints: entrypoints.length,
		actualParserCases: actualOnly.tests,
	}),
);
