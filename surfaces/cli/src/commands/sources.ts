import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { SignetSourceEntry } from "@signet/core";
import type { Command } from "commander";
import {
	type DaemonAddSourceResult,
	type SourcesDeps,
	addDiscordSourceFromCli,
	addGitHubSourceFromCli,
	addObsidianVaultSource,
	exportConfiguredSourceSnapshot,
	importConfiguredSourceSnapshot,
	controlTranscriptImport,
	importTranscriptFiles,
	listSources,
	removeConfiguredSource,
} from "../features/sources.js";
import type { DaemonApiCall, DaemonFetchResult, DaemonStreamResult } from "../lib/daemon.js";

export interface RegisterSourcesCommandsDeps extends SourcesDeps {
	readonly secretApiCall?: DaemonApiCall;
	readonly fetchDaemonResult?: <T>(
		path: string,
		opts?: RequestInit & { timeout?: number },
	) => Promise<DaemonFetchResult<T>>;
	readonly fetchDaemonRaw?: (path: string, opts?: RequestInit & { timeout?: number }) => Promise<DaemonStreamResult>;
}

async function uploadTranscriptFile(
	deps: RegisterSourcesCommandsDeps,
	agentId: string,
	jobId: string,
	fileId: string,
	fileName: string,
): Promise<DaemonStreamResult> {
	if (!deps.fetchDaemonRaw || !deps.fetchDaemonResult)
		return { ok: false, reason: "offline", error: "transcript uploads require the daemon" };
	const fetchStatus = deps.fetchDaemonResult;
	const base = `/api/sources/imports/${encodeURIComponent(jobId)}`;
	const query = `?agentId=${encodeURIComponent(agentId)}`;
	const getStatus = () =>
		fetchStatus<{
			files: Array<{
				id: string;
				state: string;
				upload_offset: number;
				upload_generation: number;
				upload_digest: string;
				upload_size: number | null;
			}>;
		}>(`${base}${query}`);
	const status = await getStatus();
	if (!status.ok) return status;
	const slot = status.data.files.find((file) => file.id === fileId);
	if (!slot) return { ok: false, reason: "http", error: "upload slot not found" };
	if (slot.state === "ready" || slot.state === "completed") return { ok: true, response: Response.json(slot) };
	const path = `${base}/files/${encodeURIComponent(fileId)}`;
	const handle = await open(fileName, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile() || (slot.upload_size !== null && slot.upload_size !== info.size))
			throw new Error("file size differs from the upload declaration");
		let chain = "";
		const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
		for (let offset = 0; offset < info.size; ) {
			const size = Math.min(
				1024 * 1024,
				info.size - offset,
				offset < slot.upload_offset ? slot.upload_offset - offset : Infinity,
			);
			const bytes = Buffer.alloc(size);
			let filled = 0;
			while (filled < size) {
				const read = await handle.read(bytes, filled, size - filled, offset + filled);
				if (!read.bytesRead) throw new Error("file changed during upload");
				filled += read.bytesRead;
			}
			const previousChain = chain;
			for (let cursor = 0; cursor < bytes.length; cursor += 64 * 1024) {
				const part = bytes.subarray(cursor, cursor + 64 * 1024);
				chain = hash(`${chain}:${hash(part)}:${part.length}`);
			}
			if (offset < slot.upload_offset) {
				if (offset + size === slot.upload_offset && chain !== slot.upload_digest)
					throw new Error("file prefix differs from the retained upload; reset the slot before replacing it");
			} else {
				for (let attempt = 0; ; attempt++) {
					const result = await deps.fetchDaemonRaw(`${path}${query}`, {
						method: "PATCH",
						timeout: 60_000,
						headers: {
							"upload-length": String(info.size),
							"upload-offset": String(offset),
							"upload-generation": String(slot.upload_generation),
							"upload-checksum": hash(bytes),
						},
						body: bytes,
					});
					if (result.ok) {
						await result.response.arrayBuffer();
						break;
					}
					if (
						attempt === 3 ||
						!(
							result.reason === "timeout" ||
							result.reason === "offline" ||
							[408, 429, 503].includes(result.status ?? 0)
						)
					)
						return result;
					await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
					const status = await getStatus();
					if (!status.ok) return status;
					const current = status.data.files.find((file) => file.id === fileId);
					if (
						!current ||
						current.upload_generation !== slot.upload_generation ||
						current.upload_size !== info.size ||
						!(
							(current.upload_offset === offset && current.upload_digest === previousChain) ||
							(current.upload_offset === offset + size && current.upload_digest === chain)
						)
					)
						throw new Error("upload changed while retrying; resume after verifying the retained prefix");
					// Replay even after a lost acknowledgement; the daemon verifies identical bytes.
				}
			}
			offset += size;
		}
		const after = await handle.stat();
		if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error("file changed during upload");
		return deps.fetchDaemonRaw(`${path}${info.size === 0 ? "" : "/finalize"}${query}`, {
			method: info.size === 0 ? "PUT" : "POST",
			timeout: 15 * 60_000,
			headers: { "upload-generation": String(slot.upload_generation), "upload-length": String(info.size) },
		});
	} catch (error) {
		return { ok: false, reason: "http", error: error instanceof Error ? error.message : "upload failed" };
	} finally {
		await handle.close();
	}
}

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

export function registerSourcesCommands(program: Command, deps: RegisterSourcesCommandsDeps): void {
	const sources = program.command("sources").description("Manage external read-only knowledge sources");

	const importCommand = sources
		.command("import <files...>")
		.description("Stage Agent transcript JSONL files as a durable import job")
		.requiredOption("--kind <kind>", "Import kind (transcripts)")
		.requiredOption("--schema <schema>", "Input schema (signet)")
		.requiredOption("--agent <id>", "Target agent id")
		.option("--json", "Emit daemon-shaped JSON");
	importCommand.action((files: string[], options: { kind: string; schema: string; agent: string; json?: boolean }) =>
		importTranscriptFiles(files, options, {
			createDaemonImport: deps.fetchDaemonResult
				? async (body) => {
						const result = await deps.fetchDaemonResult?.(
							`/api/sources/imports?agentId=${encodeURIComponent(options.agent)}`,
							{ method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
						);
						return result as DaemonFetchResult<import("../features/sources.js").SourceImportCreateResponse>;
					}
				: undefined,
			uploadDaemonImportFile: (jobId, fileId, fileName) =>
				uploadTranscriptFile(deps, options.agent, jobId, fileId, fileName),
			fetchDaemonImport: deps.fetchDaemonResult
				? async <T>(path: string, opts?: RequestInit) => {
						const result = await deps.fetchDaemonResult?.(
							`${path}${path.includes("?") ? "&" : "?"}agentId=${encodeURIComponent(options.agent)}`,
							opts,
						);
						return result as DaemonFetchResult<T>;
					}
				: undefined,
		}),
	);

	const imports = sources.command("imports");
	imports
		.command("upload <jobId> <fileId> <file>")
		.description("Resume an incomplete transcript upload, then finalize its Source")
		.requiredOption("--agent <id>", "Target agent id")
		.action(async (jobId: string, fileId: string, file: string, options: { agent: string }) => {
			const result = await uploadTranscriptFile(deps, options.agent, jobId, fileId, file);
			if (!result.ok) {
				console.error(result.error ?? result.reason);
				process.exitCode = 1;
				return;
			}
			console.log(await result.response.text());
		});

	for (const action of ["list", "status", "pause", "resume", "retry", "cancel"] as const) {
		const command = imports
			.command(action === "list" ? "list" : `${action} <jobId>`)
			.requiredOption("--agent <id>", "Target agent id")
			.option("--watch", "Poll until terminal (status only)")
			.option("--json", "Emit daemon-shaped JSON");
		command.action((jobId: string | undefined, options: { agent: string; watch?: boolean; json?: boolean }) =>
			controlTranscriptImport(action, jobId, options, {
				fetchDaemonImport: deps.fetchDaemonResult
					? async <T>(path: string, opts?: RequestInit) =>
							deps.fetchDaemonResult?.(
								`${path}${path.includes("?") ? "&" : "?"}agentId=${encodeURIComponent(options.agent)}`,
								opts,
							) as Promise<DaemonFetchResult<T>>
					: undefined,
			}),
		);
	}

	sources
		.command("list")
		.description("List configured external sources")
		.action(() => listSources(deps));

	sources
		.command("remove <sourceId>")
		.alias("disconnect")
		.description("Disconnect and purge a source from Signet")
		.action((sourceId: string) =>
			removeConfiguredSource(sourceId, {
				...deps,
				removeSourceFromDaemon: deps.secretApiCall
					? async (id) => {
							const result = await deps.secretApiCall?.(
								"DELETE",
								`/api/sources/${encodeURIComponent(id)}`,
								undefined,
								30_000,
							);
							if (!result?.ok) {
								const error =
									typeof result?.data === "object" && result.data !== null && "error" in result.data
										? String((result.data as { error?: unknown }).error)
										: "daemon request failed";
								return { ok: false, error };
							}
							const data = result.data as { source?: { name?: string; root?: string }; purged?: number };
							return { ok: true, source: data.source, purged: data.purged };
						}
					: undefined,
			}),
		);

	const snapshot = sources.command("snapshot").description("Export or import source-owned snapshot data");

	snapshot
		.command("export <sourceId>")
		.description("Export source-owned artifacts as a JSON snapshot")
		.option("--out <path>", "Write snapshot JSON to a file instead of stdout")
		.option("--include-local-discord", "Include local Discord @me desktop-cache artifacts")
		.action((sourceId: string, options: { out?: string; includeLocalDiscord?: boolean }) =>
			exportConfiguredSourceSnapshot(sourceId, options, {
				...deps,
				exportSourceSnapshotFromDaemon: deps.secretApiCall
					? async (id, exportOptions) => {
							const query = exportOptions.includeLocalDiscord ? "?includeLocalDiscord=true" : "";
							const result = await deps.secretApiCall?.(
								"GET",
								`/api/sources/${encodeURIComponent(id)}/snapshot${query}`,
								undefined,
								30_000,
							);
							if (!result?.ok) return { ok: false, error: errorFromDaemonData(result?.data) };
							const data = result.data as { artifacts?: unknown[]; skipped?: { localDiscordArtifacts?: number } };
							return {
								ok: true,
								snapshot: result.data,
								artifactCount: Array.isArray(data.artifacts) ? data.artifacts.length : 0,
								skippedLocalDiscordArtifacts:
									typeof data.skipped?.localDiscordArtifacts === "number" ? data.skipped.localDiscordArtifacts : 0,
							};
						}
					: undefined,
			}),
		);

	snapshot
		.command("import <sourceId> <file>")
		.description("Import a source snapshot into an existing configured source")
		.option("--include-local-discord", "Import local Discord @me desktop-cache artifacts from the snapshot")
		.action((sourceId: string, file: string, options: { includeLocalDiscord?: boolean }) =>
			importConfiguredSourceSnapshot(
				sourceId,
				{ file, ...options },
				{
					...deps,
					importSourceSnapshotToDaemon: deps.secretApiCall
						? async (id, sourceSnapshot, importOptions) => {
								const query = importOptions.includeLocalDiscord ? "?includeLocalDiscord=true" : "";
								const result = await deps.secretApiCall?.(
									"POST",
									`/api/sources/${encodeURIComponent(id)}/snapshot/import${query}`,
									sourceSnapshot,
									60_000,
								);
								if (!result?.ok) return { ok: false, error: errorFromDaemonData(result?.data) };
								const data = result.data as {
									imported?: unknown;
									skipped?: { localDiscordArtifacts?: unknown };
								};
								return {
									ok: true,
									imported: typeof data.imported === "number" ? data.imported : 0,
									skippedLocalDiscordArtifacts:
										typeof data.skipped?.localDiscordArtifacts === "number" ? data.skipped.localDiscordArtifacts : 0,
								};
							}
						: undefined,
				},
			),
		);

	const add = sources.command("add").description("Add an external read-only knowledge source");

	add
		.command("obsidian <path>")
		.description("Index an Obsidian vault as a read-only recall source")
		.option("--name <name>", "Display name for the vault")
		.option(
			"--exclude <glob>",
			"Exclude glob (repeatable). Defaults already ignore dot-folders and Obsidian internals.",
			collect,
			[],
		)
		.action((path: string, options: { name?: string; exclude?: string[] }) =>
			addObsidianVaultSource(path, options, deps),
		);

	add
		.command("github")
		.description("Index GitHub repositories as read-only recall sources")
		.requiredOption("--repo <owner/repo>", "GitHub repo pattern (repeatable, supports owner/*)", collect, [])
		.option("--token-ref <secret>", "Signet secret name or external secret reference for a GitHub token")
		.option("--name <name>", "Display name for the GitHub source")
		.option("--resource-type <type>", "Resource type: issues, pulls, discussions, docs (repeatable)", collect, [])
		.option("--state <state>", "Resource state: open, closed, or all", "all")
		.option("--no-include-comments", "Skip issue, PR, and discussion comments")
		.option("--label <label>", "Label filter (repeatable)", collect, [])
		.option("--doc-path <path>", "Markdown doc path or glob (repeatable)", collect, [])
		.option("--max-items <count>", "Maximum items per repo per resource class")
		.action((options) =>
			addGitHubSourceFromCli(options, {
				...deps,
				addGitHubSourceToDaemon: deps.secretApiCall
					? (input) => addSourceThroughDaemon(deps.secretApiCall, "/api/sources/github", input)
					: undefined,
			}),
		);

	add
		.command("discord")
		.description("Index Discord guilds or local Discord Desktop cache as read-only recall sources")
		.option("--guild <id>", "Discord guild ID (repeatable; required for REST/gateway modes)", collect, [])
		.option("--token-ref <secret>", "Signet secret name or external secret reference for the Discord bot token")
		.option("--name <name>", "Display name for the Discord source")
		.option("--desktop-cache-path <path>", "Discord Desktop data directory for --mode desktop-cache")
		.option("--full-cache", "Exhaustively scan Chromium cache files for --mode desktop-cache")
		.option("--channel <id-or-name>", "Channel ID or name filter (repeatable)", collect, [])
		.option("--max-messages <count>", "Maximum messages per channel per sync")
		.option("--since <iso-date>", "Lower bound for message history")
		.option("--no-threads", "Skip active and archived threads")
		.option("--no-archived-threads", "Skip archived thread discovery")
		.option("--include-private-archived-threads", "Include private archived thread discovery")
		.option("--no-members", "Skip guild member snapshots")
		.option("--no-attachments", "Skip attachment metadata artifacts")
		.option("--attachment-text", "Extract bounded text-like Discord attachment contents")
		.option("--max-attachment-text-bytes <bytes>", "Maximum bytes per text attachment extraction")
		.option("--no-embeds", "Skip embed metadata artifacts")
		.option("--no-polls", "Skip poll metadata artifacts")
		.option("--no-thread-members", "Skip thread member snapshots")
		.option("--mode <mode>", "Sync mode: rest, gateway-tail, or desktop-cache", "rest")
		.action((options) =>
			addDiscordSourceFromCli(options, {
				...deps,
				addDiscordSourceToDaemon: deps.secretApiCall
					? (input) => addSourceThroughDaemon(deps.secretApiCall, "/api/sources/discord", input)
					: undefined,
			}),
		);
}

async function addSourceThroughDaemon(
	secretApiCall: DaemonApiCall,
	path: string,
	body: unknown,
): Promise<DaemonAddSourceResult> {
	const result = await secretApiCall("POST", path, body, 30_000);
	if (!result.ok) {
		const error = errorFromDaemonData(result.data);
		return {
			ok: false,
			error,
			fallbackToLocal: error.startsWith("Could not reach Signet daemon") || error.startsWith("Request timed out"),
		};
	}
	return addSourceResultFromDaemonData(result.data);
}

function addSourceResultFromDaemonData(data: unknown): DaemonAddSourceResult {
	if (typeof data !== "object" || data === null || !("source" in data)) {
		return { ok: false, error: "daemon returned an invalid source add response" };
	}
	const source = (data as { source?: unknown }).source;
	if (!isDaemonSourceEntry(source)) {
		return { ok: false, error: "daemon returned an invalid source add response" };
	}
	return {
		ok: true,
		source,
		created: (data as { created?: unknown }).created === true,
		queued: (data as { queued?: unknown }).queued === true,
		job: (data as { job?: unknown }).job,
	};
}

function isDaemonSourceEntry(value: unknown): value is SignetSourceEntry {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		"name" in value &&
		"root" in value &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.root === "string"
	);
}

function errorFromDaemonData(data: unknown): string {
	return typeof data === "object" && data !== null && "error" in data
		? String((data as { error?: unknown }).error)
		: "daemon request failed";
}
