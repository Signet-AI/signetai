import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { findSignetForgeBinary, parseSimpleYaml, readNetworkMode } from "@signet/core";
import chalk from "chalk";
import { managedForgeInstallSupportedOnCurrentPlatform } from "./forge.js";
import {
	chooseWorkspaceCandidate,
	listWorkspaceCandidates,
	setWorkspacePath as setWorkspaceDefaultPath,
} from "./workspace.js";

interface Deps {
	readonly agentsDir: string;
	readonly configureHarnessHooks: (harness: string, basePath: string) => Promise<void>;
	readonly signetLogo: () => string;
}

interface Cfg {
	readonly dir: string;
	readonly file: string;
	readonly yaml: string;
}

const sections = [
	{ value: "agent", name: "👤 Agent identity (name, description)" },
	{ value: "workspace", name: "📁 Workspace path" },
	{ value: "network", name: "🌐 Network access" },
	{ value: "harnesses", name: "[link] Harnesses (AI platforms)" },
	{ value: "embedding", name: "🧠 Embedding provider" },
	{ value: "search", name: "🔍 Search settings" },
	{ value: "memory", name: "💾 Memory settings" },
	{ value: "view", name: "📄 View current config" },
	{ value: "done", name: "✓ Done" },
] as const;

export async function configureAgent(deps: Deps): Promise<void> {
	console.log(deps.signetLogo());

	const file = join(deps.agentsDir, "agent.yaml");
	if (!existsSync(file)) {
		console.log(chalk.yellow("  No agent.yaml found. Run `signet setup` first."));
		return;
	}

	let cfg: Cfg = {
		dir: deps.agentsDir,
		file,
		yaml: readFileSync(file, "utf-8"),
	};

	console.log(chalk.bold("  Configure your agent\n"));

	while (true) {
		const section = await select({
			message: "What would you like to configure?",
			choices: [...sections],
		});

		if (section === "done") {
			break;
		}

		console.log();

		if (section === "view") {
			showCurrent(cfg.yaml);
			continue;
		}

		if (section === "workspace") {
			cfg = await configureWorkspace(cfg);
			console.log();
			continue;
		}

		if (section === "agent") {
			const yaml = await configureIdentity(cfg.yaml);
			cfg = writeConfig(cfg, yaml);
			console.log(chalk.green("  ✓ Agent identity updated"));
			console.log();
			continue;
		}

		if (section === "network") {
			const yaml = await configureNetwork(cfg.yaml);
			cfg = writeConfig(cfg, yaml);
			console.log(chalk.green("  ✓ Network settings updated"));
			console.log(chalk.dim("    Restart the daemon to apply the new bind mode."));
			console.log();
			continue;
		}

		if (section === "harnesses") {
			const yaml = await configureHarnesses(cfg.yaml, deps, cfg.dir);
			cfg = writeConfig(cfg, yaml);
			console.log(chalk.green("  ✓ Harnesses updated"));
			console.log();
			continue;
		}

		if (section === "embedding") {
			const yaml = await configureEmbedding(cfg.yaml);
			cfg = writeConfig(cfg, yaml);
			console.log(chalk.green("  ✓ Embedding settings updated"));
			console.log();
			continue;
		}

		if (section === "search") {
			const yaml = await configureSearch(cfg.yaml);
			cfg = writeConfig(cfg, yaml);
			console.log(chalk.green("  ✓ Search settings updated"));
			console.log();
			continue;
		}

		const yaml = await configureMemory(cfg.yaml);
		cfg = writeConfig(cfg, yaml);
		console.log(chalk.green("  ✓ Memory settings updated"));
		console.log();
	}

	console.log(chalk.dim("  Configuration saved to agent.yaml"));
	console.log();
}

function writeConfig(cfg: Cfg, yaml: string): Cfg {
	writeFileSync(cfg.file, yaml);
	return {
		...cfg,
		yaml,
	};
}

async function configureWorkspace(cfg: Cfg): Promise<Cfg> {
	const target = await configureWorkspacePath(cfg.dir);
	try {
		const result = await setWorkspaceDefaultPath(target, {
			currentPath: cfg.dir,
			patchOpenClaw: true,
		});
		const file = join(result.nextPath, "agent.yaml");
		const yaml = existsSync(file) ? readFileSync(file, "utf-8") : cfg.yaml;
		console.log(chalk.green("  ✓ Workspace updated"));
		console.log(chalk.dim(`    active: ${result.nextPath}`));
		if (result.migrated) {
			console.log(chalk.dim(`    migrated: ${result.copiedFiles} copied, ${result.overwrittenFiles} overwritten`));
		}
		if (result.patchedConfigs.length > 0) {
			console.log(chalk.dim(`    openclaw configs patched: ${result.patchedConfigs.length}`));
		}
		if (result.changed) {
			console.log(chalk.dim("    restart the daemon to apply workspace changes to active runtime processes"));
		}
		return {
			dir: result.nextPath,
			file,
			yaml,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(chalk.red(`  Workspace update failed: ${msg}`));
		return cfg;
	}
}

async function configureWorkspacePath(currentPath: string): Promise<string> {
	const ranked = listWorkspaceCandidates(currentPath).slice(0, 8);
	const fallback = chooseWorkspaceCandidate(currentPath);
	const choices = ranked.map((candidate) => ({
		value: candidate.path,
		name: candidate.source === "detected" ? `${candidate.path} (detected)` : `${candidate.path} (preset)`,
	}));
	choices.push({ value: "__custom__", name: "Custom path..." });

	const picked = await select({
		message: "Select workspace path:",
		choices,
		default: fallback,
	});
	if (picked !== "__custom__") {
		return picked;
	}

	const typed = await input({
		message: "Workspace path:",
		default: fallback,
	});
	const trimmed = typed.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function showCurrent(yaml: string): void {
	console.log(chalk.dim("  Current agent.yaml:\n"));
	console.log(
		yaml
			.split("\n")
			.map((line) => chalk.dim(`  ${line}`))
			.join("\n"),
	);
	console.log();
}

function readValue(yaml: string, key: string, fallback: string): string {
	const match = yaml.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "m"));
	return match ? match[1].trim().replace(/^["']|["']$/g, "") : fallback;
}

function writeNetworkSection(yaml: string, mode: string): string {
	const block = `network:\n  mode: ${mode}\n`;
	if (yaml.match(/^network:\n(?: {2}.+\n)*/m)) {
		return yaml.replace(/^network:\n(?: {2}.+\n)*/m, block);
	}
	return `${yaml.trimEnd()}\n\n${block}`;
}

async function configureIdentity(yaml: string): Promise<string> {
	const name = await input({
		message: "Agent name:",
		default: readValue(yaml, "name", "My Agent"),
	});
	const description = await input({
		message: "Description:",
		default: readValue(yaml, "description", "Personal AI assistant"),
	});

	let next = yaml;
	next = next.replace(/^(\s*name:)\s*.+$/m, `$1 "${name}"`);
	next = next.replace(/^(\s*description:)\s*.+$/m, `$1 "${description}"`);
	next = next.replace(/^(\s*updated:)\s*.+$/m, `$1 "${new Date().toISOString()}"`);
	return next;
}

async function configureNetwork(yaml: string): Promise<string> {
	const mode = await select({
		message: "How should the daemon be hosted?",
		choices: [
			{ value: "localhost", name: "localhost only (127.0.0.1)" },
			{ value: "tailscale", name: "Tailscale / remote (bind 0.0.0.0)" },
		],
		default: readNetworkMode(parseSimpleYaml(yaml)),
	});

	return writeNetworkSection(yaml, mode);
}

async function configureHarnesses(yaml: string, deps: Deps, dir: string): Promise<string> {
	const forgeDetected = Boolean(findSignetForgeBinary(dir));
	const harnesses = await checkbox({
		message: "Select AI platforms:",
		choices: [
			{ value: "claude-code", name: "Claude Code" },
			{ value: "codex", name: "Codex" },
			{ value: "opencode", name: "OpenCode" },
			{ value: "openclaw", name: "OpenClaw" },
			{
				value: "forge",
				name: "Forge",
				disabled:
					!forgeDetected && !managedForgeInstallSupportedOnCurrentPlatform()
						? "managed install unavailable on this platform; install Forge separately first"
						: false,
			},
			{ value: "cursor", name: "Cursor" },
			{ value: "windsurf", name: "Windsurf" },
		],
	});

	const list = harnesses.map((harness) => `  - ${harness}`).join("\n");
	const next = yaml.replace(/^harnesses:\n( {2}- .+\n)+/m, `harnesses:\n${list}\n`);

	const regen = await confirm({
		message: "Regenerate harness hook configurations?",
		default: true,
	});

	if (!regen) {
		return next;
	}

	for (const harness of harnesses) {
		try {
			await deps.configureHarnessHooks(harness, dir);
			console.log(chalk.dim(`    ✓ ${harness}`));
		} catch {
			console.log(chalk.yellow(`    ⚠ ${harness} failed`));
		}
	}

	return next;
}

async function configureEmbedding(yaml: string): Promise<string> {
	const provider = await select({
		message: "Embedding provider:",
		choices: [
			{ value: "ollama", name: "Ollama (local)" },
			{ value: "openai", name: "OpenAI API" },
			{ value: "none", name: "Disable embeddings" },
		],
	});

	if (provider === "none") {
		return yaml;
	}

	let model = "nomic-embed-text";
	let dims = 768;

	if (provider === "ollama") {
		const selected = await select({
			message: "Model:",
			choices: [
				{ value: "nomic-embed-text", name: "nomic-embed-text (768d)" },
				{ value: "all-minilm", name: "all-minilm (384d)" },
				{ value: "mxbai-embed-large", name: "mxbai-embed-large (1024d)" },
			],
		});
		model = selected;
		dims = selected === "all-minilm" ? 384 : selected === "mxbai-embed-large" ? 1024 : 768;
	} else {
		const selected = await select({
			message: "Model:",
			choices: [
				{ value: "text-embedding-3-small", name: "text-embedding-3-small (1536d)" },
				{ value: "text-embedding-3-large", name: "text-embedding-3-large (3072d)" },
			],
		});
		model = selected;
		dims = selected === "text-embedding-3-large" ? 3072 : 1536;
	}

	if (yaml.includes("embedding:")) {
		return yaml.replace(
			/^embedding:\n( {2}.+\n)+/m,
			`embedding:\n  provider: ${provider}\n  model: ${model}\n  dimensions: ${dims}\n`,
		);
	}

	return yaml.replace(
		/^(harnesses:\n( {2}- .+\n)+)/m,
		`$1\nembedding:\n  provider: ${provider}\n  model: ${model}\n  dimensions: ${dims}\n`,
	);
}

async function configureSearch(yaml: string): Promise<string> {
	const alpha = await select({
		message: "Search balance:",
		choices: [
			{ value: "0.7", name: "Balanced (70% semantic, 30% keyword)" },
			{ value: "0.9", name: "Semantic-heavy (90/10)" },
			{ value: "0.5", name: "Equal (50/50)" },
			{ value: "0.3", name: "Keyword-heavy (30/70)" },
		],
	});
	const topK = await input({
		message: "Candidates per source (top_k):",
		default: readValue(yaml, "top_k", "20"),
	});
	const minScore = await input({
		message: "Minimum score threshold:",
		default: readValue(yaml, "min_score", "0.3"),
	});

	let next = yaml;
	next = next.replace(/^(\s*alpha:)\s*.+$/m, `$1 ${alpha}`);
	next = next.replace(/^(\s*top_k:)\s*.+$/m, `$1 ${topK}`);
	next = next.replace(/^(\s*min_score:)\s*.+$/m, `$1 ${minScore}`);
	return next;
}

async function configureMemory(yaml: string): Promise<string> {
	const sessionBudget = await input({
		message: "Session context budget (characters):",
		default: readValue(yaml, "session_budget", "2000"),
	});
	const decayRate = await input({
		message: "Importance decay rate per day (0-1):",
		default: readValue(yaml, "decay_rate", "0.95"),
	});

	let next = yaml;
	next = next.replace(/^(\s*session_budget:)\s*.+$/m, `$1 ${sessionBudget}`);
	next = next.replace(/^(\s*decay_rate:)\s*.+$/m, `$1 ${decayRate}`);
	return next;
}
