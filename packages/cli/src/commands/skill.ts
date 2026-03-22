import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getSkillsRunnerCommand, resolvePrimaryPackageManager } from "@signet/core";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";

interface SkillMeta {
	name: string;
	description?: string;
	version?: string;
	author?: string;
	user_invocable?: boolean;
	arg_hint?: string;
}

interface SkillDeps {
	readonly AGENTS_DIR: string;
	readonly SKILLS_DIR: string;
	readonly fetchFromDaemon: <T>(path: string, opts?: RequestInit & { timeout?: number }) => Promise<T | null>;
	readonly isDaemonRunning: () => Promise<boolean>;
}

function parseFrontmatter(content: string): SkillMeta {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return { name: "" };
	const fm = match[1];
	const get = (key: string) => {
		const found = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
		return found ? found[1].trim().replace(/^["']|["']$/g, "") : "";
	};
	return {
		name: get("name"),
		description: get("description") || undefined,
		version: get("version") || undefined,
		author: get("author") || undefined,
		user_invocable: /^user_invocable:\s*true$/m.test(fm),
		arg_hint: get("arg_hint") || undefined,
	};
}

function listLocalSkills(root: string): Array<SkillMeta & { dirName: string }> {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.flatMap((entry) => {
			const path = join(root, entry.name, "SKILL.md");
			if (!existsSync(path)) return [];
			try {
				return [{ ...parseFrontmatter(readFileSync(path, "utf-8")), dirName: entry.name }];
			} catch {
				return [];
			}
		});
}

async function searchRegistry(
	query: string,
): Promise<[Array<{ name: string; description: string; url: string }>, boolean]> {
	try {
		const q = encodeURIComponent(`${query} topic:agent-skill OR filename:SKILL.md in:path`);
		const res = await fetch(`https://api.github.com/search/repositories?q=${q}&sort=stars&per_page=10`, {
			headers: {
				Accept: "application/vnd.github.v3+json",
				"User-Agent": "signet-cli",
			},
			signal: AbortSignal.timeout(8000),
		});
		if (res.status === 403 || res.status === 429) return [[], true];
		if (!res.ok) return [[], false];
		const data = (await res.json()) as {
			items?: Array<{ name: string; description: string | null; html_url: string }>;
		};
		return [
			(data.items ?? []).map((item) => ({
				name: item.name,
				description: item.description ?? "",
				url: item.html_url,
			})),
			false,
		];
	} catch {
		return [[], false];
	}
}

export function registerSkillCommands(program: Command, deps: SkillDeps): void {
	const skillCmd = program.command("skill").description("Manage agent skills");

	skillCmd
		.command("list")
		.description("Show installed skills")
		.action(async () => {
			const data = await deps.fetchFromDaemon<{ skills: Array<SkillMeta & { name: string }> }>("/api/skills");
			const skills =
				data?.skills ?? listLocalSkills(deps.SKILLS_DIR).map((skill) => ({ ...skill, name: skill.dirName }));
			if (skills.length === 0) {
				console.log(chalk.dim(`  No skills installed at ${deps.SKILLS_DIR}`));
				console.log(chalk.dim("  Run `signet skill search <query>` to find skills"));
				return;
			}
			console.log(chalk.bold(`  Installed skills (${skills.length}):\n`));
			const width = Math.max(...skills.map((skill) => skill.name.length), 12);
			for (const skill of skills) {
				const name = skill.name.padEnd(width);
				const desc = skill.description ? chalk.dim(skill.description) : "";
				const ver = skill.version ? chalk.dim(` v${skill.version}`) : "";
				console.log(`    ${chalk.cyan(name)}  ${desc}${ver}`);
			}
			console.log();
		});

	skillCmd
		.command("install <name>")
		.description("Install a skill from skills.sh registry (e.g. browser-use or owner/repo)")
		.action(async (name: string) => {
			const spinner = ora(`Installing ${chalk.cyan(name)}...`).start();
			if (await deps.isDaemonRunning()) {
				const result = await deps.fetchFromDaemon<{ success: boolean; error?: string }>("/api/skills/install", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name }),
				});
				if (result?.success) {
					spinner.succeed(`Installed ${chalk.cyan(name)} to ${deps.SKILLS_DIR}/${name}/`);
					return;
				}
				spinner.fail(`Failed to install ${name}`);
				if (result?.error) console.error(chalk.dim(`  ${result.error}`));
				console.log(chalk.dim("\n  Tip: provide full GitHub path: signet skill install owner/repo"));
				return;
			}

			const pm = resolvePrimaryPackageManager({ agentsDir: deps.AGENTS_DIR, env: process.env });
			const cmd = getSkillsRunnerCommand(pm.family, ["add", name, "--global", "--yes"]);
			spinner.text = `Installing ${chalk.cyan(name)} (daemon offline, running ${cmd.command} skills)...`;
			if (pm.source === "fallback") console.log(chalk.dim(`  ${pm.reason}`));
			await new Promise<void>((resolve) => {
				const proc = spawn(cmd.command, cmd.args, {
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env },
					windowsHide: true,
				});
				let stderr = "";
				proc.stderr.on("data", (buf: Buffer) => {
					stderr += buf.toString();
				});
				proc.on("close", (code) => {
					if (code === 0) {
						spinner.succeed(`Installed ${chalk.cyan(name)}`);
					} else {
						spinner.fail(`Failed to install ${name}`);
						if (stderr) console.error(chalk.dim(`  ${stderr.trim()}`));
						console.log(chalk.dim("\n  Tip: provide full GitHub path: signet skill install owner/repo"));
					}
					resolve();
				});
				proc.on("error", () => {
					spinner.fail(`${cmd.command} is not available`);
					resolve();
				});
			});
		});

	skillCmd
		.command("uninstall <name>")
		.alias("remove")
		.description("Remove an installed skill")
		.action(async (name: string) => {
			const dir = join(deps.SKILLS_DIR, name);
			if (!existsSync(dir)) {
				console.log(chalk.yellow(`  Skill '${name}' is not installed`));
				return;
			}

			const spinner = ora(`Removing ${chalk.cyan(name)}...`).start();
			if (await deps.isDaemonRunning()) {
				const result = await deps.fetchFromDaemon<{ success: boolean; error?: string }>(
					`/api/skills/${encodeURIComponent(name)}`,
					{ method: "DELETE" },
				);
				if (result?.success) {
					spinner.succeed(`Removed ${chalk.cyan(name)}`);
					return;
				}
				spinner.fail(`Failed to remove ${name}`);
				if (result?.error) console.error(chalk.dim(`  ${result.error}`));
				return;
			}

			try {
				const { rmSync } = await import("node:fs");
				rmSync(dir, { recursive: true, force: true });
				spinner.succeed(`Removed ${chalk.cyan(name)}`);
			} catch (err) {
				spinner.fail(`Failed to remove ${name}`);
				console.error(chalk.dim(`  ${err instanceof Error ? err.message : "Unknown error"}`));
			}
		});

	skillCmd
		.command("search <query>")
		.description("Search skills.sh registry for skills")
		.action(async (query: string) => {
			const local = listLocalSkills(deps.SKILLS_DIR).filter((skill) => {
				const q = query.toLowerCase();
				return (
					skill.dirName.includes(q) ||
					(skill.name ?? "").toLowerCase().includes(q) ||
					(skill.description ?? "").toLowerCase().includes(q)
				);
			});

			const spinner = ora(`Searching registry for "${query}"...`).start();
			const [remote, limited] = await searchRegistry(query);
			spinner.stop();
			const installed = new Set(listLocalSkills(deps.SKILLS_DIR).map((skill) => skill.dirName));

			if (local.length > 0) {
				console.log(chalk.bold(`  Installed matching "${query}":\n`));
				for (const skill of local) {
					const desc = skill.description ? chalk.dim(` — ${skill.description}`) : "";
					console.log(`    ${chalk.green("✓")} ${chalk.cyan(skill.dirName)}${desc}`);
				}
				console.log();
			}

			if (remote.length > 0) {
				console.log(chalk.bold("  Available on GitHub:\n"));
				for (const skill of remote) {
					const mark = installed.has(skill.name) ? chalk.green("✓ ") : "  ";
					const desc = skill.description ? chalk.dim(` — ${skill.description}`) : "";
					console.log(`  ${mark}${chalk.cyan(skill.name)}${desc}`);
					console.log(`       ${chalk.dim(skill.url)}`);
				}
				console.log();
				console.log(chalk.dim("  Install with: signet skill install <owner/repo>"));
				return;
			}

			if (limited) {
				console.log(chalk.yellow(`  Registry search rate-limited. Browse at ${chalk.cyan("https://skills.sh")}`));
				return;
			}

			if (local.length === 0) {
				console.log(chalk.dim(`  No skills found for "${query}"`));
				console.log(chalk.dim("  Browse all skills at https://skills.sh"));
			}
			console.log();
		});

	skillCmd
		.command("show <name>")
		.description("Display SKILL.md content for an installed skill")
		.action(async (name: string) => {
			const data = await deps.fetchFromDaemon<{ content?: string; error?: string }>(
				`/api/skills/${encodeURIComponent(name)}`,
			);
			if (data?.content) {
				console.log(data.content);
				return;
			}
			const path = join(deps.SKILLS_DIR, name, "SKILL.md");
			if (!existsSync(path)) {
				console.log(chalk.red(`  Skill '${name}' is not installed`));
				console.log(chalk.dim(`  Run: signet skill install ${name}`));
				return;
			}
			console.log(readFileSync(path, "utf-8"));
		});
}
