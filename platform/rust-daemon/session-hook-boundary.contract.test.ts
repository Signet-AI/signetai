import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary =
	process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const workspaces: string[] = [];
let port = 39100;

async function start(workspace = mkdtempSync(join(tmpdir(), "signet-boundary-"))) {
	workspaces.push(workspace);
	const child = Bun.spawn([binary], {
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port++),
			SIGNET_AGENT_ID: "",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	const origin = `http://127.0.0.1:${port - 1}`;
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { child, origin, workspace };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error("native daemon readiness timeout");
}

async function stop(child: Bun.Subprocess) {
	child.kill();
	await child.exited;
	const index = children.indexOf(child);
	if (index >= 0) children.splice(index, 1);
}

const jsonHeaders = (agent: string, workspace?: string) => ({
	"content-type": "application/json",
	"x-signet-agent-id": agent,
	...(workspace ? { "x-workspace-id": workspace } : {}),
});
async function post(origin: string, path: string, agent: string, body: unknown, workspace?: string) {
	return fetch(`${origin}${path}`, {
		method: "POST",
		headers: jsonHeaders(agent, workspace),
		body: JSON.stringify(body),
	});
}

afterEach(async () => {
	for (const child of children.splice(0)) await stop(child);
	for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

it("proves the native session/hook/event boundary with two scoped agents", async () => {
	if (!existsSync(binary)) throw new Error(`missing native daemon: ${binary}`);
	const first = await start();
	const session = { session_key: "session-utf8-✓", harness: "bun", project: "scratch" };
	expect((await post(first.origin, "/api/boundary/sessions/start", "agent-a", session)).status).toBe(200);
	expect((await post(first.origin, "/api/boundary/sessions/start", "agent-a", session)).status).toBe(200);
	expect(
		(await post(first.origin, "/api/boundary/sessions/end", "agent-a", { session_key: session.session_key })).status,
	).toBe(200);
	expect(
		(
			(
				await post(first.origin, "/api/boundary/sessions/end", "agent-a", { session_key: session.session_key })
			).json() as { idempotent?: boolean }
		).idempotent,
	).toBe(true);

	const receipt = {
		receipt_id: "receipt-1",
		checkpoint: "cp-1",
		hook: "UserPromptSubmit",
		session_key: session.session_key,
		payload: { text: "café", missing: null },
	};
	expect((await post(first.origin, "/api/boundary/hooks/receipt", "agent-a", receipt)).status).toBe(200);
	expect(
		(await post(first.origin, "/api/boundary/hooks/receipt", "agent-a", { ...receipt, checkpoint: "cp-2" })).status,
	).toBe(200);
	const page = await fetch(
		`${first.origin}/api/boundary/poll?session_key=${encodeURIComponent(session.session_key)}&after_id=0&limit=100`,
		{ headers: { "x-signet-agent-id": "agent-a" } },
	);
	expect(page.status).toBe(200);
	const snapshot = (await page.json()) as {
		complete: boolean;
		streaming: boolean;
		cursor: number;
		data: { receipts: Array<{ receiptId: string; checkpoint: string }> };
	};
	expect(snapshot.complete).toBe(true);
	expect(snapshot.streaming).toBe(false);
	expect(snapshot.data.receipts).toHaveLength(1);
	expect(snapshot.data.receipts[0].checkpoint).toBe("cp-2");
	expect(snapshot.cursor).toBeGreaterThan(0);

	const workspace = "workspace-a";
	expect(
		(
			await post(
				first.origin,
				"/api/boundary/messages",
				"agent-a",
				{ workspace_id: workspace, recipient_agent_id: "agent-b", kind: "notify", payload: { text: "hello" } },
				workspace,
			)
		).status,
	).toBe(200);
	expect(
		(
			await post(
				first.origin,
				"/api/boundary/messages",
				"agent-a",
				{ workspace_id: workspace, recipient_agent_id: "agent-b", kind: "notify", payload: { text: "wrong scope" } },
				"workspace-b",
			)
		).status,
	).toBe(404);
	const recipient = await fetch(`${first.origin}/api/boundary/poll?workspace_id=${workspace}&after_id=0&limit=100`, {
		headers: { "x-signet-agent-id": "agent-b", "x-workspace-id": workspace },
	});
	expect((await recipient.json()).data.messages).toHaveLength(1);
	const sender = await fetch(`${first.origin}/api/boundary/poll?workspace_id=${workspace}&after_id=0&limit=100`, {
		headers: { "x-signet-agent-id": "agent-a", "x-workspace-id": workspace },
	});
	expect((await sender.json()).data.messages).toHaveLength(0);

	expect(
		(await post(first.origin, "/api/boundary/hooks/receipt", "agent-a", { ...receipt, receipt_id: "x".repeat(257) }))
			.status,
	).toBe(400);
	expect(
		(
			await fetch(`${first.origin}/api/boundary/events?workspace_id=${workspace}&after_id=0`, {
				headers: { "x-signet-agent-id": "agent-b", "x-workspace-id": workspace },
			})
		).text(),
	).resolves.toContain("event: snapshot");
	await stop(first.child);
	const restarted = await start(first.workspace);
	const persisted = await fetch(
		`${restarted.origin}/api/boundary/poll?session_key=${encodeURIComponent(session.session_key)}&after_id=0`,
		{ headers: { "x-signet-agent-id": "agent-a" } },
	);
	expect((await persisted.json()).data.receipts).toHaveLength(1);
});
