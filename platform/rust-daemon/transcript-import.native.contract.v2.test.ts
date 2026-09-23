import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd().endsWith("/platform/rust-daemon") ? join(process.cwd(), "../..") : process.cwd();
const bin = join(root, "platform/rust-daemon/target/debug/signet-daemon");

test("native transcript import metadata is scoped and durable", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "signet-transcript-contract-"));
	const port = 39900 + Math.floor(Math.random() * 500);
	const agent = `agent-${crypto.randomUUID()}`;
	const workspaceId = `workspace-${crypto.randomUUID()}`;
	const child = Bun.spawn([bin], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_AGENT_ID: agent,
		},
		stdout: "ignore",
		stderr: "ignore",
	});
	const h = { "content-type": "application/json", "x-signet-agent": agent, "x-signet-workspace-id": workspaceId };
	try {
		for (let i = 0; i < 200; i++) {
			try {
				if ((await fetch(`http://127.0.0.1:${port}/health/ready`)).ok) break;
			} catch {}
			await Bun.sleep(25);
		}
		const created = await fetch(`http://127.0.0.1:${port}/api/sources/imports`, {
			method: "POST",
			headers: h,
			body: JSON.stringify({
				schemaId: "signet-export",
				duplicateMode: "skip",
				files: [{ id: "file-1", name: "session.jsonl" }],
			}),
		});
		expect(created.status).toBe(201);
		const job = (await created.json()) as { id: string; files: Array<{ id: string }> };
		expect(job.files.at(0)?.id).toBe("file-1");
		const listed = await fetch(`http://127.0.0.1:${port}/api/sources/imports`, { headers: h });
		expect(listed.status).toBe(200);
		expect((await listed.json()).imports).toEqual([]);
		const got = await fetch(`http://127.0.0.1:${port}/api/sources/imports/${job.id}`, { headers: h });
		expect(got.status).toBe(200);
		expect((await got.json()).jobId).toBe(job.id);
		expect(
			(
				await fetch(`http://127.0.0.1:${port}/api/sources/imports/${job.id}`, {
					headers: { ...h, "x-signet-agent": "other" },
				})
			).status,
		).toBe(404);
	} finally {
		child.kill("SIGTERM");
		await child.exited;
		rmSync(workspace, { recursive: true, force: true });
	}
});
