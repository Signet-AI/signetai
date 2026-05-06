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
	type NativeMemoryBridgeHandle,
	obsidianNativeMemorySource,
	purgeNativeMemorySourceArtifacts,
	startNativeMemoryBridge,
} from "../native-memory-sources";
import type { SourceEmbeddingFetch } from "../obsidian-source-embeddings";

type SourceIndexJobStatus = "queued" | "running" | "complete" | "error";

interface SourceIndexJob {
	readonly id: string;
	readonly sourceId: string;
	readonly status: SourceIndexJobStatus;
	readonly queuedAt: string;
	readonly startedAt?: string;
	readonly finishedAt?: string;
	readonly scanned?: number;
	readonly total?: number;
	readonly indexed?: number;
	readonly currentPath?: string;
	readonly error?: string;
}

interface SourceIndexJobInput {
	readonly source: SignetSourceEntry;
	readonly agentsDir: string;
	readonly loadMemoryConfig: (agentsDir: string) => ResolvedMemoryConfig;
	readonly fetchEmbedding: SourceEmbeddingFetch;
	readonly startBridge: typeof startNativeMemoryBridge;
	readonly purgeNativeSource: typeof purgeNativeMemorySourceArtifacts;
}

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

const sourceIndexJobs = new Map<string, SourceIndexJob>();
const sourceIndexInFlight = new Set<string>();
const canceledSourceIndexJobs = new Set<string>();

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
			sources: config.sources.map((source) => ({
				...source,
				stats: sourceStats(source, agentId),
				indexJob: sourceIndexJobs.get(source.id),
			})),
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

		const job = enqueueSourceIndexJob({
			source: result.source,
			agentsDir,
			loadMemoryConfig,
			fetchEmbedding,
			startBridge,
			purgeNativeSource,
		});

		return c.json({ source: result.source, created: result.created, indexed: 0, queued: true, job }, 202);
	});

	app.delete("/api/sources/:sourceId", (c) => {
		const sourceId = c.req.param("sourceId");
		const result = removeSource(sourceId, agentsDir);
		if (result.ok === false) return c.json({ error: result.error }, 404);
		const job = sourceIndexJobs.get(result.source.id);
		if (job && (job.status === "queued" || job.status === "running")) canceledSourceIndexJobs.add(job.id);
		sourceIndexJobs.delete(result.source.id);

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

function enqueueSourceIndexJob(input: SourceIndexJobInput): SourceIndexJob {
	const existing = sourceIndexJobs.get(input.source.id);
	if (existing && (existing.status === "queued" || existing.status === "running")) return existing;

	const job: SourceIndexJob = {
		id: `source-index:${input.source.id}:${Date.now()}`,
		sourceId: input.source.id,
		status: "queued",
		queuedAt: new Date().toISOString(),
	};
	sourceIndexJobs.set(input.source.id, job);
	setTimeout(() => {
		void runSourceIndexJob(input, job);
	}, 0).unref?.();
	return job;
}

async function runSourceIndexJob(input: SourceIndexJobInput, job: SourceIndexJob): Promise<void> {
	if (sourceIndexInFlight.has(input.source.id)) return;
	sourceIndexInFlight.add(input.source.id);
	const started: SourceIndexJob = {
		...job,
		status: "running",
		startedAt: new Date().toISOString(),
	};
	sourceIndexJobs.set(input.source.id, started);

	let bridge: NativeMemoryBridgeHandle | null = null;

	try {
		const memoryConfig = input.loadMemoryConfig(input.agentsDir);
		bridge = input.startBridge(
			[obsidianNativeMemorySource(input.source.root, input.source.name, input.source.id, input.source.excludeGlobs)],
			{
				pollIntervalMs: 0,
				embeddingConfig: memoryConfig.embedding,
				fetchEmbedding: input.fetchEmbedding,
				agentsDir: input.agentsDir,
				yieldEveryFiles: 1,
				onFileIndexed: (event) => {
					sourceIndexJobs.set(input.source.id, {
						...started,
						status: "running",
						scanned: event.scanned,
						total: event.total,
						indexed: event.changed,
						currentPath: event.filePath,
					});
				},
			},
		);
		const indexed = await bridge.syncExisting();
		markSourceIndexed(input.source.id, undefined, input.agentsDir);
		const current = sourceIndexJobs.get(input.source.id) ?? started;
		sourceIndexJobs.set(input.source.id, {
			...current,
			status: "complete",
			finishedAt: new Date().toISOString(),
			indexed,
		});
	} catch (err) {
		const current = sourceIndexJobs.get(input.source.id) ?? started;
		sourceIndexJobs.set(input.source.id, {
			...current,
			status: "error",
			finishedAt: new Date().toISOString(),
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		await bridge?.close().catch(() => undefined);
		if (canceledSourceIndexJobs.delete(job.id)) {
			input.purgeNativeSource(
				obsidianNativeMemorySource(input.source.root, input.source.name, input.source.id, input.source.excludeGlobs),
				resolveDaemonAgentId(),
			);
		}
		sourceIndexInFlight.delete(input.source.id);
	}
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
