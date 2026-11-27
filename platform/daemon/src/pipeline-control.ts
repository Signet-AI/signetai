import { readRuntimeConfigFile } from "./runtime-config-file";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { atomicPrivateWrite, withFileLock } from "@signet/sdk/node";
import { auditStatement, IdentityError, organizationWrite } from "./auth/organization-store";
import type { Principal } from "./auth/principal";
import { loadMemoryConfigFromText } from "./memory-config";
import {
	AGENTS_DIR,
	pipelineTransition,
	readPipelineMode,
	restartPipelineRuntimeRef,
	setPipelineTransition,
	telemetryRef,
} from "./routes/state";

const MAX_CONFIG_BYTES = 1_048_576;
async function publish(file: string, text: string): Promise<void> {
	if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new IdentityError(413, "config_too_large");
	if ((await lstat(file)).isSymbolicLink()) throw new IdentityError(409, "config_symlink");
	await atomicPrivateWrite(file, text);
}
export async function changePipelinePause(p: Principal, paused: boolean) {
	if (!p.permissions.has("admin")) throw new IdentityError(403, "permission", "Requires the admin role");
	if (p.boundAgentId !== null) throw new IdentityError(403, "agent_not_permitted");
	if (p.allowedProjects !== null) throw new IdentityError(403, "project_not_permitted");
	return withFileLock(join(AGENTS_DIR, ".pipeline-config.lock"), async () => {
		if (pipelineTransition)
			throw new IdentityError(409, "pipeline_transition", "Pipeline transition already in progress");
		setPipelineTransition(true);
		try {
			const previous = await readRuntimeConfigFile(AGENTS_DIR, true);
			const before = loadMemoryConfigFromText(AGENTS_DIR, previous.text, previous.file);
			const document = parseDocument(previous.text);
			if (document.errors.length) throw new IdentityError(400, "invalid_config");
			document.setIn(["memory", "pipelineV2", "paused"], paused);
			const changed = before.pipelineV2.paused !== paused;
			const nextText = document.toString();
			const next = loadMemoryConfigFromText(AGENTS_DIR, nextText, previous.file);
			const restart = restartPipelineRuntimeRef;
			if (changed && !restart) throw new IdentityError(503, "pipeline_unavailable", "Pipeline runtime not initialized");
			await organizationWrite([
				auditStatement(p, "operator.pipeline_transition_started", "operator", "pipeline", { paused }),
			]);
			if (changed && restart) {
				try {
					await publish(previous.file, nextText);
					await restart(next, telemetryRef);
				} catch (error) {
					const restored = await Promise.allSettled([
						publish(previous.file, previous.text).then(() => restart(before, telemetryRef)),
					]);
					const rollback = restored[0];
					if (rollback?.status === "rejected")
						throw new AggregateError([error, rollback.reason], "Pipeline transition and rollback failed", {
							cause: error,
						});
					throw error;
				}
			}
			await organizationWrite([
				auditStatement(p, paused ? "operator.pipeline_paused" : "operator.pipeline_resumed", "operator", "pipeline", {
					changed,
					paused,
				}),
			]);
			return { success: true, changed, paused, file: previous.file, mode: readPipelineMode(next.pipelineV2) };
		} catch (error) {
			await organizationWrite([
				auditStatement(p, "operator.pipeline_transition_failed", "operator", "pipeline", { paused }, "failed"),
			]);
			throw error;
		} finally {
			setPipelineTransition(false);
		}
	});
}
