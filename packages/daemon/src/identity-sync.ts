import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { writeFileIfChangedAsync } from "./file-sync";

export interface SyncAgentWorkspacesOptions {
	agentsDir: string;
	batchSize?: number;
	onWorkspaceSynced?: (agentName: string, workspaceAgentsPath: string) => void;
	onError?: (agentName: string, error: Error) => void;
}

const DEFAULT_BATCH_SIZE = 25;

export async function yieldToEventLoop(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export async function forEachInBatches<T>(
	items: readonly T[],
	batchSize: number,
	worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
	const safeBatchSize = Math.max(1, Math.floor(batchSize));
	for (let index = 0; index < items.length; index++) {
		await worker(items[index], index);
		if ((index + 1) % safeBatchSize === 0) {
			await yieldToEventLoop();
		}
	}
}

async function readFileIfExists(path: string): Promise<string | null> {
	if (!existsSync(path)) return null;
	return await readFile(path, "utf-8");
}

async function composeIdentitySections(paths: readonly string[]): Promise<string> {
	const sections = await Promise.all(
		paths.map(async (path) => {
			const content = await readFileIfExists(path);
			if (!content) return "";
			const trimmed = content.trim();
			if (!trimmed) return "";
			const filename = path.split(/[\\/]/).pop() ?? path;
			return `\n## ${filename.replace(".md", "")}\n\n${trimmed}`;
		}),
	);
	return sections.filter(Boolean).join("\n");
}

export async function syncAgentWorkspaces({
	agentsDir,
	batchSize = DEFAULT_BATCH_SIZE,
	onWorkspaceSynced,
	onError,
}: SyncAgentWorkspacesOptions): Promise<void> {
	const agentsRoot = join(agentsDir, "agents");
	if (!existsSync(agentsRoot)) return;

	const agentsMdPath = join(agentsDir, "AGENTS.md");
	const base = await readFileIfExists(agentsMdPath);
	if (!base) return;

	let entries: string[];
	try {
		entries = (await readdir(agentsRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
	} catch {
		return;
	}

	const sharedIdentity = await composeIdentitySections([join(agentsDir, "USER.md"), join(agentsDir, "MEMORY.md")]);

	await forEachInBatches(entries, batchSize, async (name) => {
		const agentDir = join(agentsRoot, name);
		const workspaceDir = join(agentDir, "workspace");
		try {
			const soulPath = existsSync(join(agentDir, "SOUL.md")) ? join(agentDir, "SOUL.md") : join(agentsDir, "SOUL.md");
			const identityPath = existsSync(join(agentDir, "IDENTITY.md"))
				? join(agentDir, "IDENTITY.md")
				: join(agentsDir, "IDENTITY.md");
			const agentIdentity = await composeIdentitySections([soulPath, identityPath]);
			const composed = base + agentIdentity + sharedIdentity;
			await mkdir(workspaceDir, { recursive: true });
			const workspaceAgentsPath = join(workspaceDir, "AGENTS.md");
			if (await writeFileIfChangedAsync(workspaceAgentsPath, composed)) {
				onWorkspaceSynced?.(name, workspaceAgentsPath);
			}
		} catch (error) {
			onError?.(name, error instanceof Error ? error : new Error(String(error)));
		}
	});
}
