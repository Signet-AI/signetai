import "../../../tests/support/connector-safety.js";
import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCodeConnector } from "./src/index";
import { ConnectorRegistry, DurableOutbox, writeKeyFile } from "../../../libs/sdk/src/node";

test("Claude accepts detached dispatch and retains evidence after rejection", async () => {
	const previousLauncher = process.env.SIGNET_HOOK_COMMAND;
	process.env.SIGNET_HOOK_COMMAND = JSON.stringify([
		process.execPath,
		new URL("../../../surfaces/cli/dist/cli.js", import.meta.url).pathname,
	]);
	let rejected = 0;
	const directory = await mkdtemp(join(tmpdir(), "claude-direct-"));
	const transcriptPath = join(directory, "session.jsonl");
	await writeFile(transcriptPath, "preserved evidence");
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname !== "/api/hooks/session-end") return Response.json({});
			rejected++;
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
		expect(result.success).toBe(true);
		const outbox = new DurableOutbox(server.url.origin, { harness });
		const deadline = Date.now() + 3000;
		let state = await outbox.status();
		while ((!rejected || !state.pending || state.claimed) && Date.now() < deadline) {
			await Bun.sleep(5);
			state = await outbox.status();
		}
		expect(rejected).toBe(1);
		expect(state.pending).toBe(1);
		expect(state.claimed).toBe(0);
	} finally {
		server.stop(true);
		if (previousLauncher === undefined) delete process.env.SIGNET_HOOK_COMMAND;
		else process.env.SIGNET_HOOK_COMMAND = previousLauncher;
		await rm(directory, { recursive: true, force: true });
		if (previous) await registry.set(harness, previous);
		else await registry.remove(harness);
	}
});
