import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatYaml, getAgentIdentityFiles, parseSimpleYaml, scaffoldAgent } from "@signet/core";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import type { DaemonFetch } from "../lib/daemon.js";

interface AgentDeps {
	readonly AGENTS_DIR: string;
	readonly fetchFromDaemon: DaemonFetch;
}

/** Read agent.yaml as a mutable record, or return empty record. */
function readYaml(dir: string): Record<string, unknown> {
	const file = join(dir, "agent.yaml");
	if (!existsSync(file)) return {};
	try {
		return parseSimpleYaml(readFileSync(file, "utf-8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Write a record back to agent.yaml. */
function writeYaml(dir: string, data: Record<string, unknown>): void {
	writeFileSync(join(dir, "agent.yaml"), formatYaml(data));
}

/**
 * Add an agent entry to `agents.roster` in agent.yaml.
 * Creates the agents block if absent.
 */
function addToRoster(dir: string, name: string, policy: string, group: string | null): void {
	const cfg = readYaml(dir);
	const agents = (cfg.agents as Record<string, unknown> | undefined) ?? {};
	const roster = Array.isArray(agents.roster) ? agents.roster : [];
	// Remove any existing entry with the same name (idempotent).
	const filtered = roster.filter(
		(e: unknown) => typeof e !== "object" || e === null || (e as Record<string, unknown>).name !== name,
	);
	const entry: Record<string, unknown> = { name, read_policy: policy };
	if (group) entry.policy_group = group;
	filtered.push(entry);
	cfg.agents = { ...agents, roster: filtered };
	writeYaml(dir, cfg);
}

/**
 * Remove an agent entry from `agents.roster` in agent.yaml.
 * No-op if not present.
 */
function removeFromRoster(dir: string, name: string): void {
	const cfg = readYaml(dir);
	const agents = cfg.agents as Record<string, unknown> | undefined;
	if (!agents) return;
	const roster = Array.isArray(agents.roster) ? agents.roster : [];
	const filtered = roster.filter(
		(e: unknown) => typeof e !== "object" || e === null || (e as Record<string, unknown>).name !== name,
	);
	cfg.agents = { ...agents, roster: filtered };
	writeYaml(dir, cfg);
}

/** Validate agent name: lowercase alphanumeric + hyphens, not 'default'. */
function validateName(name: string): string | null {
	if (name === "default") return "Cannot use reserved name 'default'";
	if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return "Name must be lowercase alphanumeric + hyphens only";
	return null;
}

export function registerAgentCommands(program: Command, deps: AgentDeps): void {
	const agentCmd = program.command("agent").description("Manage named agents in the roster");

	// ── signet agent list ────────────────────────────────────────────────────

	agentCmd
		.command("list")
		.description("List all agents in the roster")
		.action(async () => {
			type Row = {
				id?: string;
				name: string;
				read_policy?: string;
				policy_group?: string;
			};
			let rows: Row[] = [];

			const data = await deps.fetchFromDaemon<{ agents: Row[] }>("/api/agents");
			if (data?.agents) {
				rows = data.agents;
			} else {
				// Daemon offline — fall back to agent.yaml
				console.log(chalk.yellow("  Daemon offline — reading agent.yaml\n"));
				const cfg = readYaml(deps.AGENTS_DIR);
				const agents = cfg.agents as Record<string, unknown> | undefined;
				const roster = Array.isArray(agents?.roster) ? agents.roster : [];
				rows = roster.filter(
					(e): e is Row =>
						typeof e === "object" && e !== null && typeof (e as Record<string, unknown>).name === "string",
				);
			}

			if (rows.length === 0) {
				console.log(chalk.dim("  No agents in roster"));
				console.log(chalk.dim("  Add one with: signet agent add <name>"));
				return;
			}

			const nameW = Math.max(...rows.map((r) => r.name.length), 8);
			const policyW = Math.max(...rows.map((r) => (r.read_policy ?? "isolated").length), 11);
			const header = ["ID".padEnd(6), "NAME".padEnd(nameW), "READ POLICY".padEnd(policyW), "POLICY GROUP"].join("  ");
			console.log(chalk.bold(`\n  ${header}\n`));
			for (const r of rows) {
				const id = (r.id ?? "-").padEnd(6);
				const name = chalk.cyan(r.name.padEnd(nameW));
				const policy = (r.read_policy ?? "isolated").padEnd(policyW);
				const group = r.policy_group ?? "-";
				console.log(`  ${chalk.dim(id)}  ${name}  ${policy}  ${chalk.dim(group)}`);
			}
			console.log();
		});

	// ── signet agent add <name> ──────────────────────────────────────────────

	agentCmd
		.command("add <name>")
		.description("Add a named agent to the roster")
		.option("--memory <policy>", "Memory read policy: isolated|shared|group", "isolated")
		.option("--group <group>", "Policy group name (required when --memory=group)")
		.action(async (name: string, options: { memory: string; group?: string }) => {
			const err = validateName(name);
			if (err) {
				console.log(chalk.red(`  ${err}`));
				process.exit(1);
			}
			if (options.memory === "group" && !options.group) {
				console.log(chalk.red("  --group is required when --memory=group"));
				process.exit(1);
			}
			if (!["isolated", "shared", "group"].includes(options.memory)) {
				console.log(chalk.red("  --memory must be: isolated | shared | group"));
				process.exit(1);
			}

			const spinner = ora(`Adding agent ${chalk.cyan(name)}...`).start();

			// Scaffold identity directory
			scaffoldAgent(name, deps.AGENTS_DIR);
			const dir = join(deps.AGENTS_DIR, "agents", name);

			// Register with daemon
			const result = await deps.fetchFromDaemon<{ success?: boolean; error?: string }>("/api/agents", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name,
					read_policy: options.memory,
					policy_group: options.group ?? null,
				}),
			});

			if (result?.error) {
				spinner.warn(`Daemon returned error: ${result.error}`);
			} else if (!result) {
				spinner.warn("Daemon offline — agent registered in agent.yaml only");
			}

			// Update agent.yaml roster
			addToRoster(deps.AGENTS_DIR, name, options.memory, options.group ?? null);

			spinner.succeed(`Agent ${chalk.cyan(name)} added`);
			console.log(chalk.dim(`  Identity directory: ${dir}`));
			if (options.memory !== "isolated") {
				console.log(chalk.dim(`  Read policy: ${options.memory}${options.group ? ` (group: ${options.group})` : ""}`));
			}
		});

	// ── signet agent remove <name> ───────────────────────────────────────────

	agentCmd
		.command("remove <name>")
		.description("Remove an agent (archives memories, keeps files)")
		.action(async (name: string) => {
			if (name === "default") {
				console.log(chalk.red("  Cannot remove the default agent"));
				process.exit(1);
			}

			const spinner = ora(`Removing agent ${chalk.cyan(name)}...`).start();

			const result = await deps.fetchFromDaemon<{ success?: boolean; error?: string }>(
				`/api/agents/${encodeURIComponent(name)}`,
				{ method: "DELETE" },
			);

			if (result?.error) {
				spinner.fail(`Daemon returned error: ${result.error} — roster preserved`);
				return;
			}
			if (!result) {
				spinner.warn("Daemon offline — removing from agent.yaml only");
			}

			removeFromRoster(deps.AGENTS_DIR, name);

			spinner.succeed(`Agent ${chalk.cyan(name)} removed`);
			console.log(chalk.dim("  Memories archived. Files retained in agents/ directory."));
		});

	// ── signet agent purge <name> ────────────────────────────────────────────

	agentCmd
		.command("purge <name>")
		.description("Permanently delete an agent and all their memories")
		.option("--force", "Skip confirmation prompt")
		.action(async (name: string, options: { force?: boolean }) => {
			if (name === "default") {
				console.log(chalk.red("  Cannot purge the default agent"));
				process.exit(1);
			}

			const nameErr = validateName(name);
			if (nameErr) {
				console.log(chalk.red(`  ${nameErr}`));
				process.exit(1);
			}

			if (!options.force) {
				// Simple readline confirmation
				const readline = await import("node:readline");
				const rl = readline.createInterface({
					input: process.stdin,
					output: process.stdout,
				});
				const confirmed = await new Promise<boolean>((resolve) => {
					rl.question(
						chalk.yellow(`  Purge agent '${name}' and delete ALL memories? This cannot be undone. [y/N] `),
						(answer) => {
							rl.close();
							resolve(answer.trim().toLowerCase() === "y");
						},
					);
				});
				if (!confirmed) {
					console.log(chalk.dim("  Cancelled"));
					return;
				}
			}

			const spinner = ora(`Purging agent ${chalk.cyan(name)}...`).start();

			const result = await deps.fetchFromDaemon<{ success?: boolean; error?: string }>(
				`/api/agents/${encodeURIComponent(name)}?purge=true`,
				{ method: "DELETE" },
			);

			// Only clean up local files when daemon confirmed success (success: true)
			// or was offline (null result — no error was returned by the daemon).
			// If the daemon returned an explicit error the agent record may still
			// exist in DB; deleting the local files would create an orphan.
			const daemonOk = result?.success === true;
			const daemonOffline = !result;
			if (result?.error) {
				spinner.fail(`Daemon returned error: ${result.error} — local files preserved`);
				return;
			}
			if (daemonOffline) {
				spinner.warn("Daemon offline — cleaning up local files only");
			}

			if (daemonOk || daemonOffline) {
				const dir = join(deps.AGENTS_DIR, "agents", name);
				if (existsSync(dir)) {
					rmSync(dir, { recursive: true, force: true });
				}
				removeFromRoster(deps.AGENTS_DIR, name);
			}

			spinner.succeed(`Agent ${chalk.cyan(name)} purged`);
		});

	// ── signet agent info <name> ─────────────────────────────────────────────

	agentCmd
		.command("info <name>")
		.description("Show details for a named agent")
		.action(async (name: string) => {
			const spinner = ora(`Loading agent ${chalk.cyan(name)}...`).start();

			type AgentDetail = {
				name: string;
				read_policy?: string;
				policy_group?: string;
				memory_count?: number;
			};

			const data = await deps.fetchFromDaemon<{ agent: AgentDetail } | AgentDetail>(
				`/api/agents/${encodeURIComponent(name)}`,
			);

			spinner.stop();

			// Support both `{ agent: {...} }` and flat response shapes
			const agent: AgentDetail | null = (() => {
				if (!data) return null;
				if ("agent" in data && typeof data.agent === "object" && data.agent !== null) return data.agent as AgentDetail;
				if ("name" in data) return data as AgentDetail;
				return null;
			})();

			if (!agent) {
				console.log(chalk.yellow(`  Agent '${name}' not found or daemon offline`));
			} else {
				console.log(chalk.bold(`\n  Agent: ${chalk.cyan(agent.name)}\n`));
				console.log(`  Read policy:  ${agent.read_policy ?? "isolated"}`);
				if (agent.policy_group) {
					console.log(`  Policy group: ${agent.policy_group}`);
				}
				if (typeof agent.memory_count === "number") {
					console.log(`  Memories:     ${agent.memory_count}`);
				}
			}

			// Show which identity files exist on disk
			const files = getAgentIdentityFiles(name, deps.AGENTS_DIR);
			const entries = Object.entries(files);
			if (entries.length > 0) {
				console.log(chalk.bold("\n  Identity files:\n"));
				for (const [file, path] of entries) {
					console.log(`  ${chalk.cyan(file.padEnd(14))}  ${chalk.dim(path)}`);
				}
			} else {
				console.log(chalk.dim("\n  No identity files found"));
				console.log(chalk.dim(`  Run: signet agent add ${name}`));
			}
			console.log();
		});
}
