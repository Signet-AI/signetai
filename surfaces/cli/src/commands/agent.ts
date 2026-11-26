import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildAgentMemoryConfig,
	formatYaml,
	getAgentIdentityFiles,
	normalizeAgentRosterEntry,
	parseSimpleYaml,
	scaffoldAgent,
} from "@signet/core";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import type { DaemonFetch } from "../lib/daemon.js";
import { waitForOrganizationJob } from "./organization.js";
import { SignetError } from "../../../../libs/sdk/src/index.js";
import { cliTransport } from "../lib/organization-target.js";

async function organizationAgent(
	action: string,
	name?: string,
	input?: unknown,
	options?: { force?: boolean; confirm?: boolean; wait?: boolean; json?: boolean },
): Promise<boolean> {
	const transport = cliTransport();
	if (!transport) return false;
	if (action === "add") {
		console.log(JSON.stringify(await transport.post("/api/agents", input)));
		return true;
	}
	const inventory = await transport.get<{
		agents: {
			id: string;
			name: string;
			kind: string;
			ownerUserId: string | null;
			ownerGroupId: string | null;
			canActAs: boolean;
		}[];
	}>("/api/agents");
	if (action === "list") {
		console.log(JSON.stringify(inventory, null, 2));
		return true;
	}
	const agent = inventory.agents.find((item) => item.id === name || item.name === name);
	if (!agent) throw new Error("Agent not found");
	if (action === "use")
		console.log(
			JSON.stringify(
				await transport.request("PATCH", "/api/auth/preferences", { body: { defaultReadAgentId: agent.id } }),
			),
		);
	else if (action === "remove")
		console.log(
			JSON.stringify(
				await transport.request("PATCH", `/api/agents/${encodeURIComponent(agent.id)}`, { body: { archived: true } }),
			),
		);
	else if (action === "transfer" || action === "set")
		console.log(
			JSON.stringify(await transport.request("PATCH", `/api/agents/${encodeURIComponent(agent.id)}`, { body: input })),
		);
	else if (action === "purge") {
		if (!options?.confirm && !options?.force)
			throw new SignetError(
				"Archive the agent first, then pass --confirm to permanently purge its evidence. No local files will be changed.",
				"confirmation_required",
			);
		const result = await transport.post<{ jobId: string }>(`/api/org/agents/${encodeURIComponent(agent.id)}/purge`, {});
		console.log(
			JSON.stringify(
				options.wait ? await waitForOrganizationJob(transport, result.jobId) : result,
				null,
				options.json ? undefined : 2,
			),
		);
	} else console.log(JSON.stringify(agent, null, 2));
	return true;
}

interface AgentDeps {
	readonly AGENTS_DIR: string;
	readonly fetchFromDaemon: DaemonFetch;
}
function readYaml(dir: string): Record<string, unknown> {
	const file = join(dir, "agent.yaml");
	if (!existsSync(file)) return {};
	try {
		return parseSimpleYaml(readFileSync(file, "utf-8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}
function writeYaml(dir: string, data: Record<string, unknown>): void {
	writeFileSync(join(dir, "agent.yaml"), formatYaml(data));
}
function addToRoster(dir: string, name: string, policy: string, group: string | null): void {
	const cfg = readYaml(dir);
	const agents = (cfg.agents as Record<string, unknown> | undefined) ?? {};
	const roster = Array.isArray(agents.roster) ? agents.roster : [];
	const filtered = roster.filter(
		(e: unknown) => typeof e !== "object" || e === null || (e as Record<string, unknown>).name !== name,
	);
	const entry: Record<string, unknown> = {
		name,
		memory: buildAgentMemoryConfig(policy === "shared" ? "shared" : policy === "group" ? "group" : "isolated", group),
	};
	filtered.push(entry);
	cfg.agents = { ...agents, roster: filtered };
	writeYaml(dir, cfg);
}
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
export function validateName(name: string): string | null {
	if (name === "default") return "Cannot use reserved name 'default'";
	if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return "Name must be lowercase alphanumeric + hyphens only";
	return null;
}

export function registerAgentCommands(program: Command, deps: AgentDeps): void {
	const agentCmd = program
		.command("agent")
		.description("Manage named agents in the roster")
		.option("--json", "Machine-readable output");
	agentCmd.command("use <name>").action(async (name: string) => {
		if (!(await organizationAgent("use", name))) throw new Error("Agent use requires an organization login");
	});
	agentCmd
		.command("transfer <name>")
		.option("--user <id>", "New owning user")
		.option("--team <id>", "New owning team")
		.action(async (name: string, opts: { user?: string; team?: string }) => {
			if (Boolean(opts.user) === Boolean(opts.team)) throw new Error("Choose exactly one of --user or --team");
			if (!(await organizationAgent("transfer", name, { ownerUserId: opts.user, ownerGroupId: opts.team })))
				throw new Error("Agent transfer requires an organization login");
		});

	agentCmd
		.command("list")
		.description("List all agents in the roster")
		.action(async () => {
			if (await organizationAgent("list")) return;
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
				console.log(chalk.yellow("  Daemon offline — reading agent.yaml\n"));
				const cfg = readYaml(deps.AGENTS_DIR);
				const agents = cfg.agents as Record<string, unknown> | undefined;
				const roster = Array.isArray(agents?.roster) ? agents.roster : [];
				rows = roster.flatMap((entry) => {
					const normalized = normalizeAgentRosterEntry(entry);
					if (!normalized) return [];
					return [
						{
							id: normalized.name,
							name: normalized.name,
							read_policy: normalized.readPolicy,
							policy_group: normalized.policyGroup ?? undefined,
						},
					];
				});
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

	agentCmd
		.command("add <name>")
		.description("Add a named agent to the roster")
		.option("--memory <policy>", "Memory read policy: isolated|shared|group", "isolated")
		.option("--group <group>", "Policy group name (required when --memory=group)")
		.option("--team <id>", "Owning organization team")
		.action(async (name: string, options: { memory: string; group?: string; team?: string }) => {
			if (
				await organizationAgent("add", name, {
					name,
					kind: options.team ? "team" : "personal",
					ownerGroupId: options.team,
				})
			)
				return;
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
			scaffoldAgent(name, deps.AGENTS_DIR);
			const dir = join(deps.AGENTS_DIR, "agents", name);
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
			addToRoster(deps.AGENTS_DIR, name, options.memory, options.group ?? null);

			spinner.succeed(`Agent ${chalk.cyan(name)} added`);
			console.log(chalk.dim(`  Identity directory: ${dir}`));
			if (options.memory !== "isolated") {
				console.log(chalk.dim(`  Read policy: ${options.memory}${options.group ? ` (group: ${options.group})` : ""}`));
			}
		});

	agentCmd
		.command("remove <name>")
		.description("Remove an agent (archives memories, keeps files)")
		.action(async (name: string) => {
			if (await organizationAgent("remove", name)) return;
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

	agentCmd
		.command("purge <name>")
		.description("Permanently delete an agent and all their memories")
		.option("--force", "Skip confirmation prompt")
		.option("--confirm", "Confirm permanent organization evidence purge")
		.option("--wait", "Wait for durable purge completion")
		.option("--json", "Machine-readable output")
		.action(async (name: string, options: { force?: boolean; confirm?: boolean; wait?: boolean; json?: boolean }) => {
			if (await organizationAgent("purge", name, undefined, options)) return;
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

	agentCmd
		.command("info <name>")
		.description("Show details for a named agent")
		.action(async (name: string) => {
			if (await organizationAgent("show", name)) return;
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
	agentCmd
		.command("show <name>")
		.description("Show daemon-backed agent policy and scope")
		.action(async (name: string) => {
			if (await organizationAgent("show", name)) return;
			const data = await deps.fetchFromDaemon<Record<string, unknown>>(`/api/agents/${encodeURIComponent(name)}`);
			if (!data) {
				console.log(chalk.red("  Daemon unavailable"));
				process.exit(1);
			}
			if (data && typeof data.error === "string") {
				console.log(chalk.red(`  ${data.error}`));
				process.exit(1);
			}
			console.log(`  Agent: ${String(data?.name ?? name)}`);
			console.log(`  Read policy: ${String(data?.read_policy ?? "isolated")}`);
			if (data?.policy_group) console.log(`  Policy group: ${String(data.policy_group)}`);
			if (data?.effective_scope) console.log(`  Effective scope: ${String(data.effective_scope)}`);
			if (typeof data?.memory_count === "number") console.log(`  Memory count: ${data.memory_count}`);
		});

	agentCmd
		.command("set <name>")
		.description("Set an agent's daemon-backed memory policy")
		.option("--memory <policy>", "Memory read policy: isolated|shared|group")
		.option("--group <group>", "Policy group name (required when --memory=group)")
		.option("--name <name>", "Rename an organization agent")
		.action(async (name: string, options: { memory?: string; group?: string; name?: string }) => {
			if (cliTransport()) {
				if (options.memory || options.group || !options.name)
					throw new Error("Organization agents use classifications, not local read policies. Use --name to rename.");
				await organizationAgent("set", name, { name: options.name });
				return;
			}
			if (!options.memory) throw new Error("--memory is required for a local agent");
			const err = validateName(name);
			if (err) {
				console.log(chalk.red(`  ${err}`));
				process.exit(1);
			}
			const result = await deps.fetchFromDaemon<Record<string, unknown>>(`/api/agents/${encodeURIComponent(name)}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					memory: options.memory,
					...(options.group !== undefined ? { group: options.group } : {}),
				}),
			});
			if (!result || typeof result.error === "string") {
				console.log(chalk.red(`  ${typeof result?.error === "string" ? result.error : "Daemon unavailable"}`));
				process.exit(1);
			}
			console.log(`  Agent ${name} policy set to ${String(result.read_policy)}`);
		});
}
