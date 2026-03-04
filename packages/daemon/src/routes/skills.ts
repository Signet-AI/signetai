/**
 * Skills API routes — extracted from daemon.ts
 *
 * Handles skill listing, browsing, searching, installing, and uninstalling.
 * Integrates with the procedural memory graph for skill discovery.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSkillsRunnerCommand, resolvePrimaryPackageManager } from "@signet/core";
import type { Hono } from "hono";
import { logger } from "../logger.js";
import { parseSkillFile, patchSkillFrontmatter } from "../pipeline/skill-frontmatter.js";
import { installSkillNode, uninstallSkillNode } from "../pipeline/skill-graph.js";
import { getDbAccessor, type DbAccessor } from "../db-accessor.js";
import { loadMemoryConfig, type EmbeddingConfig, type PipelineV2Config } from "../memory-config.js";
import { getLlmProvider } from "../llm.js";
import type { LlmProvider } from "../pipeline/provider.js";

function getAgentsDir(): string {
	return process.env.SIGNET_PATH || join(homedir(), ".agents");
}

function getSkillsDir(): string {
	return join(getAgentsDir(), "skills");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillMeta {
	description: string;
	version?: string;
	author?: string;
	maintainer?: string;
	license?: string;
	user_invocable?: boolean;
	arg_hint?: string;
	verified?: boolean;
	permissions?: string[];
}

type CatalogEntry = {
	source: string;
	skillId: string;
	name: string;
	installs: number;
};

type ClawhubItem = {
	slug: string;
	displayName: string;
	summary: string;
	tags: { latest: string };
	stats: {
		downloads: number;
		installsAllTime: number;
		installsCurrent: number;
		stars: number;
		comments: number;
		versions: number;
	};
	createdAt: number;
	updatedAt: number;
	latestVersion: {
		version: string;
		createdAt: number;
		changelog: string;
	};
};

type SkillBrowseResult = {
	name: string;
	fullName: string;
	installs: string;
	installsRaw: number;
	popularityScore: number;
	description: string;
	installed: boolean;
	provider: "skills.sh" | "clawhub";
	category: string;
	stars?: number;
	downloads?: number;
	versions?: number;
	author?: string;
	maintainer?: string;
	verified?: boolean;
	permissions?: string[];
};

// ---------------------------------------------------------------------------
// Cache state (module-private)
// ---------------------------------------------------------------------------

let catalogCache: CatalogEntry[] = [];
let catalogFetchedAt = 0;
let clawhubCache: ClawhubItem[] = [];
let clawhubFetchedAt = 0;
const CATALOG_TTL = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseSkillFrontmatter(content: string): SkillMeta {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return { description: "" };

	const fm = match[1];
	const get = (key: string) => {
		const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
		return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
	};
	const getList = (key: string): string[] | undefined => {
		const raw = get(key);
		if (!raw) return undefined;
		const trimmed = raw.trim();
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			const values = trimmed
				.slice(1, -1)
				.split(",")
				.map((v) => v.trim().replace(/^["']|["']$/g, ""))
				.filter(Boolean);
			return values.length > 0 ? values : undefined;
		}
		const values = trimmed
			.split(",")
			.map((v) => v.trim().replace(/^["']|["']$/g, ""))
			.filter(Boolean);
		return values.length > 0 ? values : undefined;
	};

	return {
		description: get("description"),
		version: get("version") || undefined,
		author: get("author") || undefined,
		maintainer: get("maintainer") || get("author") || undefined,
		license: get("license") || undefined,
		user_invocable: /^user_invocable:\s*true$/m.test(fm),
		arg_hint: get("arg_hint") || undefined,
		verified: /^verified:\s*true$/m.test(fm) ? true : /^verified:\s*false$/m.test(fm) ? false : undefined,
		permissions: getList("permissions"),
	};
}

export function listInstalledSkills() {
	if (!existsSync(getSkillsDir())) return [];

	return readdirSync(getSkillsDir(), { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.flatMap((d) => {
			const skillMdPath = join(getSkillsDir(), d.name, "SKILL.md");
			if (!existsSync(skillMdPath)) return [];
			try {
				const content = readFileSync(skillMdPath, "utf-8");
				const meta = parseSkillFrontmatter(content);
				return [{ name: d.name, ...meta, path: join(getSkillsDir(), d.name) }];
			} catch {
				return [];
			}
		});
}

export function formatInstalls(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function inferSkillCategory(input: string): string {
	const value = input.toLowerCase();
	if (/ui|design|css|react|svelte|frontend/.test(value)) return "UI";
	if (/security|auth|token|secret|vault/.test(value)) return "Security";
	if (/database|sql|sqlite|postgres|mongo|vector/.test(value)) {
		return "Data";
	}
	if (/memory|rag|search|docs|knowledge/.test(value)) return "Knowledge";
	if (/web|browser|crawl|scrap|http/.test(value)) return "Web";
	if (/git|ci|build|deploy|test|debug|lint/.test(value)) {
		return "Development";
	}
	if (/agent|automation|workflow|task/.test(value)) return "Automation";
	return "Other";
}

function calculateSkillPopularity(input: {
	installsRaw: number;
	stars?: number;
	verified?: boolean;
}): number {
	const stars = input.stars ?? 0;
	const verifiedBoost = input.verified ? 5_000 : 0;
	return input.installsRaw + stars * 200 + verifiedBoost;
}

async function fetchCatalog(): Promise<CatalogEntry[]> {
	const now = Date.now();
	if (catalogCache.length > 0 && now - catalogFetchedAt < CATALOG_TTL) {
		return catalogCache;
	}
	logger.info("skills", "Fetching skills.sh catalog");
	try {
		const res = await fetch("https://skills.sh", {
			headers: { "User-Agent": "signet-daemon" },
		});
		const html = await res.text();
		const entries: CatalogEntry[] = [];
		const re =
			/\{\\"source\\":\\"([^\\]+)\\",\\"skillId\\":\\"([^\\]+)\\",\\"name\\":\\"([^\\]+)\\",\\"installs\\":(\d+)\}/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(html)) !== null) {
			entries.push({
				source: m[1],
				skillId: m[2],
				name: m[3],
				installs: Number(m[4]),
			});
		}
		if (entries.length > 0) {
			catalogCache = entries;
			catalogFetchedAt = now;
			logger.info("skills", `Cached ${entries.length} skills`);
		}
		return entries.length > 0 ? entries : catalogCache;
	} catch (err) {
		logger.error("skills", "Catalog fetch failed", err as Error);
		return catalogCache;
	}
}

async function fetchClawhubCatalog(): Promise<ClawhubItem[]> {
	const now = Date.now();
	if (clawhubCache.length > 0 && now - clawhubFetchedAt < CATALOG_TTL) {
		return clawhubCache;
	}
	logger.info("skills", "Fetching ClawHub catalog");
	try {
		const items: ClawhubItem[] = [];
		let cursor: string | undefined;
		const MAX_ITEMS = 500;
		const MAX_PAGES = 10;
		let page = 0;
		while (page < MAX_PAGES && items.length < MAX_ITEMS) {
			const url = new URL("https://clawhub.ai/api/v1/skills");
			url.searchParams.set("sort", "downloads");
			url.searchParams.set("limit", "50");
			if (cursor) url.searchParams.set("cursor", cursor);

			const res = await fetch(url.toString(), {
				headers: { "User-Agent": "signet-daemon" },
			});
			if (!res.ok) throw new Error(`ClawHub returned ${res.status}`);
			const data = (await res.json()) as {
				items: ClawhubItem[];
				nextCursor: string | null;
			};
			items.push(...data.items);
			if (!data.nextCursor) break;
			cursor = data.nextCursor;
			page++;
		}
		if (items.length > 0) {
			clawhubCache = items;
			clawhubFetchedAt = now;
			logger.info("skills", `Cached ${items.length} ClawHub skills`);
		}
		return items.length > 0 ? items : clawhubCache;
	} catch (err) {
		logger.error("skills", "ClawHub catalog fetch failed", err as Error);
		return clawhubCache;
	}
}

// ---------------------------------------------------------------------------
// Route mount
// ---------------------------------------------------------------------------

// Lazy dependency accessors — singletons are initialised at daemon startup
// before any route handler runs. These callsites are safe.
let fetchEmbeddingFn: ((text: string, cfg: EmbeddingConfig) => Promise<number[] | null>) | null = null;

export function setFetchEmbedding(fn: (text: string, cfg: EmbeddingConfig) => Promise<number[] | null>): void {
	fetchEmbeddingFn = fn;
}

function getAccessorSafe(): DbAccessor | null {
	try { return getDbAccessor(); } catch { return null; }
}

function getProviderSafe(): LlmProvider | null {
	try { return getLlmProvider(); } catch { return null; }
}

// Per-skill lock to prevent concurrent enrichment writes to SKILL.md
const skillLocks = new Map<string, Promise<void>>();

function withSkillLock(skillName: string, fn: () => Promise<void>): Promise<void> {
	const prev = skillLocks.get(skillName) ?? Promise.resolve();
	const next = prev.then(fn, fn).finally(() => {
		if (skillLocks.get(skillName) === next) {
			skillLocks.delete(skillName);
		}
	});
	skillLocks.set(skillName, next);
	return next;
}

/**
 * After a successful skill install, create the graph node.
 * Runs async — does not block the install response.
 * Serialized per skill name to prevent concurrent SKILL.md writes.
 */
async function onSkillInstalled(skillName: string): Promise<void> {
	return withSkillLock(skillName, () => onSkillInstalledInner(skillName));
}

async function onSkillInstalledInner(skillName: string): Promise<void> {
	const accessor = getAccessorSafe();
	if (!accessor) return;

	const skillMdPath = join(getSkillsDir(), skillName, "SKILL.md");
	if (!existsSync(skillMdPath)) return;

	try {
		const content = readFileSync(skillMdPath, "utf-8");
		const parsed = parseSkillFile(content);
		if (!parsed) {
			logger.warn("skills", "Failed to parse SKILL.md frontmatter for graph", { skill: skillName });
			return;
		}

		const memoryCfg = loadMemoryConfig(getAgentsDir());
		if (!memoryCfg.pipelineV2.procedural.enabled) return;
		if (!fetchEmbeddingFn) return;

		const result = await installSkillNode(
			{
				frontmatter: parsed.frontmatter,
				body: parsed.body,
				source: "installed",
				fsPath: skillMdPath,
			},
			accessor,
			memoryCfg.pipelineV2,
			memoryCfg.embedding,
			fetchEmbeddingFn,
			getProviderSafe(),
		);

		// Write enrichment back to SKILL.md if enriched
		if (result.enriched) {
			const freshContent = readFileSync(skillMdPath, "utf-8");
			const freshParsed = parseSkillFile(freshContent);
			if (freshParsed) {
				// Get the enriched frontmatter from the installed node
				const enrichedFm = accessor.withReadDb((db) =>
					db.prepare(
						"SELECT triggers, tags FROM skill_meta WHERE entity_id = ?",
					).get(result.entityId) as { triggers: string | null; tags: string | null } | undefined,
				);

				if (enrichedFm) {
					// Build a properly typed patch from DB values
					let patchDescription: string | undefined;
					let patchTriggers: readonly string[] | undefined;
					let patchTags: readonly string[] | undefined;

					const entity = accessor.withReadDb((db) =>
						db.prepare("SELECT description FROM entities WHERE id = ?")
							.get(result.entityId) as { description: string | null } | undefined,
					);
					if (entity?.description) patchDescription = entity.description;
					if (enrichedFm.triggers) {
						try {
							const parsed: unknown = JSON.parse(enrichedFm.triggers);
							if (Array.isArray(parsed)) patchTriggers = parsed.filter((v): v is string => typeof v === "string");
						} catch { /* skip */ }
					}
					if (enrichedFm.tags) {
						try {
							const parsed: unknown = JSON.parse(enrichedFm.tags);
							if (Array.isArray(parsed)) patchTags = parsed.filter((v): v is string => typeof v === "string");
						} catch { /* skip */ }
					}

					const patched = patchSkillFrontmatter(freshContent, {
						description: patchDescription,
						triggers: patchTriggers,
						tags: patchTags,
					});
					if (patched) {
						writeFileSync(skillMdPath, patched, "utf-8");
						logger.info("skills", "Wrote enrichment back to SKILL.md", { skill: skillName });
					}
				}
			}
		}

		logger.info("skills", "Graph node created for skill", {
			skill: skillName,
			entityId: result.entityId,
			enriched: result.enriched,
			embeddingCreated: result.embeddingCreated,
		});
	} catch (e) {
		logger.error("skills", "Failed to create graph node for skill", e as Error, {
			skill: skillName,
		});
	}
}

/**
 * Before a skill is uninstalled from the filesystem, remove its graph node.
 */
function onSkillUninstalling(skillName: string): void {
	const accessor = getAccessorSafe();
	if (!accessor) return;

	try {
		const result = uninstallSkillNode({ skillName }, accessor);
		if (result.removed) {
			logger.info("skills", "Graph node removed for skill", {
				skill: skillName,
				entityId: result.entityId,
			});
		}
	} catch (e) {
		logger.error("skills", "Failed to remove graph node for skill", e as Error, {
			skill: skillName,
		});
	}
}

export function mountSkillsRoutes(app: Hono): void {
	// GET /api/skills - list installed skills
	app.get("/api/skills", (c) => {
		try {
			const skills = listInstalledSkills();
			return c.json({ skills, count: skills.length });
		} catch (e) {
			logger.error("skills", "Error listing skills", e as Error);
			return c.json({
				skills: [],
				count: 0,
				error: "Failed to list skills",
			});
		}
	});

	// GET /api/skills/browse - browse all skills (skills.sh + ClawHub)
	app.get("/api/skills/browse", async (c) => {
		const [skillsShCatalog, clawhubItems] = await Promise.all([fetchCatalog(), fetchClawhubCatalog()]);
		const installed = listInstalledSkills().map((s) => s.name);

		const skillsShResults: SkillBrowseResult[] = skillsShCatalog.map((s) => ({
			name: s.name,
			fullName: `${s.source}@${s.skillId}`,
			installs: formatInstalls(s.installs),
			installsRaw: s.installs,
			popularityScore: calculateSkillPopularity({ installsRaw: s.installs }),
			description: "",
			installed: installed.includes(s.name),
			provider: "skills.sh" as const,
			category: inferSkillCategory(`${s.name} ${s.skillId} ${s.source}`),
			downloads: s.installs,
			maintainer: s.source.split("/")[0] || undefined,
		}));

		const clawhubResults: SkillBrowseResult[] = clawhubItems.map((s) => ({
			name: s.slug,
			fullName: `clawhub@${s.slug}`,
			installs: formatInstalls(s.stats.installsAllTime),
			installsRaw: s.stats.installsAllTime,
			popularityScore: calculateSkillPopularity({
				installsRaw: s.stats.installsAllTime,
				stars: s.stats.stars,
			}),
			description: s.summary,
			installed: installed.includes(s.slug),
			provider: "clawhub" as const,
			category: inferSkillCategory(`${s.slug} ${s.summary} ${s.tags.latest}`),
			stars: s.stats.stars,
			downloads: s.stats.downloads,
			versions: s.stats.versions,
			author: s.displayName,
			maintainer: s.displayName,
		}));

		const results = [...skillsShResults, ...clawhubResults].sort((a, b) => b.popularityScore - a.popularityScore);
		return c.json({ results, total: results.length });
	});

	// GET /api/skills/search?q=query - search both skills.sh and ClawHub
	app.get("/api/skills/search", async (c) => {
		const query = c.req.query("q");
		if (!query) {
			return c.json({ results: [], error: "Query parameter q is required" }, 400);
		}

		logger.info("skills", "Searching skills", { query });
		const installed = listInstalledSkills().map((s) => s.name);
		const lowerQuery = query.toLowerCase();

		// Search skills.sh API + filter cached ClawHub in parallel
		const [skillsShResults, clawhubFiltered] = await Promise.all([
			(async (): Promise<SkillBrowseResult[]> => {
				try {
					const res = await fetch(`https://skills.sh/api/search?q=${encodeURIComponent(query)}`, {
						headers: { "User-Agent": "signet-daemon" },
					});
					if (!res.ok) throw new Error(`skills.sh returned ${res.status}`);
					const data = (await res.json()) as {
						skills: Array<{
							id: string;
							skillId: string;
							name: string;
							installs: number;
							source: string;
						}>;
					};
					return (data.skills ?? []).map((s) => ({
						name: s.name,
						fullName: `${s.source}@${s.skillId}`,
						installs: formatInstalls(s.installs),
						installsRaw: s.installs,
						popularityScore: calculateSkillPopularity({ installsRaw: s.installs }),
						description: "",
						installed: installed.includes(s.name),
						provider: "skills.sh" as const,
						category: inferSkillCategory(`${s.name} ${s.skillId} ${s.source}`),
						downloads: s.installs,
						maintainer: s.source.split("/")[0] || undefined,
					}));
				} catch (err) {
					logger.error("skills", "skills.sh search failed", err as Error);
					return [];
				}
			})(),
			(async (): Promise<SkillBrowseResult[]> => {
				const cached = await fetchClawhubCatalog();
				return cached
					.filter(
						(s) =>
							s.slug.toLowerCase().includes(lowerQuery) ||
							s.displayName.toLowerCase().includes(lowerQuery) ||
							s.summary.toLowerCase().includes(lowerQuery),
					)
					.map((s) => ({
						name: s.slug,
						fullName: `clawhub@${s.slug}`,
						installs: formatInstalls(s.stats.installsAllTime),
						installsRaw: s.stats.installsAllTime,
						popularityScore: calculateSkillPopularity({
							installsRaw: s.stats.installsAllTime,
							stars: s.stats.stars,
						}),
						description: s.summary,
						installed: installed.includes(s.slug),
						provider: "clawhub" as const,
						category: inferSkillCategory(`${s.slug} ${s.summary} ${s.tags.latest}`),
						stars: s.stats.stars,
						downloads: s.stats.downloads,
						versions: s.stats.versions,
						author: s.displayName,
						maintainer: s.displayName,
					}));
			})(),
		]);

		const results = [...skillsShResults, ...clawhubFiltered].sort((a, b) => b.popularityScore - a.popularityScore);
		return c.json({ results });
	});

	// GET /api/skills/:name - get skill details and SKILL.md content
	app.get("/api/skills/:name", async (c) => {
		const name = c.req.param("name");
		if (!name || name.includes("/") || name.includes("..")) {
			return c.json({ error: "Invalid skill name" }, 400);
		}

		// Try local install first
		const skillMdPath = join(getSkillsDir(), name, "SKILL.md");
		if (existsSync(skillMdPath)) {
			try {
				const content = readFileSync(skillMdPath, "utf-8");
				const meta = parseSkillFrontmatter(content);
				return c.json({
					name,
					...meta,
					path: join(getSkillsDir(), name),
					content,
				});
			} catch (e) {
				logger.error("skills", "Error reading skill", e as Error);
				return c.json({ error: "Failed to read skill" }, 500);
			}
		}

		// Fallback: fetch SKILL.md from GitHub via repo tree search
		const source = c.req.query("source");
		const repo = source ? source.split("@")[0] : catalogCache.find((s) => s.name === name)?.source;

		if (repo) {
			try {
				const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/main?recursive=1`, {
					headers: { Accept: "application/vnd.github.v3+json" },
				});
				if (treeRes.ok) {
					const tree = (await treeRes.json()) as {
						tree: { path: string }[];
					};
					const needle = `${name}/SKILL.md`;
					const match = tree.tree.find((t) => t.path.endsWith(needle));
					if (match) {
						const rawUrl = `https://raw.githubusercontent.com/${repo}/main/${match.path}`;
						const mdRes = await fetch(rawUrl);
						if (mdRes.ok) {
							const content = await mdRes.text();
							const meta = parseSkillFrontmatter(content);
							return c.json({ name, ...meta, content });
						}
					}
				}
			} catch (e) {
				logger.warn("skills", "GitHub SKILL.md fetch failed", {
					name,
					error: (e as Error).message,
				});
			}
		}

		return c.json({ error: `Skill '${name}' not found` }, 404);
	});

	// POST /api/skills/install - install a skill
	app.post("/api/skills/install", async (c) => {
		let body: { name?: string; source?: string } = {};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const { name, source } = body;
		if (!name) {
			return c.json({ error: "name is required" }, 400);
		}

		// Sanitize: allow alphanumeric, dash, underscore, slash (for owner/repo)
		if (!/^[\w\-./]+$/.test(name)) {
			return c.json({ error: "Invalid skill name" }, 400);
		}

		const pkg = source || name;
		logger.info("skills", "Installing skill", { name, pkg });
		const packageManager = resolvePrimaryPackageManager({
			agentsDir: getAgentsDir(),
			env: process.env,
		});
		const skillsCommand = getSkillsRunnerCommand(packageManager.family, ["add", pkg, "--global", "--yes"]);

		logger.info("skills", "Using package manager", {
			command: `${skillsCommand.command} ${skillsCommand.args.join(" ")}`,
			family: packageManager.family,
			source: packageManager.source,
			reason: packageManager.reason,
		});

		return new Promise<Response>((resolve) => {
			const proc = spawn(skillsCommand.command, skillsCommand.args, {
				env: { ...process.env },
				timeout: 60000,
			});

			let stdout = "";
			let stderr = "";
			proc.stdout.on("data", (d: Buffer) => {
				stdout += d.toString();
			});
			proc.stderr.on("data", (d: Buffer) => {
				stderr += d.toString();
			});

			proc.on("close", (code) => {
				if (code === 0) {
					logger.info("skills", "Skill installed", { name });
					// Fire-and-forget graph node creation
					onSkillInstalled(name).catch((e) => {
						logger.error("skills", "Post-install graph hook failed", e as Error);
					});
					resolve(c.json({ success: true, name, output: stdout }));
				} else {
					const errMsg = stderr || stdout || `Install exited with code ${code}`;
					logger.error("skills", "Skill install failed", undefined, {
						stderr,
					});
					resolve(c.json({ success: false, error: errMsg }, 500));
				}
			});

			proc.on("error", (err: Error) => {
				resolve(c.json({ success: false, error: err.message }, 500));
			});
		});
	});

	// DELETE /api/skills/:name - uninstall a skill
	app.delete("/api/skills/:name", (c) => {
		const name = c.req.param("name");
		if (!name || name.includes("/") || name.includes("..")) {
			return c.json({ error: "Invalid skill name" }, 400);
		}

		const skillDir = join(getSkillsDir(), name);
		if (!existsSync(skillDir)) {
			return c.json({ error: `Skill '${name}' not found` }, 404);
		}

		try {
			// Remove graph node before filesystem cleanup
			onSkillUninstalling(name);
			rmSync(skillDir, { recursive: true, force: true });
			logger.info("skills", "Skill removed", { name });
			return c.json({ success: true, name, message: `Removed ${name}` });
		} catch (e) {
			logger.error("skills", "Error removing skill", e as Error);
			return c.json({ success: false, error: "Failed to remove skill" }, 500);
		}
	});
}
