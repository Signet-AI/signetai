import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "@signet/core";

export async function prepareOwnerDaemonFixture(): Promise<{ root: string; endpoint: string }> {
	const root = process.env.SIGNET_PATH;
	if (!root) throw new Error("Isolated workspace required");
	mkdirSync(join(root, "data"), { recursive: true });
	mkdirSync(join(root, ".daemon", "logs"), { recursive: true });
	writeFileSync(join(root, "workspace-layout.json"), JSON.stringify({ version: 2 }));
	writeFileSync(
		join(root, "agent.yaml"),
		"version: 1\nconfigVersion: 9\nembedding:\n  provider: none\nharnesses: []\nauth:\n  mode: local\nmemory:\n  dreaming:\n    enabled: false\n  pipelineV2:\n    enabled: false\n    reranker:\n      enabled: false\n",
	);
	const database = new Database(join(root, "data", "signet.db"));
	await database.init();
	database.close();
	return { root, endpoint: `http://127.0.0.1:${process.env.SIGNET_PORT}` };
}
