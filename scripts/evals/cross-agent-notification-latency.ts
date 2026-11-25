#!/usr/bin/env bun

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
	acknowledgeAgentMessage,
	createAgentMessage,
	resetCrossAgentStateForTest,
	upsertAgentPresence,
} from "../../platform/daemon/src/agents/cross-agent/messages";
import { closeDbAccessor, initDbAccessor } from "../../platform/daemon/src/db/owner/accessor";
import { collectCrossAgentNotifications } from "../../platform/daemon/src/agents/cross-agent/notifications";

const SAMPLE_COUNT = 25;
const MAX_P95_MS = 250;
const dir = mkdtempSync(join(tmpdir(), "signet-notification-eval-"));

function percentile(values: readonly number[], ratio: number): number {
	const ordered = [...values].sort((left, right) => left - right);
	const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1));
	return ordered[index] ?? 0;
}

try {
	initDbAccessor(join(dir, "memory.db"), { agentsDir: dir });
	upsertAgentPresence({ agentId: "eval-recipient", harness: "opencode", sessionKey: "eval-session" });

	const latencies: number[] = [];
	for (let index = 0; index < SAMPLE_COUNT; index += 1) {
		const message = createAgentMessage({
			fromAgentId: "eval-sender",
			toAgentId: "eval-recipient",
			type: "info",
			content: `notification latency sample ${index}`,
		});
		const startedAt = performance.now();
		const delivery = collectCrossAgentNotifications({
			harness: "opencode",
			hook: "experimental.chat.system.transform",
			agentId: "eval-recipient",
			sessionKey: "eval-session",
		});
		const elapsed = performance.now() - startedAt;
		if (!delivery?.items.some((item) => item.id === message.id)) {
			throw new Error(`message ${message.id} was not injected`);
		}
		latencies.push(elapsed);
		acknowledgeAgentMessage({
			messageId: message.id,
			agentId: "eval-recipient",
			sessionKey: "eval-session",
		});
	}

	const result = {
		samples: SAMPLE_COUNT,
		p50Ms: Number(percentile(latencies, 0.5).toFixed(3)),
		p95Ms: Number(percentile(latencies, 0.95).toFixed(3)),
		maxMs: Number(Math.max(...latencies).toFixed(3)),
		budgetMs: MAX_P95_MS,
	};
	console.log(JSON.stringify(result, null, 2));
	if (result.p95Ms > MAX_P95_MS) process.exitCode = 1;
} finally {
	resetCrossAgentStateForTest();
	closeDbAccessor();
	rmSync(dir, { recursive: true, force: true });
}

process.exit(process.exitCode ?? 0);
