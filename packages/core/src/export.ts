/**
 * Portable agent export and import.
 *
 * Creates a ZIP archive containing the full agent identity, memories,
 * entities, relations, and optionally embeddings. Supports round-trip
 * import with conflict resolution.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportOptions {
	readonly includeEmbeddings?: boolean;
	readonly includeSkills?: boolean;
}

export interface ExportManifest {
	readonly version: string;
	readonly exportedAt: string;
	readonly stats: {
		readonly memories: number;
		readonly entities: number;
		readonly relations: number;
		readonly skills: number;
	};
}

export interface ExportData {
	readonly manifest: ExportManifest;
	readonly agentYaml: string | null;
	readonly identityFiles: ReadonlyArray<{ name: string; content: string }>;
	readonly memories: ReadonlyArray<Record<string, unknown>>;
	readonly entities: ReadonlyArray<Record<string, unknown>>;
	readonly relations: ReadonlyArray<Record<string, unknown>>;
	readonly skills: ReadonlyArray<{
		name: string;
		files: ReadonlyArray<{ path: string; content: string }>;
	}>;
}

export type ImportConflictStrategy = "skip" | "overwrite" | "merge";

export interface ImportOptions {
	readonly conflictStrategy?: ImportConflictStrategy;
}

export interface ExportImportResult {
	readonly memoriesImported: number;
	readonly memoriesSkipped: number;
	readonly entitiesImported: number;
	readonly relationsImported: number;
	readonly identityFilesWritten: number;
}

// ---------------------------------------------------------------------------
// Database interface (minimal, avoids coupling to bun:sqlite)
// ---------------------------------------------------------------------------

interface ExportDb {
	prepare(sql: string): {
		all(...args: unknown[]): Record<string, unknown>[];
		get(...args: unknown[]): Record<string, unknown> | undefined;
	};
}

interface ImportDb {
	prepare(sql: string): {
		run(...args: unknown[]): void;
		get(...args: unknown[]): Record<string, unknown> | undefined;
	};
}

// ---------------------------------------------------------------------------
// Identity file names
// ---------------------------------------------------------------------------

const IDENTITY_FILE_NAMES = [
	"AGENTS.md",
	"SOUL.md",
	"IDENTITY.md",
	"USER.md",
	"MEMORY.md",
	"HEARTBEAT.md",
	"TOOLS.md",
] as const;

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function collectExportData(
	agentsDir: string,
	db: ExportDb,
	options: ExportOptions = {},
): ExportData {
	// Read agent.yaml
	let agentYaml: string | null = null;
	const yamlPath = join(agentsDir, "agent.yaml");
	if (existsSync(yamlPath)) {
		agentYaml = readFileSync(yamlPath, "utf-8");
	}

	// Read identity files
	const identityFiles: Array<{ name: string; content: string }> = [];
	for (const name of IDENTITY_FILE_NAMES) {
		const path = join(agentsDir, name);
		if (existsSync(path)) {
			identityFiles.push({ name, content: readFileSync(path, "utf-8") });
		}
	}

	// Export memories
	const memories = db
		.prepare(
			`SELECT id, content, type, category, confidence, source_type,
			        tags, importance, pinned, who, project, created_at, updated_at
			 FROM memories
			 WHERE is_deleted = 0
			 ORDER BY created_at ASC`,
		)
		.all();

	// Export entities
	const entities = db
		.prepare(
			`SELECT id, name, canonical_name, entity_type, description,
			        mentions, created_at, updated_at
			 FROM entities
			 ORDER BY created_at ASC`,
		)
		.all();

	// Export relations
	const relations = db
		.prepare(
			`SELECT id, source_entity_id, target_entity_id, relation_type,
			        strength, mentions, confidence, metadata, created_at
			 FROM relations
			 ORDER BY created_at ASC`,
		)
		.all();

	// Collect skills
	const skills: Array<{
		name: string;
		files: Array<{ path: string; content: string }>;
	}> = [];
	if (options.includeSkills !== false) {
		const skillsDir = join(agentsDir, "skills");
		if (existsSync(skillsDir)) {
			try {
				const entries = readdirSync(skillsDir, { withFileTypes: true });
				for (const entry of entries) {
					if (!entry.isDirectory()) continue;
					const skillDir = join(skillsDir, entry.name);
					const skillFiles: Array<{ path: string; content: string }> = [];
					collectSkillFiles(skillDir, "", skillFiles);
					skills.push({ name: entry.name, files: skillFiles });
				}
			} catch {
				// Non-fatal
			}
		}
	}

	return {
		manifest: {
			version: "1.0",
			exportedAt: new Date().toISOString(),
			stats: {
				memories: memories.length,
				entities: entities.length,
				relations: relations.length,
				skills: skills.length,
			},
		},
		agentYaml,
		identityFiles,
		memories,
		entities,
		relations,
		skills,
	};
}

function collectSkillFiles(
	dir: string,
	prefix: string,
	out: Array<{ path: string; content: string }>,
): void {
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				collectSkillFiles(fullPath, relPath, out);
			} else {
				const stat = statSync(fullPath);
				if (stat.size > 1_000_000) continue; // skip files > 1MB
				try {
					out.push({ path: relPath, content: readFileSync(fullPath, "utf-8") });
				} catch {
					// Skip binary files
				}
			}
		}
	} catch {
		// Non-fatal
	}
}

/**
 * Serialize export data to JSONL format for memories, entities, relations.
 * Returns a map of filename -> content for the export archive.
 */
export function serializeExportData(
	data: ExportData,
): ReadonlyMap<string, string> {
	const files = new Map<string, string>();

	files.set("manifest.json", JSON.stringify(data.manifest, null, 2));

	if (data.agentYaml) {
		files.set("agent.yaml", data.agentYaml);
	}

	for (const f of data.identityFiles) {
		files.set(`identity/${f.name}`, f.content);
	}

	files.set(
		"memories.jsonl",
		data.memories.map((m) => JSON.stringify(m)).join("\n"),
	);

	files.set(
		"entities.jsonl",
		data.entities.map((e) => JSON.stringify(e)).join("\n"),
	);

	files.set(
		"relations.jsonl",
		data.relations.map((r) => JSON.stringify(r)).join("\n"),
	);

	for (const skill of data.skills) {
		for (const f of skill.files) {
			files.set(`skills/${skill.name}/${f.path}`, f.content);
		}
	}

	return files;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export function importMemories(
	db: ImportDb,
	memoriesJsonl: string,
	options: ImportOptions = {},
): { imported: number; skipped: number } {
	const strategy = options.conflictStrategy ?? "skip";
	const lines = memoriesJsonl.split("\n").filter(Boolean);
	let imported = 0;
	let skipped = 0;

	for (const line of lines) {
		const mem = JSON.parse(line) as Record<string, unknown>;
		const id = mem.id as string;

		// Check for existing
		const existing = db.prepare("SELECT id FROM memories WHERE id = ?").get(id);

		if (existing) {
			if (strategy === "skip") {
				skipped++;
				continue;
			}
			if (strategy === "overwrite") {
				db.prepare(
					`UPDATE memories
					 SET content = ?, type = ?, importance = ?, tags = ?,
					     who = ?, project = ?, updated_at = ?
					 WHERE id = ?`,
				).run(
					mem.content,
					mem.type,
					mem.importance ?? 0.3,
					mem.tags ?? null,
					mem.who ?? null,
					mem.project ?? null,
					new Date().toISOString(),
					id,
				);
				imported++;
				continue;
			}
		}

		// Insert new
		db.prepare(
			`INSERT OR IGNORE INTO memories
			 (id, content, type, category, confidence, source_type,
			  tags, importance, pinned, who, project, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			mem.content,
			mem.type ?? "fact",
			mem.category ?? null,
			mem.confidence ?? 0.8,
			mem.source_type ?? "import",
			mem.tags ?? null,
			mem.importance ?? 0.3,
			mem.pinned ?? 0,
			mem.who ?? null,
			mem.project ?? null,
			mem.created_at ?? new Date().toISOString(),
			mem.updated_at ?? new Date().toISOString(),
		);
		imported++;
	}

	return { imported, skipped };
}

export function importEntities(db: ImportDb, entitiesJsonl: string): number {
	const lines = entitiesJsonl.split("\n").filter(Boolean);
	let count = 0;

	for (const line of lines) {
		const entity = JSON.parse(line) as Record<string, unknown>;
		db.prepare(
			`INSERT OR IGNORE INTO entities
			 (id, name, canonical_name, entity_type, description,
			  mentions, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			entity.id,
			entity.name,
			entity.canonical_name ?? null,
			entity.entity_type ?? "unknown",
			entity.description ?? null,
			entity.mentions ?? 1,
			entity.created_at ?? new Date().toISOString(),
			entity.updated_at ?? new Date().toISOString(),
		);
		count++;
	}

	return count;
}

export function importRelations(db: ImportDb, relationsJsonl: string): number {
	const lines = relationsJsonl.split("\n").filter(Boolean);
	let count = 0;

	for (const line of lines) {
		const rel = JSON.parse(line) as Record<string, unknown>;
		db.prepare(
			`INSERT OR IGNORE INTO relations
			 (id, source_entity_id, target_entity_id, relation_type,
			  strength, mentions, confidence, metadata, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			rel.id,
			rel.source_entity_id,
			rel.target_entity_id,
			rel.relation_type ?? "related",
			rel.strength ?? 1,
			rel.mentions ?? 1,
			rel.confidence ?? 0.8,
			rel.metadata ?? null,
			rel.created_at ?? new Date().toISOString(),
		);
		count++;
	}

	return count;
}
