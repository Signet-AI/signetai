import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OrgDaemon, repo } from "./daemon";
import { Fixture } from "./fixture";
import { record, request, success, text } from "./http";

test("remote --as-evidence imports foreign JSON without restoring authors or graph authority", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.create(daemon, "personal", false);
		const carol = fixture.user("carol");
		const path = join(daemon.root, "foreign.json");
		await writeFile(
			path,
			JSON.stringify({
				id: "foreign-memory",
				authorUserId: "foreign-author",
				content: "foreign provenance evidence marker",
				entities: [{ id: "foreign-entity", name: "Not an authoritative entity" }],
			}),
		);
		const env: NodeJS.ProcessEnv = { ...daemon.env, SIGNET_API_KEY: text(carol.session.bearer) };
		delete env.SIGNET_DAEMON_ENTRYPOINT;
		const child = Bun.spawn(
			[
				process.execPath,
				join(repo, "surfaces/cli/src/cli.ts"),
				"import",
				path,
				"--agent",
				carol.agentId,
				"--classification",
				fixture.hrId,
				"--as-evidence",
				"--non-interactive",
				"--json",
			],
			{
				cwd: repo,
				env,
				stdout: "pipe",
				stderr: "pipe",
				timeout: 30_000,
			},
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, stderr).toBe(0);
		const result = record(JSON.parse(stdout));
		expect(result.imported).toBe(1);
		if (!Array.isArray(result.files)) throw new Error("missing import files");
		const sourceId = text(record(result.files[0]).sourceId);
		const outsiders = success(
			await request(daemon.origin, `/api/sources?agentId=${carol.agentId}`, fixture.admin),
			"outsider sources",
		);
		expect(JSON.stringify(outsiders)).not.toContain(sourceId);
		await daemon.stop();
		const db = new Database(join(daemon.workspace, "data/signet.db"), { readonly: true });
		try {
			const artifact = db
				.query<{ content: string; author_user_id: string; compartment_id: number | null }, [string]>(
					"SELECT content,author_user_id,compartment_id FROM memory_artifacts WHERE source_id=?",
				)
				.get(sourceId);
			expect(artifact?.author_user_id).toBe(carol.id);
			expect(artifact?.compartment_id).toBeNumber();
			expect(artifact?.content).toContain("foreign-author");
			expect(artifact?.content).toContain("foreign provenance evidence marker");
			expect(db.query("SELECT id FROM memories WHERE id='foreign-memory'").get()).toBeNull();
			expect(db.query("SELECT id FROM entities WHERE id='foreign-entity'").get()).toBeNull();
		} finally {
			db.close();
		}
	} finally {
		await daemon.dispose();
	}
}, 60_000);
