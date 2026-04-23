import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	allTargetRefs,
	parseRoutingConfig,
	parseRoutingTargetRef,
	parseYamlDocument,
	stringifyYamlDocument,
} from "@signet/core";
import chalk from "chalk";
import type { Command } from "commander";
import type { DaemonApiCall, DaemonFetch } from "../lib/daemon.js";
import { withJson } from "./shared.js";

interface RouteDeps {
	readonly AGENTS_DIR: string;
	readonly fetchFromDaemon: DaemonFetch;
	readonly secretApiCall: DaemonApiCall;
}

interface RouteStatusResponse {
	readonly enabled: boolean;
	readonly source: string;
	readonly defaultPolicy?: string;
	readonly defaultAgentId: string;
	readonly policies: readonly string[];
	readonly taskClasses: readonly string[];
	readonly targetRefs: readonly string[];
	readonly workloadBindings: {
		readonly interactive?: string;
		readonly memoryExtraction?: string;
		readonly sessionSynthesis?: string;
	};
	readonly accounts: Record<
		string,
		{ readonly kind: string; readonly providerFamily: string; readonly label?: string }
	>;
	readonly targets: Record<
		string,
		{
			readonly kind: string;
			readonly executor: string;
			readonly account?: string;
			readonly privacy?: string;
			readonly models: Record<string, { readonly model: string; readonly label?: string }>;
		}
	>;
	readonly agents: readonly string[];
	readonly runtimeSnapshot: {
		readonly targets: Record<
			string,
			{
				readonly available: boolean;
				readonly health: string;
				readonly accountState: string;
				readonly unavailableReason?: string;
			}
		>;
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMaxTokens(value: unknown): number | null | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!/^[1-9]\d*$/.test(trimmed)) return null;
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePinnedTargetRef(
	data: Record<string, unknown>,
	targetRef: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string } {
	const parsed = parseRoutingTargetRef(targetRef);
	if (!parsed.ok) return { ok: false, error: parsed.error.message };
	const normalized = `${parsed.value.targetId}/${parsed.value.modelId}`;
	const config = parseRoutingConfig(data);
	if (!config.ok) return { ok: false, error: config.error.message };
	const knownRefs = allTargetRefs(config.value);
	if (knownRefs.length > 0 && !knownRefs.includes(normalized)) {
		return { ok: false, error: `Unknown target ref "${normalized}". Known targets: ${knownRefs.join(", ")}.` };
	}
	return { ok: true, value: normalized };
}

interface AgentYamlFile {
	readonly path: string;
	readonly exists: boolean;
	readonly data: Record<string, unknown>;
}

function readAgentYaml(agentsDir: string): AgentYamlFile {
	const path = join(agentsDir, "agent.yaml");
	if (!existsSync(path)) {
		return { path, exists: false, data: {} };
	}
	const parsed = parseYamlDocument(readFileSync(path, "utf-8"));
	return { path, exists: true, data: isRecord(parsed) ? parsed : {} };
}

function writeAgentYaml(file: AgentYamlFile, data: Record<string, unknown>, allowRewrite: boolean): void {
	if (file.exists && !allowRewrite) {
		console.error(
			chalk.red(
				"Refusing to rewrite existing agent.yaml because route pin/unpin serializes YAML and may change comments or formatting.",
			),
		);
		console.error(chalk.yellow("Re-run with --rewrite-agent-yaml to confirm this destructive rewrite."));
		process.exit(1);
	}
	const path = file.path;
	writeFileSync(path, stringifyYamlDocument(data));
}

function ensureRoutingAgent(data: Record<string, unknown>, agentId: string): Record<string, unknown> {
	const inference = isRecord(data.inference) ? data.inference : {};
	const agents = isRecord(inference.agents) ? inference.agents : {};
	const agent = isRecord(agents[agentId]) ? agents[agentId] : {};
	agents[agentId] = agent;
	inference.agents = agents;
	data.inference = inference;
	return agent;
}

function setPinnedTarget(data: Record<string, unknown>, agentId: string, key: string, targetRef: string): void {
	const agent = ensureRoutingAgent(data, agentId);
	const pinned = isRecord(agent.pinnedTargets) ? agent.pinnedTargets : {};
	pinned[key] = targetRef;
	agent.pinnedTargets = pinned;
}

function removePinnedTarget(data: Record<string, unknown>, agentId: string, key: string): boolean {
	if (!isRecord(data.inference)) return false;
	const inference = data.inference;
	if (!isRecord(inference.agents)) return false;
	const agents = inference.agents;
	if (!isRecord(agents[agentId])) return false;
	const agent = agents[agentId];
	if (!isRecord(agent.pinnedTargets)) return false;
	const pinned = agent.pinnedTargets;
	if (!(key in pinned)) return false;
	Reflect.deleteProperty(pinned, key);
	if (Object.keys(pinned).length === 0) {
		Reflect.deleteProperty(agent, "pinnedTargets");
	}
	if (Object.keys(agent).length === 0) {
		Reflect.deleteProperty(agents, agentId);
	}
	return true;
}

function printStatus(status: RouteStatusResponse): void {
	console.log(chalk.bold("\n  Inference\n"));
	console.log(chalk.dim(`  Enabled:        ${status.enabled ? "yes" : "no"}`));
	console.log(chalk.dim(`  Source:         ${status.source}`));
	console.log(chalk.dim(`  Default policy: ${status.defaultPolicy ?? "-"}`));
	console.log(chalk.dim(`  Default agent:  ${status.defaultAgentId}`));
	console.log(chalk.dim(`  Policies:       ${status.policies.join(", ") || "-"}`));
	console.log(chalk.dim(`  Task classes:   ${status.taskClasses.join(", ") || "-"}`));
	console.log(
		chalk.dim(
			`  Workloads:      interactive=${status.workloadBindings.interactive ?? "-"}, extraction=${status.workloadBindings.memoryExtraction ?? "-"}, synthesis=${status.workloadBindings.sessionSynthesis ?? "-"}`,
		),
	);
	console.log();

	if (status.targetRefs.length === 0) {
		console.log(chalk.dim("  No route targets configured."));
		console.log();
		return;
	}

	console.log(chalk.bold("  Targets\n"));
	for (const targetRef of status.targetRefs) {
		const runtime = status.runtimeSnapshot.targets[targetRef];
		const [targetId, modelId] = targetRef.split("/");
		const target = status.targets[targetId];
		const model = target?.models?.[modelId];
		const health = runtime?.available ? chalk.green(runtime.health) : chalk.red(runtime?.health ?? "blocked");
		console.log(`  ${chalk.cyan(targetRef)}  ${health}`);
		console.log(
			chalk.dim(
				`    executor=${target?.executor ?? "?"}  privacy=${target?.privacy ?? "?"}  account=${target?.account ?? "-"}  model=${model?.model ?? modelId}`,
			),
		);
		if (runtime && !runtime.available && runtime.unavailableReason) {
			console.log(chalk.yellow(`    ${runtime.unavailableReason}`));
		}
	}
	console.log();
}

export function registerRouteCommands(program: Command, deps: RouteDeps): void {
	const routeCmd = program.command("route").alias("inference").description("Inspect and control Signet inference");

	const list = routeCmd
		.command("list")
		.description("List inference config and runtime state")
		.action(async (options) => {
			const status = await deps.fetchFromDaemon<RouteStatusResponse>("/api/inference/status");
			if (!status) {
				console.error(chalk.red("Failed to get inference status from daemon"));
				process.exit(1);
			}
			if ((options as { json?: boolean }).json) {
				console.log(JSON.stringify(status, null, 2));
				return;
			}
			printStatus(status);
		});
	withJson(list);

	const statusCmd = routeCmd
		.command("status")
		.description("Show inference health and workload bindings")
		.action(async (options) => {
			const status = await deps.fetchFromDaemon<RouteStatusResponse>("/api/inference/status");
			if (!status) {
				console.error(chalk.red("Failed to get inference status from daemon"));
				process.exit(1);
			}
			if ((options as { json?: boolean }).json) {
				console.log(JSON.stringify(status, null, 2));
				return;
			}
			printStatus(status);
		});
	withJson(statusCmd);

	const doctorCmd = routeCmd
		.command("doctor")
		.description("Diagnose broken route targets and workload bindings")
		.action(async (options) => {
			const status = await deps.fetchFromDaemon<RouteStatusResponse>("/api/inference/status");
			if (!status) {
				console.error(chalk.red("Failed to get inference status from daemon"));
				process.exit(1);
			}
			const issues = status.targetRefs.flatMap((targetRef) => {
				const runtime = status.runtimeSnapshot.targets[targetRef];
				if (!runtime || runtime.available) return [];
				return [`${targetRef}: ${runtime.unavailableReason ?? runtime.health}`];
			});
			const summary = {
				enabled: status.enabled,
				source: status.source,
				defaultPolicy: status.defaultPolicy ?? null,
				defaultAgentId: status.defaultAgentId,
				issues,
			};
			if ((options as { json?: boolean }).json) {
				console.log(JSON.stringify(summary, null, 2));
				return;
			}
			console.log(chalk.bold("\n  Route doctor\n"));
			console.log(chalk.dim(`  Enabled:        ${status.enabled ? "yes" : "no"}`));
			console.log(chalk.dim(`  Source:         ${status.source}`));
			console.log(chalk.dim(`  Default policy: ${status.defaultPolicy ?? "-"}`));
			if (issues.length === 0) {
				console.log(chalk.green("\n  No broken route targets detected.\n"));
				return;
			}
			for (const issue of issues) {
				console.log(chalk.red(`  - ${issue}`));
			}
			console.log();
			process.exitCode = 1;
		});
	withJson(doctorCmd);

	routeCmd
		.command("explain <prompt>")
		.description("Dry-run an inference decision for a prompt")
		.option("--agent <agent>", "Agent id")
		.option("--task-class <taskClass>", "Task class override")
		.option("--operation <operation>", "Operation kind", "interactive")
		.option("--privacy <privacy>", "Privacy tier")
		.option("--policy <policy>", "Policy override")
		.option("--target <targetRef>", "Pin to an explicit target ref")
		.option("--refresh", "Refresh target health before inference")
		.option("--debug", "Print the full decision trace")
		.option("--json", "Output as JSON")
		.action(async (prompt: string, options) => {
			const { ok, data } = await deps.secretApiCall("POST", "/api/inference/explain", {
				agentId: options.agent,
				taskClass: options.taskClass,
				operation: options.operation,
				privacy: options.privacy,
				explicitPolicy: options.policy,
				explicitTargets: options.target ? [options.target] : undefined,
				promptPreview: prompt,
				refresh: options.refresh === true,
			});
			if (!ok) {
				console.error(chalk.red(`Inference explain failed: ${JSON.stringify(data)}`));
				process.exit(1);
			}
			if (options.json) {
				console.log(JSON.stringify(data, null, 2));
				return;
			}
			const decision = data as {
				targetRef?: string;
				policyId?: string;
				taskClass?: string;
				trace?: {
					candidates?: Array<{
						targetRef: string;
						allowed: boolean;
						score: number | null;
						blockedBy: readonly string[];
						reasons: readonly string[];
					}>;
				};
			};
			console.log(chalk.bold("\n  Route explain\n"));
			console.log(chalk.dim(`  Policy:    ${decision.policyId ?? "-"}`));
			console.log(chalk.dim(`  Task:      ${decision.taskClass ?? "-"}`));
			console.log(chalk.dim(`  Selected:  ${decision.targetRef ?? "-"}`));
			console.log();
			for (const candidate of decision.trace?.candidates ?? []) {
				const statusLabel = candidate.allowed ? chalk.green("allow") : chalk.red("block");
				console.log(`  ${statusLabel} ${chalk.cyan(candidate.targetRef)}`);
				if (candidate.reasons.length > 0) {
					console.log(chalk.dim(`    reasons: ${candidate.reasons.join(", ")}`));
				}
				if (candidate.blockedBy.length > 0) {
					console.log(chalk.yellow(`    blocked: ${candidate.blockedBy.join(", ")}`));
				}
			}
			if (options.debug) {
				console.log(chalk.bold("\n  Trace\n"));
				console.log(JSON.stringify(decision.trace ?? null, null, 2));
			}
			console.log();
		});

	routeCmd
		.command("test <prompt>")
		.description("Execute a real routed prompt")
		.option("--agent <agent>", "Agent id")
		.option("--task-class <taskClass>", "Task class override")
		.option("--operation <operation>", "Operation kind", "interactive")
		.option("--privacy <privacy>", "Privacy tier")
		.option("--policy <policy>", "Policy override")
		.option("--target <targetRef>", "Pin to an explicit target ref")
		.option("--max-tokens <maxTokens>", "Max output tokens")
		.option("--refresh", "Refresh target health before inference")
		.option("--debug", "Print the routed decision trace")
		.option("--json", "Output as JSON")
		.action(async (prompt: string, options) => {
			const maxTokens = parseMaxTokens(options.maxTokens);
			if (maxTokens === null) {
				console.error(chalk.red("--max-tokens must be a positive integer."));
				process.exit(1);
				return;
			}
			const { ok, data } = await deps.secretApiCall("POST", "/api/inference/execute", {
				prompt,
				agentId: options.agent,
				taskClass: options.taskClass,
				operation: options.operation,
				privacy: options.privacy,
				explicitPolicy: options.policy,
				explicitTargets: options.target ? [options.target] : undefined,
				maxTokens,
				refresh: options.refresh === true,
			});
			if (!ok) {
				console.error(chalk.red(`Routing test failed: ${JSON.stringify(data)}`));
				process.exit(1);
			}
			if (options.json) {
				console.log(JSON.stringify(data, null, 2));
				return;
			}
			const result = data as {
				text?: string;
				decision?: { targetRef?: string };
				attempts?: Array<{ targetRef: string; ok: boolean; error?: string }>;
			};
			console.log(chalk.bold("\n  Route test\n"));
			console.log(chalk.dim(`  Selected: ${result.decision?.targetRef ?? "-"}`));
			for (const attempt of result.attempts ?? []) {
				console.log(
					`  ${attempt.ok ? chalk.green("ok") : chalk.red("fail")} ${attempt.targetRef}${attempt.error ? ` - ${attempt.error}` : ""}`,
				);
			}
			if (options.debug) {
				console.log(chalk.bold("\n  Decision\n"));
				console.log(JSON.stringify(result.decision ?? null, null, 2));
			}
			console.log();
			console.log(result.text ?? "");
		});

	routeCmd
		.command("pin <targetRef>")
		.description("Pin an agent/task-class to a target ref in agent.yaml")
		.option("--agent <agent>", "Agent id", "default")
		.option("--task-class <taskClass>", "Task class pin key", "default")
		.option("--rewrite-agent-yaml", "Allow rewriting existing agent.yaml; comments and formatting may be changed")
		.action((targetRef: string, options: { agent: string; taskClass: string; rewriteAgentYaml?: boolean }) => {
			const file = readAgentYaml(deps.AGENTS_DIR);
			const { data } = file;
			const parsed = parsePinnedTargetRef(data, targetRef);
			if (!parsed.ok) {
				console.error(chalk.red(parsed.error));
				process.exit(1);
				return;
			}
			setPinnedTarget(data, options.agent, options.taskClass, parsed.value);
			writeAgentYaml(file, data, options.rewriteAgentYaml === true);
			console.log(chalk.green(`Pinned ${options.agent}/${options.taskClass} -> ${parsed.value}`));
		});

	routeCmd
		.command("unpin")
		.description("Remove an agent/task-class pin from agent.yaml")
		.option("--agent <agent>", "Agent id", "default")
		.option("--task-class <taskClass>", "Task class pin key", "default")
		.option("--rewrite-agent-yaml", "Allow rewriting existing agent.yaml; comments and formatting may be changed")
		.action((options: { agent: string; taskClass: string; rewriteAgentYaml?: boolean }) => {
			const file = readAgentYaml(deps.AGENTS_DIR);
			const { data } = file;
			const removed = removePinnedTarget(data, options.agent, options.taskClass);
			if (!removed) {
				console.log(chalk.yellow(`No pin found for ${options.agent}/${options.taskClass}`));
				return;
			}
			writeAgentYaml(file, data, options.rewriteAgentYaml === true);
			console.log(chalk.green(`Removed pin for ${options.agent}/${options.taskClass}`));
		});
}
