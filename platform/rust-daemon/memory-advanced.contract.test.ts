import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("fresh Rust advanced memory routes", () => {
	it("commits native-note, feedback, modify, timeline, and tombstone over HTTP", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "signet-advanced-"));
		const port = 38991;
		const bin = existsSync(join(process.cwd(), "target/debug/signet-daemon"))
			? join(process.cwd(), "target/debug/signet-daemon")
			: join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
		if (!existsSync(bin)) throw new Error("build platform/rust-daemon first");
		const child = Bun.spawn([bin], {
			env: {
				...process.env,
				SIGNET_PATH: workspace,
				SIGNET_BIND: "127.0.0.1",
				SIGNET_PORT: String(port),
				SIGNET_AGENT_ID: "",
			},
			stdout: "ignore",
			stderr: "pipe",
		});
		try {
			for (let i = 0; i < 100; i++) {
				try {
					if ((await fetch(`http://127.0.0.1:${port}/health/ready`)).ok) break;
				} catch {}
				await Bun.sleep(25);
			}
			const base = `http://127.0.0.1:${port}`;
			const headers = { "content-type": "application/json", "x-signet-agent": "contract-agent" };
			const note = await fetch(`${base}/api/memory/native-note`, {
				method: "POST",
				headers,
				body: JSON.stringify({ content: "advanced note" }),
			});
			expect(note.status).toBe(200);
			const id = (await note.json()).id as string;
			expect(
				(
					await fetch(`${base}/api/memory/feedback/${id}`, {
						method: "POST",
						headers,
						body: JSON.stringify({ rating: "positive" }),
					})
				).status,
			).toBe(200);
			expect(
				(
					await fetch(`${base}/api/memory/modify/${id}`, {
						method: "POST",
						headers,
						body: JSON.stringify({ content: "modified note" }),
					})
				).status,
			).toBe(200);
			const timeline = await fetch(`${base}/api/memory/timeline/${id}`, { headers });
			expect(timeline.status).toBe(200);
			expect((await timeline.json()).items.length).toBeGreaterThanOrEqual(2);
			expect((await fetch(`${base}/api/memory/tombstone/${id}`, { method: "POST", headers, body: "{}" })).status).toBe(
				200,
			);
			expect((await fetch(`${base}/api/memory/${id}`, { headers })).status).toBe(404);
		} finally {
			child.kill("SIGTERM");
			await child.exited;
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
