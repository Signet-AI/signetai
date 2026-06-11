/**
 * Skills API routes — extracted from daemon.ts
 *
 * Handles skill listing, browsing, searching, installing, and uninstalling.
 * Integrates with the procedural memory graph for skill discovery.
 */

import { spawn } from "node:child_process";
import {
	cpSync,
	createWriteStream,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { getSkillsRunnerCommand, resolvePrimaryPackageManager } from "@signetai/core";
import type { Hono } from "hono";
import type { Entry, ZipFile } from "yauzl";
import * as yauzl from "yauzl";
import type { AuthMode } from "../auth/index.js";
import { type DbAccessor, getDbAccessor } from "../db-accessor.js";
import { getLlmProvider } from "../llm.js";
import { logger } from "../logger.js";
import { type EmbeddingConfig, type PipelineV2Config, loadMemoryConfig } from "../memory-config.js";
import type { LlmProvider } from "../pipeline/provider.js";
import { parseSkillFile, patchSkillFrontmatter } from "../pipeline/skill-frontmatter.js";
import { installSkillNode, uninstallSkillNode } from "../pipeline/skill-graph.js";

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
	provider: "skills.sh" | "clawhub" | "signet";
	category: string;
	stars?: number;
	downloads?: number;
	versions?: number;
	author?: string;
	maintainer?: string;
	verified?: boolean;
	permissions?: string[];
	official?: boolean;
	builtin?: boolean;
};

// ---------------------------------------------------------------------------
// Cache state (module-private)
// ---------------------------------------------------------------------------

let catalogCache: CatalogEntry[] = [];
let catalogFetchedAt = 0;
let clawhubCache: ClawhubItem[] = [];
let clawhubFetchedAt = 0;
const CATALOG_TTL = 10 * 60 * 1000;
const CATALOG_FETCH_TIMEOUT_MS = 1500;
const CLAWHUB_DOWNLOAD_BASE = process.env.CLAWHUB_DOWNLOAD_BASE ?? "https://clawhub.ai/api/v1/download";
const MAX_CLAWHUB_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_CLAWHUB_ZIP_ENTRIES = 500;
const MAX_CLAWHUB_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_CLAWHUB_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

async function fetchCatalogUrl(url: string, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, {
			headers: { "User-Agent": "signet-daemon" },
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
	}
}

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
		const res = await fetchCatalogUrl("https://skills.sh", CATALOG_FETCH_TIMEOUT_MS);
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
		const deadline = now + CATALOG_FETCH_TIMEOUT_MS;
		let page = 0;
		while (page < MAX_PAGES && items.length < MAX_ITEMS && Date.now() < deadline) {
			const url = new URL("https://clawhub.ai/api/v1/skills");
			url.searchParams.set("sort", "downloads");
			url.searchParams.set("limit", "50");
			if (cursor) url.searchParams.set("cursor", cursor);

			const res = await fetchCatalogUrl(url.toString(), Math.max(1, deadline - Date.now()));
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
// Signet official skills (from repo root skills/)
// ---------------------------------------------------------------------------

function getSignetSkillsSourceDir(): string | null {
	if (process.env.SIGNET_SKILLS_SOURCE && existsSync(process.env.SIGNET_SKILLS_SOURCE)) {
		return process.env.SIGNET_SKILLS_SOURCE;
	}
	// Dev: monorepo root skills/ (daemon src is platform/daemon/src/routes/)
	const devPath = join(__dirname, "..", "..", "..", "..", "skills");
	if (existsSync(devPath)) return devPath;
	// Dist: skills/ next to dist/
	const distPath = join(__dirname, "..", "..", "skills");
	if (existsSync(distPath)) return distPath;
	const distPath2 = join(__dirname, "..", "skills");
	if (existsSync(distPath2)) return distPath2;
	return null;
}

function listSignetOfficialSkills(): SkillBrowseResult[] {
	const sourceDir = getSignetSkillsSourceDir();
	if (!sourceDir || !existsSync(sourceDir)) return [];

	const installed = listInstalledSkills().map((s) => s.name);

	return readdirSync(sourceDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.flatMap((d) => {
			const skillMdPath = join(sourceDir, d.name, "SKILL.md");
			if (!existsSync(skillMdPath)) return [];
			try {
				const content = readFileSync(skillMdPath, "utf-8");
				const meta = parseSkillFrontmatter(content);
				const isBuiltin = /^builtin:\s*true$/m.test(content);
				return [
					{
						name: d.name,
						fullName: "Signet-AI/signetai",
						installs: isBuiltin ? "built-in" : "--",
						installsRaw: isBuiltin ? 100_000 : 10_000,
						popularityScore: isBuiltin ? 200_000 : 50_000,
						description: meta.description,
						installed: installed.includes(d.name),
						provider: "signet" as const,
						category: inferSkillCategory(`${d.name} ${meta.description}`),
						author: "Signet AI",
						maintainer: "Signet-AI/signetai",
						verified: true,
						permissions: meta.permissions,
						official: true,
						builtin: isBuiltin,
					},
				];
			} catch {
				return [];
			}
		});
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
	try {
		return getDbAccessor();
	} catch {
		return null;
	}
}

function getProviderSafe(): LlmProvider | null {
	try {
		return getLlmProvider();
	} catch {
		return null;
	}
}

type SkillInstallPlan =
	| {
			kind: "skills-cli";
			pkg: string;
			args: string[];
	  }
	| {
			kind: "clawhub";
			slug: string;
	  };

export function buildSkillInstallPlan(name: string, source?: string): SkillInstallPlan {
	if (source?.startsWith("clawhub@")) {
		const slug = source.slice("clawhub@".length);
		return { kind: "clawhub", slug: slug || name };
	}

	const pkg = source || name;
	const args = ["add", pkg, "--global", "--yes"];
	if (source && source !== name && /^[\w-]+\/[\w.-]+$/.test(source)) {
		args.push("--skill", name);
	}
	return { kind: "skills-cli", pkg, args };
}

type ClawhubZipEntryKind = "file" | "directory";

type ClawhubZipEntryMetadata = {
	fileName: string;
	externalFileAttributes: number;
	uncompressedSize?: number;
	versionMadeBy: number;
	encrypted?: boolean;
};

const ZIP_UNIX_HOST = 3;
const ZIP_MODE_TYPE_MASK = 0o170000;
const ZIP_MODE_DIRECTORY = 0o040000;
const ZIP_MODE_REGULAR_FILE = 0o100000;

function normalizeZipEntryPath(entry: string): string | null {
	const normalized = entry.replaceAll("\\", "/");
	if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
		return null;
	}
	const path = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	if (!path) return null;
	return path.split("/").every((part) => part && part !== "." && part !== "..") ? path : null;
}

export function validateClawhubZipEntryMetadata(
	entry: ClawhubZipEntryMetadata,
): { ok: true; path: string; kind: ClawhubZipEntryKind } | { ok: false; error: string } {
	const path = normalizeZipEntryPath(entry.fileName);
	if (!path) return { ok: false, error: "ClawHub zip contains unsafe paths" };
	if (entry.encrypted) return { ok: false, error: "ClawHub zip contains encrypted entries" };
	if (entry.uncompressedSize !== undefined && entry.uncompressedSize > MAX_CLAWHUB_ENTRY_BYTES) {
		return { ok: false, error: "ClawHub zip entry is too large" };
	}

	const unixMode = entry.versionMadeBy >> 8 === ZIP_UNIX_HOST ? entry.externalFileAttributes >>> 16 : 0;
	const impliedDirectory = entry.fileName.replaceAll("\\", "/").endsWith("/");
	if (unixMode === 0) return { ok: true, path, kind: impliedDirectory ? "directory" : "file" };

	const kind = unixMode & ZIP_MODE_TYPE_MASK;
	if (kind === ZIP_MODE_DIRECTORY) return { ok: true, path, kind: "directory" };
	if (kind === ZIP_MODE_REGULAR_FILE && !impliedDirectory) return { ok: true, path, kind: "file" };
	return { ok: false, error: "ClawHub zip contains unsupported entry types" };
}

export function validateExtractedSkillTree(root: string): { ok: true } | { ok: false; error: string } {
	const skillMd = join(root, "SKILL.md");
	if (!existsSync(skillMd)) {
		return { ok: false, error: "ClawHub package did not contain a root SKILL.md" };
	}
	if (!lstatSync(skillMd).isFile()) {
		return { ok: false, error: "ClawHub package root SKILL.md must be a regular file" };
	}

	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isSymbolicLink()) {
				return { ok: false, error: "ClawHub package contains symbolic links" };
			}
			if (entry.isDirectory()) {
				stack.push(path);
				continue;
			}
			if (!entry.isFile()) {
				return { ok: false, error: "ClawHub package contains non-regular files" };
			}
		}
	}

	return { ok: true };
}

function openZip(path: string): Promise<ZipFile> {
	return new Promise((resolveZip, reject) => {
		yauzl.open(
			path,
			{
				autoClose: true,
				lazyEntries: true,
				strictFileNames: true,
				validateEntrySizes: true,
			},
			(err, zip) => {
				if (err) {
					reject(err);
					return;
				}
				if (!zip) {
					reject(new Error("Unable to open ClawHub zip"));
					return;
				}
				resolveZip(zip);
			},
		);
	});
}

function openZipEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
	return new Promise((resolveStream, reject) => {
		zip.openReadStream(entry, (err, stream) => {
			if (err) {
				reject(err);
				return;
			}
			resolveStream(stream);
		});
	});
}

function resolveExtractPath(root: string, entryPath: string): string | null {
	const target = resolve(root, entryPath);
	const rel = relative(resolve(root), target);
	return !rel || rel.startsWith("..") || isAbsolute(rel) ? null : target;
}

async function extractClawhubZip(
	zipPath: string,
	extractDir: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const zip = await openZip(zipPath);
	return new Promise((resolveExtract) => {
		let done = false;
		let entries = 0;
		let totalUncompressedBytes = 0;
		const fail = (error: string): void => {
			if (done) return;
			done = true;
			zip.close();
			resolveExtract({ ok: false, error });
		};
		const pass = (): void => {
			if (done) return;
			done = true;
			resolveExtract({ ok: true });
		};

		zip.on("error", (err) => fail(err.message));
		zip.on("end", pass);
		zip.on("entry", (entry: Entry) => {
			entries += 1;
			totalUncompressedBytes += entry.uncompressedSize;
			if (entries > MAX_CLAWHUB_ZIP_ENTRIES) {
				fail("ClawHub zip contains too many entries");
				return;
			}
			if (totalUncompressedBytes > MAX_CLAWHUB_UNCOMPRESSED_BYTES) {
				fail("ClawHub zip uncompressed content is too large");
				return;
			}

			const validation = validateClawhubZipEntryMetadata({
				fileName: entry.fileName,
				externalFileAttributes: entry.externalFileAttributes,
				uncompressedSize: entry.uncompressedSize,
				versionMadeBy: entry.versionMadeBy,
				encrypted: entry.isEncrypted(),
			});
			if (!validation.ok) {
				fail(validation.error);
				return;
			}

			const target = resolveExtractPath(extractDir, validation.path);
			if (!target) {
				fail("ClawHub zip contains unsafe paths");
				return;
			}

			if (validation.kind === "directory") {
				mkdirSync(target, { recursive: true });
				zip.readEntry();
				return;
			}

			mkdirSync(dirname(target), { recursive: true });
			openZipEntryStream(zip, entry)
				.then((stream) => pipeline(stream, createWriteStream(target)))
				.then(() => zip.readEntry())
				.catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
		});
		zip.readEntry();
	});
}

async function writeResponseBodyToFileWithLimit(
	res: Response,
	path: string,
	limit: number,
): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
	const header = res.headers.get("content-length");
	if (header) {
		const bytes = Number(header);
		if (Number.isFinite(bytes) && bytes > limit) {
			return { ok: false, error: "ClawHub download is too large" };
		}
	}
	if (!res.body) return { ok: false, error: "ClawHub download did not include a response body" };

	const reader = res.body.getReader();
	const output = createWriteStream(path);
	let bytes = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > limit) {
				output.destroy();
				return { ok: false, error: "ClawHub download is too large" };
			}
			await new Promise<void>((resolveWrite, rejectWrite) => {
				output.write(chunk.value, (err) => {
					if (err) rejectWrite(err);
					else resolveWrite();
				});
			});
		}
		await new Promise<void>((resolveEnd) => output.end(resolveEnd));
		return { ok: true, bytes };
	} finally {
		reader.releaseLock();
	}
}

const clawhubInstallLocks = new Map<string, Promise<unknown>>();

export async function withClawhubInstallLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
	const prev = clawhubInstallLocks.get(slug) ?? Promise.resolve();
	const next = prev.catch(() => undefined).then(fn);
	clawhubInstallLocks.set(slug, next);
	try {
		return await next;
	} finally {
		if (clawhubInstallLocks.get(slug) === next) {
			clawhubInstallLocks.delete(slug);
		}
	}
}

export function replaceSkillDirectoryAtomically(sourceDir: string, targetDir: string): void {
	const skillsDir = dirname(targetDir);
	const targetName = targetDir.split(/[\\/]/).pop() ?? "skill";
	const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const stagingDir = join(skillsDir, `.${targetName}.${suffix}.tmp`);
	const backupDir = join(skillsDir, `.${targetName}.${suffix}.bak`);
	let movedTarget = false;

	try {
		rmSync(stagingDir, { recursive: true, force: true });
		rmSync(backupDir, { recursive: true, force: true });
		cpSync(sourceDir, stagingDir, { recursive: true });
		if (existsSync(targetDir)) {
			renameSync(targetDir, backupDir);
			movedTarget = true;
		}
		renameSync(stagingDir, targetDir);
		rmSync(backupDir, { recursive: true, force: true });
	} catch (err) {
		rmSync(stagingDir, { recursive: true, force: true });
		if (movedTarget && existsSync(backupDir) && !existsSync(targetDir)) {
			renameSync(backupDir, targetDir);
		}
		rmSync(backupDir, { recursive: true, force: true });
		throw err;
	}
}

async function installClawhubSkill(
	slug: string,
): Promise<{ success: true; output: string } | { success: false; error: string }> {
	if (!/^[\w.-]+$/.test(slug)) {
		return { success: false, error: "Invalid ClawHub skill slug" };
	}

	const tempRoot = mkdtempSync(join(tmpdir(), "signet-clawhub-skill-"));
	const zipPath = join(tempRoot, `${slug}.zip`);
	const extractDir = join(tempRoot, "extract");
	const targetDir = join(getSkillsDir(), slug);

	try {
		const url = new URL(CLAWHUB_DOWNLOAD_BASE);
		url.searchParams.set("slug", slug);
		const res = await fetch(url, { headers: { "User-Agent": "signet-daemon" } });
		if (!res.ok) {
			return { success: false, error: `ClawHub download failed with HTTP ${res.status}` };
		}

		const download = await writeResponseBodyToFileWithLimit(res, zipPath, MAX_CLAWHUB_ZIP_BYTES);
		if (!download.ok) {
			return { success: false, error: download.error };
		}

		mkdirSync(extractDir, { recursive: true });
		const extracted = await extractClawhubZip(zipPath, extractDir);
		if (!extracted.ok) {
			return { success: false, error: extracted.error };
		}

		const validation = validateExtractedSkillTree(extractDir);
		if (!validation.ok) {
			return { success: false, error: validation.error };
		}

		mkdirSync(getSkillsDir(), { recursive: true });
		const resolvedTarget = resolve(targetDir);
		const resolvedSkillsDir = resolve(getSkillsDir());
		const targetRelative = relative(resolvedSkillsDir, resolvedTarget);
		if (!targetRelative || targetRelative.startsWith("..") || isAbsolute(targetRelative)) {
			return { success: false, error: "Invalid ClawHub install target" };
		}

		await withClawhubInstallLock(slug, async () => replaceSkillDirectoryAtomically(extractDir, targetDir));
		return { success: true, output: `Installed ClawHub skill ${slug}` };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
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
				const enrichedFm = accessor.withReadDb(
					(db) =>
						db.prepare("SELECT triggers, tags FROM skill_meta WHERE entity_id = ?").get(result.entityId) as
							| { triggers: string | null; tags: string | null }
							| undefined,
				);

				if (enrichedFm) {
					// Build a properly typed patch from DB values
					let patchDescription: string | undefined;
					let patchTriggers: readonly string[] | undefined;
					let patchTags: readonly string[] | undefined;

					const entity = accessor.withReadDb(
						(db) =>
							db.prepare("SELECT description FROM entities WHERE id = ?").get(result.entityId) as
								| { description: string | null }
								| undefined,
					);
					if (entity?.description) patchDescription = entity.description;
					if (enrichedFm.triggers) {
						try {
							const parsed: unknown = JSON.parse(enrichedFm.triggers);
							if (Array.isArray(parsed)) patchTriggers = parsed.filter((v): v is string => typeof v === "string");
						} catch {
							/* skip */
						}
					}
					if (enrichedFm.tags) {
						try {
							const parsed: unknown = JSON.parse(enrichedFm.tags);
							if (Array.isArray(parsed)) patchTags = parsed.filter((v): v is string => typeof v === "string");
						} catch {
							/* skip */
						}
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

export function mountSkillsRoutes(app: Hono, _authMode: AuthMode = "local"): void {
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

	// GET /api/skills/browse - browse all skills (signet + skills.sh + ClawHub)
	app.get("/api/skills/browse", async (c) => {
		const [skillsShCatalog, clawhubItems, signetSkills] = await Promise.all([
			fetchCatalog(),
			fetchClawhubCatalog(),
			Promise.resolve(listSignetOfficialSkills()),
		]);
		const installed = listInstalledSkills().map((s) => s.name);
		const signetNames = new Set(signetSkills.map((s) => s.name));

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

		// Deduplicate: prefer signet provider when a skill exists in multiple sources
		const external = [...skillsShResults, ...clawhubResults].filter((s) => !signetNames.has(s.name));
		const results = [...signetSkills, ...external].sort((a, b) => b.popularityScore - a.popularityScore);
		return c.json({ results, total: results.length });
	});

	// GET /api/skills/search?q=query - search signet + skills.sh + ClawHub
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

		// Filter signet official skills by query
		const signetFiltered = listSignetOfficialSkills().filter(
			(s) => s.name.toLowerCase().includes(lowerQuery) || s.description.toLowerCase().includes(lowerQuery),
		);
		const signetNames = new Set(signetFiltered.map((s) => s.name));
		const external = [...skillsShResults, ...clawhubFiltered].filter((s) => !signetNames.has(s.name));
		const results = [...signetFiltered, ...external].sort((a, b) => b.popularityScore - a.popularityScore);
		return c.json({ results });
	});

	// GET /api/skills/:name - get skill details and SKILL.md content
	app.get("/api/skills/:name", async (c) => {
		const name = c.req.param("name");
		if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
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

		// Try signet official skills source
		const signetDir = getSignetSkillsSourceDir();
		if (signetDir) {
			const signetSkillPath = join(signetDir, name, "SKILL.md");
			if (existsSync(signetSkillPath)) {
				try {
					const content = readFileSync(signetSkillPath, "utf-8");
					const meta = parseSkillFrontmatter(content);
					return c.json({
						name,
						...meta,
						content,
						official: true,
					});
				} catch (e) {
					logger.error("skills", "Error reading signet skill", e as Error);
				}
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

		const plan = buildSkillInstallPlan(name, source);
		logger.info("skills", "Installing skill", { name, source, plan });

		if (plan.kind === "clawhub") {
			const result = await installClawhubSkill(plan.slug);
			if (!result.success) {
				logger.error("skills", "ClawHub skill install failed", undefined, {
					slug: plan.slug,
					error: result.error,
				});
				return c.json({ success: false, error: result.error }, 500);
			}

			logger.info("skills", "ClawHub skill installed", { name, slug: plan.slug });
			onSkillInstalled(plan.slug).catch((e) => {
				logger.error("skills", "Post-install graph hook failed", e as Error);
			});
			return c.json({ success: true, name: plan.slug, output: result.output });
		}

		if (process.env.SIGNET_TEST_DISABLE_SKILLS_INSTALL === "1") {
			return c.json({ success: false, error: "Skill installation disabled for test" }, 503);
		}

		const packageManager = resolvePrimaryPackageManager({
			agentsDir: getAgentsDir(),
			env: process.env,
		});
		const skillsCommand = getSkillsRunnerCommand(packageManager.family, plan.args);

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
				windowsHide: true,
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
		if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
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
