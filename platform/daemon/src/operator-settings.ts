import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { formatYaml, parseRoutingConfig, parseSimpleYaml } from "@signet/core";
import { z } from "zod";
import type { Principal } from "./auth/principal";
import { canActAs, principalAccess } from "./auth/agent-access";
import { requireAdmin } from "./auth/organization-operations";
import { auditStatement, IdentityError, organizationWrite } from "./auth/organization-store";
import { classificationRequest, importActor } from "./classifications";
import { operatorActor, operatorRequest } from "./operator-jobs";
import {
	operatorEmbeddingSchema,
	operatorInferenceSchema,
	operatorSettingsInputSchema,
	operatorSourceDefaultsSchema,
	type OperatorSettings,
} from "./operator-settings-contract";
import { pipelineTransition, setPipelineTransition } from "./routes/state";
import { publishRuntimeConfigFile, readRuntimeConfigFile } from "./runtime-config-file";
import { hasSecret } from "./secrets";

function record(value: unknown): Record<string, unknown> {
	return value === undefined ? {} : z.record(z.string(), z.unknown()).parse(value);
}
async function authorize(p: Principal) {
	try {
		requireAdmin(p);
		if (p.kind !== "user" || p.credential.kind !== "session" || p.boundAgentId !== null || p.allowedProjects !== null)
			throw new IdentityError(403, "permission", "Requires an unrestricted administrator session");
		await operatorRequest({ op: "authorize-global", actor: operatorActor(p) });
	} catch (error) {
		await organizationWrite([
			auditStatement(p, "operator.settings_denied", "operator", "settings", undefined, "denied"),
		]);
		throw error;
	}
}
async function instructions(workspace: string): Promise<string | null> {
	let file: Awaited<ReturnType<typeof open>>;
	try {
		file = await open(join(workspace, "AGENTS.md"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
	try {
		if (!(await file.stat()).isFile()) throw new IdentityError(400, "instructions_not_regular");
		const bytes = Buffer.alloc(65537);
		let offset = 0;
		const deadline = Date.now() + 5000;
		while (offset < bytes.length) {
			if (Date.now() >= deadline) throw new IdentityError(503, "instructions_read_deadline");
			const result = await file.read(bytes, offset, bytes.length - offset, offset);
			if (!result.bytesRead) break;
			offset += result.bytesRead;
		}
		if (offset > 65536) throw new IdentityError(413, "instructions_too_large");
		return bytes.subarray(0, offset).toString("utf8");
	} finally {
		await file.close();
	}
}
function projection(root: Record<string, unknown>, text: string): OperatorSettings {
	const inference = record(root.inference);
	const reference = record(record(inference.workloads).memoryExtraction).target;
	const [targetId, modelId] = typeof reference === "string" ? reference.split("/") : [];
	const target = targetId ? record(record(inference.targets)[targetId]) : {};
	const account = typeof target.account === "string" ? record(record(inference.accounts)[target.account]) : {};
	const configured = inference.enabled !== false && typeof target.executor === "string";
	const embedding = record(root.embedding);
	const setup = record(root.organizationSetup);
	const apiKey = embedding.api_key;
	return {
		inference: operatorInferenceSchema.parse(
			configured
				? {
						provider: target.executor,
						model: modelId ? record(record(target.models)[modelId]).model : "",
						endpoint: target.endpoint ?? null,
						credentialRef: account.credentialRef ?? null,
						allowRemote: record(record(inference.taskClasses).memory_extraction).privacy === "remote_ok",
					}
				: { provider: "none", model: "", endpoint: null, credentialRef: null, allowRemote: false },
		),
		embedding: operatorEmbeddingSchema.parse({
			provider: embedding.provider ?? "native",
			model: embedding.model ?? "nomic-embed-text-v1.5",
			dimensions: embedding.dimensions ?? 768,
			endpoint: embedding.base_url === "" ? null : (embedding.base_url ?? embedding.baseUrl ?? null),
			credentialRef: typeof apiKey === "string" && apiKey.startsWith("$secret:") ? apiKey.slice(8) : null,
		}),
		instructions: text,
		sourcesDefaults: operatorSourceDefaultsSchema.parse(
			setup.sourcesDefaults ?? { agentId: "default", classificationId: null },
		),
		complete: setup.complete === true,
	};
}
export async function getOperatorSettings(p: Principal, workspace: string): Promise<OperatorSettings> {
	await authorize(p);
	if (pipelineTransition) throw new IdentityError(409, "config_transition");
	const config = await readRuntimeConfigFile(workspace, true);
	const result = projection(record(parseSimpleYaml(config.text)), (await instructions(workspace)) ?? "");
	await organizationWrite([auditStatement(p, "operator.settings_read", "operator", "settings")]);
	return result;
}
export async function setOperatorSettings(p: Principal, workspace: string, raw: unknown): Promise<OperatorSettings> {
	await authorize(p);
	const input = operatorSettingsInputSchema.parse(raw);
	if (pipelineTransition) throw new IdentityError(409, "config_transition");
	setPipelineTransition(true);
	try {
		const previous = await readRuntimeConfigFile(workspace, true);
		const root = record(parseSimpleYaml(previous.text));
		const beforeInstructions = await instructions(workspace);
		let nextInstructions = beforeInstructions ?? "";
		if (input.section === "inference" || input.section === "embedding") {
			if (input.value.credentialRef && !(await hasSecret(input.value.credentialRef)))
				throw new IdentityError(400, "secret_unavailable", "Store this reference in Secrets first");
		}
		if (input.section === "inference") {
			const value = input.value;
			const current = record(root.inference);
			root.inference = {
				...current,
				enabled: value.provider !== "none",
				accounts: {
					...record(current.accounts),
					organization: {
						kind: "api",
						providerFamily: value.provider,
						...(value.credentialRef ? { credentialRef: value.credentialRef } : {}),
					},
				},
				targets: {
					...record(current.targets),
					organization: {
						executor: value.provider === "none" ? "openai-compatible" : value.provider,
						...(value.endpoint ? { endpoint: value.endpoint } : {}),
						...(value.credentialRef ? { account: "organization" } : {}),
						models: { default: { model: value.model || "unconfigured" } },
					},
				},
				workloads: {
					...record(current.workloads),
					memoryExtraction: { target: "organization/default", taskClass: "memory_extraction" },
				},
				taskClasses: {
					...record(current.taskClasses),
					memory_extraction: {
						...record(record(current.taskClasses).memory_extraction),
						privacy: value.allowRemote ? "remote_ok" : "local_only",
					},
				},
				policies: {
					...record(current.policies),
					organization: { mode: "automatic", defaultTargets: ["organization/default"], fallbackTargets: [] },
				},
				defaultPolicy: "organization",
			};
			if (!parseRoutingConfig(root).ok) throw new IdentityError(400, "invalid_routing_settings");
		} else if (input.section === "embedding") {
			const value = input.value;
			const currentEmbedding = record(root.embedding);
			delete currentEmbedding.baseUrl;
			root.embedding = {
				...currentEmbedding,
				provider: value.provider,
				model: value.model,
				dimensions: value.dimensions,
				base_url: value.endpoint ?? "",
				api_key: value.credentialRef ? `$secret:${value.credentialRef}` : "",
			};
		} else if (input.section === "sourcesDefaults") {
			const agent = principalAccess(p)?.agents.find((item) => item.id === input.value.agentId);
			if (!agent || !canActAs(p, agent)) throw new IdentityError(403, "agent_not_permitted");
			if (input.value.classificationId) {
				const actor = importActor(p);
				if (!actor) throw new IdentityError(403, "permission");
				const label = await classificationRequest<unknown>({ op: "get", actor, id: input.value.classificationId });
				if (!label) throw new IdentityError(404, "not_found");
			}
			root.organizationSetup = { ...record(root.organizationSetup), sourcesDefaults: input.value };
		} else if (input.section === "instructions") {
			if (Buffer.byteLength(input.value) > 65536) throw new IdentityError(413, "instructions_too_large");
			nextInstructions = input.value;
		} else root.organizationSetup = { ...record(root.organizationSetup), complete: true };
		const next = projection(root, nextInstructions);
		const file = input.section === "instructions" ? join(workspace, "AGENTS.md") : previous.file;
		const text = input.section === "instructions" ? nextInstructions : formatYaml(root);
		await organizationWrite([
			auditStatement(p, "operator.settings_update_started", "operator", "settings", { section: input.section }),
		]);
		await authorize(p);
		try {
			await publishRuntimeConfigFile(file, text);
			await organizationWrite([
				auditStatement(p, "operator.settings_updated", "operator", "settings", { section: input.section }),
			]);
		} catch (error) {
			if (input.section === "instructions" && beforeInstructions === null) await unlink(file);
			else
				await publishRuntimeConfigFile(
					file,
					input.section === "instructions" ? (beforeInstructions ?? "") : previous.text,
				);
			await organizationWrite([
				auditStatement(
					p,
					"operator.settings_update_failed",
					"operator",
					"settings",
					{ section: input.section },
					"failed",
				),
			]);
			throw error;
		}
		return next;
	} finally {
		setPipelineTransition(false);
	}
}
