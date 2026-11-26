import "../../../../tests/support/connector-safety.js";
import { test } from "bun:test";
import fixture from "../../../../tests/fixtures/connector-conformance.json";
import { runUploadResume } from "../../../../tests/support/upload-resume-conformance";
for (const scenario of fixture.uploads)
	test(`A21 TypeScript conformance: ${scenario.name}`, () => runUploadResume("typescript", scenario.name), 180_000);
