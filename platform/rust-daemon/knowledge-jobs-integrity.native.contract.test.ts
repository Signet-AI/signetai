import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";

const root = process.cwd();
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const workspaces: string[] = [];

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("failed to allocate a native contract port");
	}
	const port = address.port;
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return port;
}

async function startDaemon(workspace: string): Promise<{ origin: string; child: Bun.Subprocess }> {
	const port = await freePort();
	const child = Bun.spawn([binary], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_AGENT_ID: "integrity-agent",
			SIGNET_API_KEY: "",
			SIGNET_TOKEN: "",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	const origin = `http://127.0.0.1:${port}`;
	let lastError = "";
	for (let attempt = 0; attempt < 200; attempt += 1) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { origin, child };
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		const exited = await Promise.race([
			child.exited.then((code) => code),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 25)),
		]);
		if (exited !== null) {
			const stderr = await new Response(child.stderr).text();
			throw new Error(`native daemon exited during readiness (${exited}): ${lastError}\n${stderr}`);
		}
	}
	throw new Error(`native daemon readiness timed out: ${lastError}`);
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill("SIGTERM");
		const exited = await Promise.race([
			child.exited,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
		]);
		if (exited === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
	}
	for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

test("knowledge scope aliases and dreaming cancellation are enforced by native boundaries", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "signet-integrity-contract-"));
	workspaces.push(workspace);
	const daemon = await startDaemon(workspace);
	const baseHeaders = { "x-signet-agent": "agent-a", "x-workspace-id": "workspace-a" };

	const conflictingHeaders = await fetch(`${daemon.origin}/api/knowledge/entities?workspace_id=workspace-a`, {
		headers: { ...baseHeaders, "x-signet-workspace-id": "workspace-b" },
	});
	expect(conflictingHeaders.status).toBe(400);

	const conflictingQuery = await fetch(`${daemon.origin}/api/knowledge/entities?workspace_id=workspace-b`, {
		headers: baseHeaders,
	});
	expect(conflictingQuery.status).toBe(400);

	const submitted = await fetch(`${daemon.origin}/api/jobs`, {
		method: "POST",
		headers: { ...baseHeaders, "content-type": "application/json" },
		body: JSON.stringify({ kind: "dreaming", payload: { batch: 1 } }),
	});
	expect(submitted.status).toBe(200);
	const job = (await submitted.json()) as { id: string; state: string };
	expect(job.state).toBe("queued");

	const cancelled = await fetch(`${daemon.origin}/api/jobs/${job.id}`, {
		method: "DELETE",
		headers: baseHeaders,
	});
	expect(cancelled.status).toBe(200);
	expect((await cancelled.json()).state).toBe("cancelled");
});
