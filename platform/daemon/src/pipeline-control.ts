import { readRuntimeConfigFile } from "./runtime-config-file";
import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { formatYaml, parseSimpleYaml } from "@signet/core";
import { z } from "zod";
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
	const temporary = `${file}.pause-${randomUUID()}`;
	const handle = await open(temporary, "wx", 0o600);
	let pending = true;
	try {
		try {
			await handle.writeFile(text);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, file);
		pending = false;
		if (process.platform !== "win32") {
			const directory = await open(dirname(file), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		}
	} finally {
		if (pending) await unlink(temporary);
	}
}
export async function changePipelinePause(p: Principal, paused: boolean) {
	if (!p.permissions.has("admin")) throw new IdentityError(403, "permission", "Requires the admin role");
	if (p.boundAgentId !== null) throw new IdentityError(403, "agent_not_permitted");
	if (p.allowedProjects !== null) throw new IdentityError(403, "project_not_permitted");
	if (pipelineTransition)
		throw new IdentityError(409, "pipeline_transition", "Pipeline transition already in progress");
	setPipelineTransition(true);
	try {
		const previous = await readRuntimeConfigFile(AGENTS_DIR);
		const before = loadMemoryConfigFromText(AGENTS_DIR, previous.text, previous.file);
		const root = z.record(z.string(), z.unknown()).parse(parseSimpleYaml(previous.text));
		const memory = root.memory === undefined ? {} : z.record(z.string(), z.unknown()).parse(root.memory);
		const pipeline = memory.pipelineV2 === undefined ? {} : z.record(z.string(), z.unknown()).parse(memory.pipelineV2);
		const changed = before.pipelineV2.paused !== paused;
		const nextText = formatYaml({ ...root, memory: { ...memory, pipelineV2: { ...pipeline, paused } } });
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
				await publish(previous.file, previous.text);
				await restart(before, telemetryRef);
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
}
