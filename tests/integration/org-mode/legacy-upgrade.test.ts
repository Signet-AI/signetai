import { expect, test } from "bun:test";
import { join } from "node:path";
import { repo } from "./daemon";
import { legacyUpgradeFixture, legacyUpgradeSnapshot } from "./legacy-upgrade-fixture";
import { record, request, success, text, until } from "./http";

test("real legacy upgrade preserves evidence and resumes committed ownership and key work after daemon restart", async () => {
	const legacy = await legacyUpgradeFixture();
	const { daemon, fixture } = legacy;
	try {
		const call = (path: string, method = "GET", body?: object) =>
			request(daemon.origin, path, fixture.admin, method, body);
		const before = await legacyUpgradeSnapshot(daemon);
		expect(before.evidence).toHaveLength(3);
		expect(before.assignments.length).toBeGreaterThan(0);
		const draft = success(await call("/api/org/upgrade/preview", "POST", legacy.plan), "upgrade preview");
		expect(
			(await call(`/api/org/upgrade/${text(draft.id)}/confirm`, "POST", { revision: draft.revision })).status,
		).toBe(202);
		let checkpoint = 0;
		await until(async () => {
			const job = success(await call(`/api/org/upgrade/${text(draft.id)}`), "upgrade progress");
			checkpoint = Number(job.completedSteps);
			return job.status === "running" && checkpoint > 0;
		}, "first durable upgrade batch");
		await daemon.stop();
		const stopped = await legacyUpgradeSnapshot(daemon);
		const stoppedJob = stopped.jobs.find((job) => job.id === draft.id);
		expect(stoppedJob?.status).toBe("running");
		expect(record(JSON.parse(stoppedJob?.progress_json ?? "{}")).cursor).toBeGreaterThanOrEqual(checkpoint);
		await daemon.start();
		let completed: Record<string, unknown> = {};
		await until(async () => {
			completed = success(await call(`/api/org/upgrade/${text(draft.id)}`), "resumed upgrade");
			return completed.status === "complete";
		}, "resumed legacy upgrade completion");
		expect(completed.appliedPlan).toEqual(draft.preview);
		expect(completed.completedSteps).toBe(completed.totalSteps);
		const after = await legacyUpgradeSnapshot(daemon);
		expect(after.evidence).toEqual(before.evidence);
		expect(after.assignments).toEqual(before.assignments);
		expect(success(await call("/api/org/agents/legacy"), "legacy inventory").agents).toEqual([]);
		const bob = fixture.user("bob");
		const visible = success(
			await request(daemon.origin, "/api/memory/legacy-org-public?agentId=default", bob.session),
			"organization reach includes retained evidence",
		);
		expect(visible.agent_id).toBe("legacy-fallback");
		const hidden = await request(daemon.origin, "/api/memory/legacy-hidden?agentId=default", bob.session);
		const missing = await request(daemon.origin, "/api/memory/never-existed?agentId=default", bob.session);
		expect(hidden.status).toBe(404);
		expect(hidden.body).toEqual(missing.body);
		expect(
			(await request(daemon.origin, "/api/memory/legacy-hidden?agentId=default", fixture.user("carol").session)).status,
		).toBe(200);
		const listed = success(await request(daemon.origin, "/api/agents", bob.session), "imported agent listing");
		if (!Array.isArray(listed.agents)) throw new Error("Agent list missing");
		const cliEnv: NodeJS.ProcessEnv = { ...daemon.env, SIGNET_API_KEY: bob.session.bearer, SIGNET_TOKEN: "" };
		delete cliEnv.SIGNET_DAEMON_ENTRYPOINT;
		const cli = Bun.spawn([process.execPath, join(repo, "surfaces/cli/src/cli.ts"), "agent", "list"], {
			cwd: repo,
			env: cliEnv,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [cliOutput, cliErrors, cliExit] = await Promise.all([
			new Response(cli.stdout).text(),
			new Response(cli.stderr).text(),
			cli.exited,
		]);
		expect(cliExit, cliOutput + cliErrors).toBe(0);
		expect(record(JSON.parse(cliOutput)).agents).toEqual(listed.agents);
		expect(listed.agents.map(record).find((agent) => agent.id === "legacy-fallback")).toMatchObject({
			name: "legacy-fallback (imported)",
			kind: "organization",
			ownerUserId: null,
			ownerGroupId: null,
			canActAs: false,
		});
		const rejected = await request(daemon.origin, "/api/hooks/remember", bob.session, "POST", {
			harness: "codex",
			agentId: "legacy-fallback",
			content: "Must not write retained evidence",
		});
		expect(rejected.status).toBe(403);
		const retainedWrite = success(
			await call("/api/hooks/remember", "POST", {
				harness: "codex",
				agentId: "legacy-fallback",
				content: "Explicit administrator retained write",
			}),
			"administrator retained write",
		);
		const retainedId = typeof retainedWrite.id === "string" ? retainedWrite.id : text(record(retainedWrite.memory).id);
		expect(success(await call(`/api/memory/${retainedId}?agentId=default`), "retained write readback").agent_id).toBe(
			"legacy-fallback",
		);
		const assigned = legacy.keys[0];
		const revoked = legacy.keys[1];
		const kept = legacy.keys[2];
		if (!assigned || !revoked || !kept) throw new Error("Missing fixture keys");
		expect((await request(daemon.origin, "/api/agents", { bearer: revoked.key })).status).toBe(401);
		const remembered = success(
			await request(daemon.origin, "/api/hooks/remember", { bearer: assigned.key }, "POST", {
				harness: "codex",
				agentId: "legacy-user",
				content: "Assigned legacy connector attribution",
			}),
			"assigned legacy key remember",
		);
		const memoryId = typeof remembered.id === "string" ? remembered.id : text(record(remembered.memory).id);
		const persisted = success(
			await request(daemon.origin, `/api/memory/${memoryId}?agentId=legacy-user`, fixture.user("alice").session),
			"assigned memory readback",
		);
		expect(persisted.agent_id).toBe("legacy-user");
		expect(persisted.authorUserId).toBe(fixture.user("alice").id);
		expect((await request(daemon.origin, "/api/auth/whoami", { bearer: kept.key })).status).toBe(200);
		const past = success(
			await call("/api/org/upgrade/preview", "POST", {
				mappings: [],
				keys: [],
				legacyKeyDeadline: "2000-01-01T00:00:00.000Z",
			}),
			"past deadline preview",
		);
		expect((await call(`/api/org/upgrade/${text(past.id)}/confirm`, "POST", { revision: past.revision })).status).toBe(
			202,
		);
		await until(
			async () => success(await call(`/api/org/upgrade/${text(past.id)}`), "deadline upgrade").status === "complete",
			"deadline application",
		);
		const expired = await request(daemon.origin, "/api/agents", { bearer: kept.key });
		expect(expired.status).toBe(401);
		expect(record(expired.body).reason).toBe("legacy_key_expired");
		expect((await request(daemon.origin, "/api/auth/whoami", { bearer: assigned.key })).status).toBe(200);
		const login = await request(daemon.origin, "/api/auth/whoami", await fixture.loginBootstrap());
		expect(login.status).toBe(200);
		success(await call("/api/org/settings", "PATCH", { agentModel: "single" }), "single-agent policy");
		const defaultWrite = success(
			await call("/api/hooks/remember", "POST", { harness: "codex", content: "New default organization write" }),
			"default organization write",
		);
		const defaultId = typeof defaultWrite.id === "string" ? defaultWrite.id : text(record(defaultWrite.memory).id);
		expect(success(await call(`/api/memory/${defaultId}?agentId=default`), "default write readback").agent_id).toBe(
			"default",
		);
	} finally {
		await daemon.dispose();
	}
}, 120_000);
