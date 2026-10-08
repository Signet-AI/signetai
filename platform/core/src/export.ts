import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

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

export interface ImportOptions {
	readonly agentId?: string;
}

export interface ImportInput {
	readonly memories?: string;
	readonly entities?: string;
	readonly relations?: string;
}

export interface ExportImportResult {
	readonly memoriesImported: number;
	readonly memoriesSkipped: number;
	readonly entitiesImported: number;
	readonly relationsImported: number;
}

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
	exec(sql: string): void;
}

const IDENTITY_FILE_NAMES = [
	"AGENTS.md",
	"SOUL.md",
	"IDENTITY.md",
	"USER.md",
	"MEMORY.md",
	"HEARTBEAT.md",
	"TOOLS.md",
] as const;

export function collectExportData(agentsDir: string, db: ExportDb, options: ExportOptions = {}): ExportData {
	let agentYaml: string | null = null;
	const yamlPath = join(agentsDir, "agent.yaml");
	if (existsSync(yamlPath)) {
		agentYaml = readFileSync(yamlPath, "utf-8");
	}
	const identityFiles: Array<{ name: string; content: string }> = [];
	for (const name of IDENTITY_FILE_NAMES) {
		const path = join(agentsDir, name);
		if (existsSync(path)) {
			identityFiles.push({ name, content: readFileSync(path, "utf-8") });
		}
	}
	const memories = db
		.prepare(
			`SELECT id, content, type, category, confidence, source_type,
			        tags, importance, pinned, who, project, agent_id, scope,
			        visibility, created_at, updated_at
			 FROM memories
			 WHERE is_deleted = 0
			 ORDER BY created_at ASC`,
		)
		.all();
	const entities = db
		.prepare(
			`SELECT id, name, canonical_name, entity_type, description,
			        mentions, agent_id, created_at, updated_at
			 FROM entities
			 ORDER BY created_at ASC`,
		)
		.all();
	const relations = db
		.prepare(
			`SELECT id, source_entity_id, target_entity_id, relation_type,
			        strength, mentions, confidence, metadata, created_at
			 FROM relations
			 ORDER BY created_at ASC`,
		)
		.all();
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
			} catch {}
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

function collectSkillFiles(dir: string, prefix: string, out: Array<{ path: string; content: string }>): void {
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				collectSkillFiles(fullPath, relPath, out);
			} else {
				const stat = statSync(fullPath);
				if (stat.size > 1_000_000) continue;
				try {
					out.push({ path: relPath, content: readFileSync(fullPath, "utf-8") });
				} catch {}
			}
		}
	} catch {}
}
export function serializeExportData(data: ExportData): ReadonlyMap<string, string> {
	const files = new Map<string, string>();

	files.set("manifest.json", JSON.stringify(data.manifest, null, 2));

	if (data.agentYaml) {
		files.set("agent.yaml", data.agentYaml);
	}

	for (const f of data.identityFiles) {
		files.set(`identity/${f.name}`, f.content);
	}

	files.set("memories.jsonl", data.memories.map((m) => JSON.stringify(m)).join("\n"));

	files.set("entities.jsonl", data.entities.map((e) => JSON.stringify(e)).join("\n"));

	files.set("relations.jsonl", data.relations.map((r) => JSON.stringify(r)).join("\n"));

	for (const skill of data.skills) {
		for (const f of skill.files) {
			files.set(`skills/${skill.name}/${f.path}`, f.content);
		}
	}

	return files;
}

const VISIBILITIES = new Set(["global", "private", "archived"]);

interface Line {
	readonly file: string;
	readonly line: number;
	readonly row: Record<string, unknown>;
}

function parseLines(file: string, jsonl: string | undefined): Line[] {
	return (jsonl ?? "").split("\n").flatMap((raw, index) => {
		if (raw.trim().length === 0) return [];
		let row: unknown;
		try {
			row = JSON.parse(raw);
		} catch {
			throw new Error(`${file} line ${index + 1} is not valid JSON`);
		}
		if (typeof row !== "object" || row === null || Array.isArray(row))
			throw new Error(`${file} line ${index + 1} is not a JSON object`);
		return [{ file, line: index + 1, row: Object.fromEntries(Object.entries(row)) }];
	});
}

function text(item: Line, key: string): string {
	const value = item.row[key];
	if (typeof value === "string" && value.trim().length > 0) return value;
	throw new Error(`${item.file} line ${item.line} is missing ${key}`);
}

function agent(item: Line, options: ImportOptions): string {
	const value = options.agentId ?? item.row.agent_id;
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	throw new Error(`${item.file} line ${item.line} has no agent_id; pass an explicit target agent`);
}

function visibility(item: Line, options: ImportOptions): string {
	const value = item.row.visibility;
	if (value === undefined || value === null) {
		if (options.agentId !== undefined) return "private";
		throw new Error(`${item.file} line ${item.line} has no visibility; pass an explicit target agent`);
	}
	if (typeof value === "string" && VISIBILITIES.has(value)) return value;
	throw new Error(`${item.file} line ${item.line} has unsupported visibility`);
}

function scope(item: Line): string | null {
	const value = item.row.scope;
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return value;
	throw new Error(`${item.file} line ${item.line} has unsupported scope`);
}

export function importBundle(db: ImportDb, input: ImportInput, options: ImportOptions = {}): ExportImportResult {
	if (options.agentId !== undefined && options.agentId.trim().length === 0)
		throw new Error("Target agent must not be empty");
	const now = new Date().toISOString();
	const memories = parseLines("memories.jsonl", input.memories).map((item) => ({
		row: item.row,
		id: text(item, "id"),
		content: text(item, "content"),
		agentId: agent(item, options),
		visibility: visibility(item, options),
		scope: scope(item),
	}));
	const entities = parseLines("entities.jsonl", input.entities).map((item) => ({
		row: item.row,
		id: text(item, "id"),
		name: text(item, "name"),
		agentId: agent(item, options),
	}));
	const relations = parseLines("relations.jsonl", input.relations).map((item) => ({
		row: item.row,
		id: text(item, "id"),
		source: text(item, "source_entity_id"),
		target: text(item, "target_entity_id"),
	}));

	let memoriesImported = 0;
	let memoriesSkipped = 0;
	db.exec("BEGIN");
	try {
		for (const mem of memories) {
			if (db.prepare("SELECT 1 FROM memories WHERE id = ?").get(mem.id)) {
				memoriesSkipped++;
				continue;
			}
			db.prepare(
				`INSERT INTO memories
				 (id, content, type, category, confidence, source_type,
				  tags, importance, pinned, who, project, agent_id, scope,
				  visibility, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				mem.id,
				mem.content,
				mem.row.type ?? "fact",
				mem.row.category ?? null,
				mem.row.confidence ?? 0.8,
				mem.row.source_type ?? "import",
				mem.row.tags ?? null,
				mem.row.importance ?? 0.3,
				mem.row.pinned ?? 0,
				mem.row.who ?? null,
				mem.row.project ?? null,
				mem.agentId,
				mem.scope,
				mem.visibility,
				mem.row.created_at ?? now,
				mem.row.updated_at ?? now,
			);
			memoriesImported++;
		}
		for (const entity of entities) {
			db.prepare(
				`INSERT OR IGNORE INTO entities
				 (id, name, canonical_name, entity_type, description,
				  mentions, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				entity.id,
				entity.name,
				entity.row.canonical_name ?? null,
				entity.row.entity_type ?? "unknown",
				entity.row.description ?? null,
				entity.row.mentions ?? 1,
				entity.agentId,
				entity.row.created_at ?? now,
				entity.row.updated_at ?? now,
			);
		}
		for (const rel of relations) {
			db.prepare(
				`INSERT OR IGNORE INTO relations
				 (id, source_entity_id, target_entity_id, relation_type,
				  strength, mentions, confidence, metadata, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				rel.id,
				rel.source,
				rel.target,
				rel.row.relation_type ?? "related",
				rel.row.strength ?? 1,
				rel.row.mentions ?? 1,
				rel.row.confidence ?? 0.8,
				rel.row.metadata ?? null,
				rel.row.created_at ?? now,
			);
		}
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}

	return {
		memoriesImported,
		memoriesSkipped,
		entitiesImported: entities.length,
		relationsImported: relations.length,
	};
}
