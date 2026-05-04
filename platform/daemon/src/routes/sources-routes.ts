import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import {
	type SignetSourceEntry,
	addObsidianSource,
	loadSourcesConfig,
	markSourceIndexed,
	removeSource,
} from "@signet/core";
import type { Hono } from "hono";
import { resolveDaemonAgentId } from "../agent-id";
import { getDbAccessor } from "../db-accessor";
import { fetchEmbedding as defaultFetchEmbedding } from "../embedding-fetch";
import { type ResolvedMemoryConfig, loadMemoryConfig as defaultLoadMemoryConfig } from "../memory-config";
import {
	obsidianNativeMemorySource,
	purgeNativeMemorySourceArtifacts,
	startNativeMemoryBridge,
} from "../native-memory-sources";
import type { SourceEmbeddingFetch } from "../obsidian-source-embeddings";

const execFileAsync = promisify(execFile);

interface AddObsidianSourceBody {
	readonly path?: string;
	readonly root?: string;
	readonly name?: string;
	readonly excludeGlobs?: readonly string[];
}

interface PickDirectoryBody {
	readonly title?: string;
}

export interface RegisterSourcesRoutesDeps {
	readonly agentsDir?: string;
	readonly loadMemoryConfig?: (agentsDir: string) => ResolvedMemoryConfig;
	readonly fetchEmbedding?: SourceEmbeddingFetch;
	readonly startBridge?: typeof startNativeMemoryBridge;
	readonly purgeNativeSource?: typeof purgeNativeMemorySourceArtifacts;
}

export function registerSourcesRoutes(app: Hono, deps: RegisterSourcesRoutesDeps = {}): void {
	const agentsDir = deps.agentsDir ?? process.env.SIGNET_PATH ?? `${homedir()}/.agents`;
	const loadMemoryConfig = deps.loadMemoryConfig ?? defaultLoadMemoryConfig;
	const fetchEmbedding = deps.fetchEmbedding ?? defaultFetchEmbedding;
	const startBridge = deps.startBridge ?? startNativeMemoryBridge;
	const purgeNativeSource = deps.purgeNativeSource ?? purgeNativeMemorySourceArtifacts;
	app.get("/api/sources", (c) => {
		const config = loadSourcesConfig(agentsDir);
		const agentId = resolveDaemonAgentId();
		return c.json({
			version: config.version,
			sources: config.sources.map((source) => ({ ...source, stats: sourceStats(source, agentId) })),
		});
	});

	app.post("/api/sources/pick-directory", async (c) => {
		let body: PickDirectoryBody = {};
		try {
			body = (await c.req.json().catch(() => ({}))) as PickDirectoryBody;
		} catch {
			body = {};
		}

		const result = await pickDirectory(body.title ?? "Choose folder");
		if (result.ok === false) return c.json({ error: result.error }, 501);
		return c.json({ path: result.path });
	});

	app.post("/api/sources/obsidian", async (c) => {
		let body: AddObsidianSourceBody = {};
		try {
			body = (await c.req.json()) as AddObsidianSourceBody;
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const root = body.root ?? body.path ?? "";
		const excludeGlobs = Array.isArray(body.excludeGlobs)
			? body.excludeGlobs.filter((entry) => typeof entry === "string")
			: undefined;
		const result = addObsidianSource({ root, name: body.name, excludeGlobs }, agentsDir);
		if (result.ok === false) return c.json({ error: result.error }, 400);

		const memoryConfig = loadMemoryConfig(agentsDir);
		const bridge = startBridge(
			[
				obsidianNativeMemorySource(
					result.source.root,
					result.source.name,
					result.source.id,
					result.source.excludeGlobs,
				),
			],
			{
				pollIntervalMs: 0,
				embeddingConfig: memoryConfig.embedding,
				fetchEmbedding,
				agentsDir,
			},
		);
		let indexed = 0;
		try {
			indexed = await bridge.syncExisting();
			markSourceIndexed(result.source.id, undefined, agentsDir);
		} finally {
			await bridge.close();
		}

		return c.json({ source: result.source, created: result.created, indexed });
	});

	app.delete("/api/sources/:sourceId", (c) => {
		const sourceId = c.req.param("sourceId");
		const result = removeSource(sourceId, agentsDir);
		if (result.ok === false) return c.json({ error: result.error }, 404);

		const sourceAgentId = resolveDaemonAgentId();
		const purged =
			result.source.kind === "obsidian"
				? purgeNativeSource(
						obsidianNativeMemorySource(result.source.root, result.source.name, result.source.id),
						sourceAgentId,
					)
				: 0;
		return c.json({ source: result.source, purged });
	});
}

interface SourceStats {
	readonly artifacts: number;
	readonly chunks: number;
	readonly indexed: number;
}

function sourceStats(source: SignetSourceEntry, agentId: string): SourceStats {
	if (source.kind !== "obsidian") return { artifacts: 0, chunks: 0, indexed: 0 };
	const rootPrefix = `${source.root.replace(/\\/g, "/").replace(/\/$/, "")}/`;
	const chunkPrefix = `${source.id}:`;
	try {
		return getDbAccessor().withReadDb((db) => {
			const artifacts = countRow(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM memory_artifacts WHERE agent_id = ? AND harness = 'obsidian' AND source_path >= ? AND source_path < ? AND COALESCE(is_deleted, 0) = 0",
					)
					.get(agentId, rootPrefix, `${rootPrefix}\uffff`),
			);
			const chunks = countRow(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM embeddings WHERE agent_id = ? AND source_type = 'source_obsidian_chunk' AND source_id >= ? AND source_id < ?",
					)
					.get(agentId, chunkPrefix, `${chunkPrefix}\uffff`),
			);
			return { artifacts, chunks, indexed: artifacts };
		});
	} catch {
		return { artifacts: 0, chunks: 0, indexed: 0 };
	}
}

function countRow(row: unknown): number {
	return typeof row === "object" && row !== null && "n" in row && typeof (row as { n?: unknown }).n === "number"
		? (row as { n: number }).n
		: 0;
}

async function pickDirectory(title: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
	const trimmedTitle = title.trim() || "Choose folder";
	const candidates = pickerCommands(trimmedTitle);
	const errors: string[] = [];

	for (const candidate of candidates) {
		try {
			const { stdout } = await execFileAsync(candidate.command, candidate.args, { timeout: 120_000 });
			const path = stdout.trim();
			if (path) return { ok: true, path };
		} catch (err) {
			errors.push(`${candidate.command}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return {
		ok: false,
		error: `No native folder picker is available for this daemon environment. Tried: ${errors.join("; ")}`,
	};
}

function pickerCommands(title: string): Array<{ command: string; args: string[] }> {
	if (process.env.SIGNET_DIRECTORY_PICKER) {
		return [{ command: process.env.SIGNET_DIRECTORY_PICKER, args: [] }];
	}

	if (process.platform === "darwin") {
		return [
			{
				command: "osascript",
				args: ["-e", `POSIX path of (choose folder with prompt ${JSON.stringify(title)})`],
			},
		];
	}

	if (process.platform === "win32") {
		return [
			{
				command: "powershell.exe",
				args: [
					"-NoProfile",
					"-Command",
					`Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = ${JSON.stringify(title)}; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }`,
				],
			},
		];
	}

	return [
		{ command: "zenity", args: ["--file-selection", "--directory", "--title", title] },
		{ command: "kdialog", args: ["--title", title, "--getexistingdirectory", homedir()] },
	];
}
