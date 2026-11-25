import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCodeConnector } from "./src/index";
import { ConnectorRegistry, DurableOutbox, writeKeyFile } from "../../../libs/sdk/src/node";

test("Claude direct session-end reports rejection after durably retaining evidence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "claude-direct-"));
	const transcriptPath = join(directory, "session.jsonl");
	await writeFile(transcriptPath, "preserved evidence");
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			expect(request.headers.get("authorization")).toBe("Bearer direct-credential");
			return Response.json({ reason: "expired", error: "expired" }, { status: 401 });
		},
	});
	const harness = "claude-code";
	const registry = new ConnectorRegistry();
	const previous = (await registry.read())[harness];
	const keyFile = await writeKeyFile(server.url.origin, harness, "direct-credential");
	await registry.set(harness, { url: server.url.origin, keyFile });
	try {
		const result = await new ClaudeCodeConnector({ daemonUrl: server.url.origin }).onSessionEnd({
			sessionId: "direct-session",
			projectPath: "/project",
			transcriptPath,
		});
		expect(result.success).toBe(false);
		expect((await new DurableOutbox(server.url.origin, { harness }).status()).pending).toBe(1);
	} finally {
		server.stop(true);
		await rm(directory, { recursive: true, force: true });
		if (previous) await registry.set(harness, previous);
		else await registry.remove(harness);
	}
});
