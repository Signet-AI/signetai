/**
 * Expertise Graph Builder
 *
 * Maps relationships between skills, projects, tools, languages,
 * frameworks, and people. Builds entity nodes and weighted edges
 * based on co-occurrence in memories and sessions.
 *
 * Uses the existing `entities` and `relations` tables from the
 * core graph schema (migration 005).
 */

import type {
	ExpertiseGraph,
	ExpertiseNode,
	ExpertiseEdge,
	ExpertiseDepth,
	EntityType,
} from "./types";

// ---------------------------------------------------------------------------
// Database interface
// ---------------------------------------------------------------------------

interface GraphDb {
	prepare(sql: string): {
		all(...args: unknown[]): Record<string, unknown>[];
		get(...args: unknown[]): Record<string, unknown> | undefined;
		run(...args: unknown[]): void;
	};
	exec(sql: string): void;
}

// ---------------------------------------------------------------------------
// Entity type classification keywords
// ---------------------------------------------------------------------------

const LANGUAGE_KEYWORDS = new Set([
	"typescript",
	"javascript",
	"python",
	"rust",
	"go",
	"java",
	"c++",
	"c#",
	"ruby",
	"swift",
	"kotlin",
	"php",
	"scala",
	"haskell",
	"elixir",
	"clojure",
	"dart",
	"lua",
	"perl",
	"r",
	"sql",
	"html",
	"css",
	"shell",
	"bash",
	"zsh",
	"zig",
	"nim",
	"ocaml",
	"solidity",
]);

const FRAMEWORK_KEYWORDS = new Set([
	"react",
	"vue",
	"angular",
	"svelte",
	"next.js",
	"nextjs",
	"nuxt",
	"express",
	"fastify",
	"django",
	"flask",
	"spring",
	"rails",
	"laravel",
	"tailwind",
	"bootstrap",
	"electron",
	"tauri",
	"actix",
	"tokio",
	"ethers",
	"viem",
	"hardhat",
	"foundry",
	"remix",
]);

const TOOL_KEYWORDS = new Set([
	"git",
	"docker",
	"kubernetes",
	"terraform",
	"aws",
	"gcp",
	"azure",
	"nginx",
	"redis",
	"postgres",
	"postgresql",
	"mongodb",
	"sqlite",
	"webpack",
	"vite",
	"esbuild",
	"bun",
	"deno",
	"node",
	"npm",
	"yarn",
	"pnpm",
	"ollama",
	"cursor",
	"vscode",
	"vim",
	"neovim",
	"tmux",
	"ssh",
	"github",
	"gitlab",
	"vercel",
	"netlify",
	"cloudflare",
	"ffmpeg",
	"whisper",
	"peekaboo",
]);

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Build the full expertise graph from memories.
 * Analyzes all skill/project/collaborator memories and builds
 * entity nodes + weighted edges.
 */
export async function buildExpertiseGraph(db: GraphDb): Promise<ExpertiseGraph> {
	// Ensure expertise_edges table exists
	ensureExpertiseTable(db);

	// 1. Collect entities from memories
	const entities = extractEntities(db);

	// 2. Build co-occurrence edges
	const edges = buildCoOccurrenceEdges(db, entities);

	// 3. Store entities and edges for persistence
	storeGraphData(db, entities, edges);

	return {
		nodes: entities,
		edges,
		generatedAt: new Date().toISOString(),
	};
}

/**
 * Get the stored expertise graph.
 */
export async function getExpertiseGraph(db: GraphDb): Promise<ExpertiseGraph> {
	ensureExpertiseTable(db);

	const nodes = loadNodes(db);
	const edges = loadEdges(db);

	return {
		nodes,
		edges,
		generatedAt: new Date().toISOString(),
	};
}

/**
 * Find skills commonly used together with the given skill.
 */
export async function getRelatedSkills(
	db: GraphDb,
	skill: string,
): Promise<Array<{ skill: string; weight: number }>> {
	ensureExpertiseTable(db);

	const normalizedSkill = skill.toLowerCase().trim();

	try {
		// Find the entity node for this skill
		const node = db
			.prepare(
				`SELECT id FROM expertise_nodes
				 WHERE LOWER(name) = ? OR LOWER(name) LIKE ?
				 LIMIT 1`,
			)
			.get(normalizedSkill, `%${normalizedSkill}%`) as
			| { id: string }
			| undefined;

		if (!node) return [];

		// Find connected nodes via edges
		const rows = db
			.prepare(
				`SELECT n.name, e.weight
				 FROM expertise_edges e
				 JOIN expertise_nodes n ON (
				   (e.source_id = ? AND n.id = e.target_id) OR
				   (e.target_id = ? AND n.id = e.source_id)
				 )
				 ORDER BY e.weight DESC
				 LIMIT 20`,
			)
			.all(node.id, node.id) as Array<{ name: string; weight: number }>;

		return rows.map((r) => ({ skill: r.name, weight: r.weight }));
	} catch {
		return [];
	}
}

/**
 * Determine how deep knowledge is in a given domain.
 */
export async function getExpertiseDepth(
	db: GraphDb,
	domain: string,
): Promise<ExpertiseDepth> {
	const normalizedDomain = domain.toLowerCase().trim();

	try {
		// Count memories mentioning this domain
		const countRow = db
			.prepare(
				`SELECT COUNT(*) as cnt FROM memories
				 WHERE (LOWER(content) LIKE ? OR LOWER(tags) LIKE ?)
				   AND (is_deleted = 0 OR is_deleted IS NULL)`,
			)
			.get(`%${normalizedDomain}%`, `%${normalizedDomain}%`) as
			| { cnt: number }
			| undefined;

		const memoryCount = countRow?.cnt ?? 0;

		// Count unique skills related to this domain
		const skillRows = db
			.prepare(
				`SELECT DISTINCT tags FROM memories
				 WHERE LOWER(content) LIKE ?
				   AND type = 'skill'
				   AND (is_deleted = 0 OR is_deleted IS NULL)
				 LIMIT 100`,
			)
			.all(`%${normalizedDomain}%`) as Array<{ tags: string }>;

		const uniqueSkills = new Set<string>();
		for (const row of skillRows) {
			try {
				const tags = JSON.parse(row.tags || "[]") as string[];
				for (const tag of tags) {
					if (tag !== "skill" && tag !== normalizedDomain) {
						uniqueSkills.add(tag);
					}
				}
			} catch {
				// skip
			}
		}

		// Find related entities from the expertise graph
		const relatedRows = db
			.prepare(
				`SELECT DISTINCT n2.name
				 FROM expertise_nodes n1
				 JOIN expertise_edges e ON n1.id = e.source_id OR n1.id = e.target_id
				 JOIN expertise_nodes n2 ON (
				   (e.source_id = n1.id AND n2.id = e.target_id) OR
				   (e.target_id = n1.id AND n2.id = e.source_id)
				 )
				 WHERE LOWER(n1.name) LIKE ?
				 LIMIT 20`,
			)
			.all(`%${normalizedDomain}%`) as Array<{ name: string }>;

		const relatedEntities = relatedRows.map((r) => r.name);

		// Determine depth level
		let depth: ExpertiseDepth["depth"];
		if (memoryCount >= 50 && uniqueSkills.size >= 10) {
			depth = "expert";
		} else if (memoryCount >= 20 && uniqueSkills.size >= 5) {
			depth = "deep";
		} else if (memoryCount >= 5) {
			depth = "moderate";
		} else {
			depth = "surface";
		}

		return {
			domain,
			memoryCount,
			uniqueSkills: uniqueSkills.size,
			relatedEntities,
			depth,
		};
	} catch {
		return {
			domain,
			memoryCount: 0,
			uniqueSkills: 0,
			relatedEntities: [],
			depth: "surface",
		};
	}
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Ensure the expertise_nodes and expertise_edges tables exist.
 */
function ensureExpertiseTable(db: GraphDb): void {
	try {
		db.exec(`
			CREATE TABLE IF NOT EXISTS expertise_nodes (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				entity_type TEXT NOT NULL,
				mentions INTEGER DEFAULT 0,
				first_seen TEXT,
				last_seen TEXT,
				created_at TEXT DEFAULT (datetime('now')),
				updated_at TEXT DEFAULT (datetime('now'))
			);

			CREATE TABLE IF NOT EXISTS expertise_edges (
				source_id TEXT NOT NULL,
				target_id TEXT NOT NULL,
				weight REAL DEFAULT 1.0,
				co_occurrences INTEGER DEFAULT 1,
				created_at TEXT DEFAULT (datetime('now')),
				updated_at TEXT DEFAULT (datetime('now')),
				PRIMARY KEY (source_id, target_id)
			);

			CREATE INDEX IF NOT EXISTS idx_expertise_nodes_name
				ON expertise_nodes(name);
			CREATE INDEX IF NOT EXISTS idx_expertise_nodes_type
				ON expertise_nodes(entity_type);
			CREATE INDEX IF NOT EXISTS idx_expertise_edges_source
				ON expertise_edges(source_id);
			CREATE INDEX IF NOT EXISTS idx_expertise_edges_target
				ON expertise_edges(target_id);
		`);
	} catch {
		// Tables might already exist
	}
}

/**
 * Extract entities from all memories by analyzing tags and content.
 */
function extractEntities(db: GraphDb): ExpertiseNode[] {
	const entityMap = new Map<string, ExpertiseNode>();

	try {
		// Get all relevant memories with their tags
		const rows = db
			.prepare(
				`SELECT content, tags, type, created_at
				 FROM memories
				 WHERE type IN ('skill', 'fact', 'decision', 'procedural', 'preference', 'pattern')
				   AND (is_deleted = 0 OR is_deleted IS NULL)
				 ORDER BY created_at ASC`,
			)
			.all() as Array<{
			content: string;
			tags: string;
			type: string;
			created_at: string;
		}>;

		for (const row of rows) {
			let tags: string[] = [];
			try {
				tags = JSON.parse(row.tags || "[]");
			} catch {
				continue;
			}

			// Extract entities from tags
			for (const tag of tags) {
				const normalized = tag.toLowerCase().trim();
				if (
					!normalized ||
					normalized.length < 2 ||
					isStopTag(normalized)
				) {
					continue;
				}

				const entityType = classifyEntity(normalized);
				const key = `${entityType}:${normalized}`;

				if (entityMap.has(key)) {
					const node = entityMap.get(key)!;
					node.mentions++;
					node.lastSeen = row.created_at;
				} else {
					entityMap.set(key, {
						id: crypto.randomUUID(),
						name: normalized,
						entityType,
						mentions: 1,
						firstSeen: row.created_at,
						lastSeen: row.created_at,
					});
				}
			}

			// Also extract key terms from content for "skill" type memories
			if (row.type === "skill") {
				const contentTerms = extractContentTerms(row.content);
				for (const term of contentTerms) {
					const entityType = classifyEntity(term);
					const key = `${entityType}:${term}`;

					if (entityMap.has(key)) {
						const node = entityMap.get(key)!;
						node.mentions++;
						node.lastSeen = row.created_at;
					} else {
						entityMap.set(key, {
							id: crypto.randomUUID(),
							name: term,
							entityType,
							mentions: 1,
							firstSeen: row.created_at,
							lastSeen: row.created_at,
						});
					}
				}
			}
		}
	} catch {
		// empty
	}

	// Filter out entities with very low mentions (noise)
	return Array.from(entityMap.values()).filter((e) => e.mentions >= 1);
}

/**
 * Build co-occurrence edges between entities that appear in the same memory.
 */
function buildCoOccurrenceEdges(
	db: GraphDb,
	entities: ExpertiseNode[],
): ExpertiseEdge[] {
	const edgeMap = new Map<string, ExpertiseEdge>();
	const entityLookup = new Map<string, ExpertiseNode>();

	for (const entity of entities) {
		entityLookup.set(entity.name, entity);
	}

	try {
		const rows = db
			.prepare(
				`SELECT tags FROM memories
				 WHERE type IN ('skill', 'fact', 'decision', 'procedural', 'preference', 'pattern')
				   AND (is_deleted = 0 OR is_deleted IS NULL)`,
			)
			.all() as Array<{ tags: string }>;

		for (const row of rows) {
			let tags: string[] = [];
			try {
				tags = JSON.parse(row.tags || "[]");
			} catch {
				continue;
			}

			// Only use tags that are known entities
			const memoryEntities: ExpertiseNode[] = [];
			for (const tag of tags) {
				const normalized = tag.toLowerCase().trim();
				if (entityLookup.has(normalized)) {
					memoryEntities.push(entityLookup.get(normalized)!);
				}
			}

			// Create edges for all pairs of entities in this memory
			for (let i = 0; i < memoryEntities.length; i++) {
				for (let j = i + 1; j < memoryEntities.length; j++) {
					const a = memoryEntities[i];
					const b = memoryEntities[j];

					// Consistent ordering for edge key
					const [src, tgt] =
						a.id < b.id ? [a, b] : [b, a];
					const key = `${src.id}:${tgt.id}`;

					if (edgeMap.has(key)) {
						const edge = edgeMap.get(key)!;
						edge.coOccurrences++;
						edge.weight = Math.log2(1 + edge.coOccurrences); // log-scaled weight
					} else {
						edgeMap.set(key, {
							sourceId: src.id,
							targetId: tgt.id,
							weight: 1.0,
							coOccurrences: 1,
						});
					}
				}
			}
		}
	} catch {
		// empty
	}

	return Array.from(edgeMap.values());
}

/**
 * Store the graph data in expertise tables.
 */
function storeGraphData(
	db: GraphDb,
	nodes: ExpertiseNode[],
	edges: ExpertiseEdge[],
): void {
	const now = new Date().toISOString();

	try {
		// Clear existing data (rebuild)
		db.exec("DELETE FROM expertise_edges");
		db.exec("DELETE FROM expertise_nodes");

		// Insert nodes
		const nodeStmt = db.prepare(
			`INSERT INTO expertise_nodes (id, name, entity_type, mentions, first_seen, last_seen, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);

		for (const node of nodes) {
			nodeStmt.run(
				node.id,
				node.name,
				node.entityType,
				node.mentions,
				node.firstSeen,
				node.lastSeen,
				now,
				now,
			);
		}

		// Insert edges
		const edgeStmt = db.prepare(
			`INSERT INTO expertise_edges (source_id, target_id, weight, co_occurrences, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		);

		for (const edge of edges) {
			edgeStmt.run(
				edge.sourceId,
				edge.targetId,
				edge.weight,
				edge.coOccurrences,
				now,
				now,
			);
		}
	} catch (err) {
		console.warn(
			"[distillation] Failed to store expertise graph:",
			err instanceof Error ? err.message : String(err),
		);
	}
}

/**
 * Load nodes from the expertise_nodes table.
 */
function loadNodes(db: GraphDb): ExpertiseNode[] {
	try {
		const rows = db
			.prepare(
				`SELECT id, name, entity_type, mentions, first_seen, last_seen
				 FROM expertise_nodes
				 ORDER BY mentions DESC`,
			)
			.all() as Array<{
			id: string;
			name: string;
			entity_type: string;
			mentions: number;
			first_seen: string;
			last_seen: string;
		}>;

		return rows.map((r) => ({
			id: r.id,
			name: r.name,
			entityType: r.entity_type as EntityType,
			mentions: r.mentions,
			firstSeen: r.first_seen,
			lastSeen: r.last_seen,
		}));
	} catch {
		return [];
	}
}

/**
 * Load edges from the expertise_edges table.
 */
function loadEdges(db: GraphDb): ExpertiseEdge[] {
	try {
		const rows = db
			.prepare(
				`SELECT source_id, target_id, weight, co_occurrences
				 FROM expertise_edges
				 ORDER BY weight DESC`,
			)
			.all() as Array<{
			source_id: string;
			target_id: string;
			weight: number;
			co_occurrences: number;
		}>;

		return rows.map((r) => ({
			sourceId: r.source_id,
			targetId: r.target_id,
			weight: r.weight,
			coOccurrences: r.co_occurrences,
		}));
	} catch {
		return [];
	}
}

/**
 * Classify an entity name into a type category.
 */
function classifyEntity(name: string): EntityType {
	const lower = name.toLowerCase();

	if (LANGUAGE_KEYWORDS.has(lower)) return "language";
	if (FRAMEWORK_KEYWORDS.has(lower)) return "framework";
	if (TOOL_KEYWORDS.has(lower)) return "tool";

	// Heuristics for other types
	if (
		lower.includes("project") ||
		lower.includes("repo") ||
		lower.startsWith("@")
	) {
		return "project";
	}

	// Names that look like people (capitalized, no special chars)
	if (/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(name)) {
		return "person";
	}

	// Default to "skill" for anything else
	return "skill";
}

/**
 * Extract key technical terms from memory content.
 */
function extractContentTerms(content: string): string[] {
	const terms: string[] = [];
	const lower = content.toLowerCase();

	// Check for known keywords
	for (const kw of LANGUAGE_KEYWORDS) {
		if (lower.includes(kw)) terms.push(kw);
	}
	for (const kw of FRAMEWORK_KEYWORDS) {
		if (lower.includes(kw)) terms.push(kw);
	}
	for (const kw of TOOL_KEYWORDS) {
		if (lower.includes(kw)) terms.push(kw);
	}

	return terms;
}

/**
 * Tags to skip as too generic to be meaningful entities.
 */
function isStopTag(tag: string): boolean {
	const stops = new Set([
		"skill",
		"technical",
		"domain",
		"process",
		"communication",
		"tool_mastery",
		"decision",
		"fact",
		"preference",
		"learning",
		"competent",
		"proficient",
		"expert",
		"perception",
		"distillation",
		"cognitive-profile",
	]);
	return stops.has(tag);
}
