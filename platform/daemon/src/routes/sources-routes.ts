import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { addObsidianSource, loadSourcesConfig, markSourceIndexed, removeSource } from "@signet/core";
import type { Hono } from "hono";
import { resolveDaemonAgentId } from "../agent-id";
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
		return c.json(loadSourcesConfig(agentsDir));
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
		const result = addObsidianSource({ root, name: body.name }, agentsDir);
		if (result.ok === false) return c.json({ error: result.error }, 400);

		const memoryConfig = loadMemoryConfig(agentsDir);
		const bridge = startBridge([obsidianNativeMemorySource(result.source.root, result.source.name, result.source.id)], {
			pollIntervalMs: 0,
			embeddingConfig: memoryConfig.embedding,
			fetchEmbedding,
		});
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
