/** Reproduces the current portable CLI import result using disposable workspaces. */
import { Database } from "bun:sqlite";
import { ensureUnifiedSchema } from "../../../platform/core/src/migration";
import { runMigrations } from "../../../platform/core/src/migrations/index";
import { registerPortableCommands } from "../../../surfaces/cli/src/commands/portable";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";

const root = mkdtempSync(join(tmpdir(), "signet-import-containment-current-"));
const source = join(root, "source");
const target = join(root, "target");

try {
	for (const path of [source, target]) {
		mkdirSync(join(path, "memory"), { recursive: true });
		const db = new Database(join(path, "memory/memories.db"));
		ensureUnifiedSchema(db);
		runMigrations(db);
		db.close();
	}
	writeFileSync(join(source, "agent.yaml"), "version: 1\nembedding:\n  provider: none\n");
	writeFileSync(join(source, "AGENTS.md"), "Synthetic identity\n");
	writeFileSync(join(source, "DREAMING.md"), "Synthetic maintenance instructions\n");
	const db = new Database(join(source, "memory/memories.db"));
	for (const agent of ["alpha", "beta"]) {
		db.prepare(
			"INSERT INTO memories (id,content,type,agent_id,visibility,source_type,created_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?)",
		).run("memory-" + agent, agent + " private evidence", "fact", agent, "private", "manual", "2026-01-01", "2026-01-01", "fixture");
	}
	db.prepare(
		"INSERT INTO memory_artifacts (agent_id,source_path,source_sha256,source_kind,session_id,session_token,captured_at,content,updated_at,source_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
	).run("alpha", "fixture/transcript.txt", "synthetic-sha", "transcript", "session-alpha", "session-alpha", "2026-01-01", "Synthetic source transcript", "2026-01-01", "source-alpha");
	const before = db.prepare("SELECT id,agent_id,visibility FROM memories ORDER BY id").all();
	db.close();

	const bundle = join(root, "bundle.json");
	const exporter = new Command();
	registerPortableCommands(exporter, { AGENTS_DIR: source });
	await exporter.parseAsync(["export", "--json", "--output", bundle], { from: "user" });
	const files = JSON.parse(readFileSync(bundle, "utf8")) as Record<string, string>;
	const importer = new Command();
	registerPortableCommands(importer, { AGENTS_DIR: target });
	await importer.parseAsync(["import", bundle, "--json"], { from: "user" });
	const restored = new Database(join(target, "memory/memories.db"), { readonly: true });
	console.log(
		JSON.stringify(
			{
				before,
				bundleFiles: Object.keys(files),
				exportedMemoryFields: Object.keys(JSON.parse(files["memories.jsonl"].split("\n")[0])),
				after: restored.prepare("SELECT id,agent_id,visibility FROM memories ORDER BY id").all(),
				restoredArtifactCount: restored.prepare("SELECT count(*) AS n FROM memory_artifacts").get(),
				dreamingFileExported: Object.hasOwn(files, "identity/DREAMING.md"),
			},
			null,
			2,
		),
	);
	restored.close();
} finally {
	rmSync(root, { recursive: true, force: true });
}
