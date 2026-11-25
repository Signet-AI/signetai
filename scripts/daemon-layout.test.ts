import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const SOURCE_ROOT = join(import.meta.dir, "..", "platform", "daemon", "src");

const FOLDERS = [
	"agents",
	"auth",
	"config",
	"db",
	"dreaming",
	"embeddings",
	"harness",
	"http",
	"inference",
	"memory",
	"ontology",
	"plugins",
	"recall",
	"runtime",
	"secrets",
	"sessions",
	"sources",
	"telemetry",
	"transcripts",
	"workers",
	"workspace",
];

const ROOT_FILES = ["daemon.ts", "dev-daemon.ts", "index.ts"];

test("daemon source root holds only the entry points, their tests, and the feature folders", () => {
	const entries = readdirSync(SOURCE_ROOT, { withFileTypes: true });
	const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	const files = entries
		.filter((entry) => entry.isFile() && !entry.name.endsWith(".test.ts"))
		.map((entry) => entry.name);

	expect(folders.filter((name) => !FOLDERS.includes(name)).sort()).toEqual([]);
	expect(files.filter((name) => !ROOT_FILES.includes(name)).sort()).toEqual([]);
});
