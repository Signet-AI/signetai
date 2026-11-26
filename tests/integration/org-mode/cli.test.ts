import { expect, test } from "bun:test";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { OrgDaemon, repo } from "./daemon";
import { canonicalTranscriptPath } from "../../../platform/daemon/src/transcript-jsonl";
import { Fixture, device, connector, captureThread } from "./fixture";
import { browser, record, request, success, text } from "./http";

test("CLI organization admin flow uses the real isolated daemon", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.create(daemon, "personal", false);
		const admin = await device(daemon, fixture.admin, "cli-admin");
		const cli = async (
			args: readonly string[],
			bearer = admin.credential.bearer ?? "",
			expectedCode = 0,
			input?: string,
		) => {
			const env: NodeJS.ProcessEnv = { ...daemon.env, SIGNET_API_KEY: bearer };
			delete env.SIGNET_DAEMON_ENTRYPOINT;
			const child = Bun.spawn([process.execPath, join(repo, "surfaces/cli/src/cli.ts"), ...args], {
				env,
				cwd: repo,
				stdin: input === undefined ? "ignore" : "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			if (input !== undefined && child.stdin) {
				child.stdin.write(input);
				child.stdin.end();
			}
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(code, args[0] === "doctor" ? `${stderr}\n${stdout}` : stderr).toBe(expectedCode);
			if (expectedCode !== 0 && expectedCode !== 2) expect(stdout).toBe("");
			return JSON.parse(expectedCode === 0 || expectedCode === 2 ? stdout : stderr);
		};
		const status = await cli(["status", "--json"]);
		expect(status.identity.organization.name).toBe("Org acceptance");
		const doctor = await cli(["doctor", "--json"]);
		expect(doctor.identity.organization.name).toBe("Org acceptance");
		expect(doctor.diagnostics.database).toBe("ready");
		expect(Math.abs(doctor.clock.skewMs)).toBeLessThan(30_000);
		const inlinePath = join(daemon.home, ".gemini", "settings.json");
		await mkdir(join(daemon.home, ".gemini"), { recursive: true });
		await writeFile(inlinePath, JSON.stringify({ SIGNET_API_KEY: "fixture-inline-only" }));
		const degraded = await cli(["doctor", "--json"], text(admin.credential.bearer), 2);
		expect(degraded.findings.some((finding: { reason: string }) => finding.reason === "inline_key")).toBe(true);
		expect(JSON.stringify(degraded)).not.toContain("fixture-inline-only");
		await rm(inlinePath);
		expect((await cli(["doctor", "--json"], text(fixture.user("alice").session.bearer), 4)).reason).toBe("permission");
		expect((await cli(["restart", "--json"], text(admin.credential.bearer), 1)).reason).toBe("supervisor_required");
		expect((await cli(["daemon", "restart", "--json"], text(admin.credential.bearer), 1)).reason).toBe(
			"supervisor_required",
		);
		for (const action of ["requeue", "cancel", "prune"]) {
			const job = await cli(["repair", "queue", action, "--wait", "--json"]);
			expect(job.kind).toBe("operator");
			expect(job.status).toBe("complete");
		}
		const embeddingAudit = await cli(["embed", "audit", "--wait", "--json"]);
		expect(embeddingAudit.status).toBe("complete");
		const embeddingPreview = await cli(["embed", "backfill", "--dry-run", "--wait", "--json"]);
		expect(embeddingPreview.status).toBe("complete");
		expect(JSON.parse(embeddingPreview.progress_json).dryRun).toBe(true);
		success(
			await request(daemon.origin, "/api/memory/remember", admin.credential, "POST", {
				content: "Operator backfill proof without a configured embedding provider",
				agentId: record(status.identity.agents).defaultWrite,
			}),
			"write backfill source",
		);
		expect((await cli(["embed", "backfill", "--wait", "--json"], text(admin.credential.bearer), 1)).reason).toBe(
			"job_failed",
		);

		const purgedAgent = await cli(["agent", "add", "purge-proof", "--team", fixture.engId, "--json"]);
		expect(typeof purgedAgent.agentId).toBe("string");
		success(
			await request(
				daemon.origin,
				`/api/org/groups/${fixture.engId}/members/${status.identity.user.id}`,
				admin.credential,
				"PUT",
				{ role: "owner" },
			),
			"grant admin explicit team act-as",
		);
		const purgeKey = await connector(daemon, admin.credential, admin.deviceId, purgedAgent.agentId);
		await captureThread(
			daemon,
			{ agentId: purgedAgent.agentId, connector: purgeKey.credential, session: admin.credential },
			"purge-proof-thread",
			"agentPurgeEvidenceMarker",
		);
		const transcriptFile = canonicalTranscriptPath(daemon.workspace, "codex");
		expect(await readFile(transcriptFile, "utf8")).toContain("agentPurgeEvidenceMarker");
		await cli(["agent", "remove", purgedAgent.agentId, "--json"]);
		const purged = await cli(["agent", "purge", purgedAgent.agentId, "--confirm", "--wait", "--json"]);
		expect(purged.status).toBe("complete");
		let remainingTranscript = "";
		try {
			remainingTranscript = await readFile(transcriptFile, "utf8");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		expect(remainingTranscript).not.toContain("agentPurgeEvidenceMarker");
		const agentInventory = await cli(["agent", "list", "--json"]);
		expect(agentInventory.agents.some((agent: { id: string }) => agent.id === purgedAgent.agentId)).toBe(false);
		expect((await request(daemon.origin, "/api/agents", purgeKey.credential)).status).toBe(401);
		expect((await cli(["audit", "--action", "agent.purged", "--json"])).events.length).toBe(1);

		const sso = await cli(
			[
				"auth",
				"sso",
				"set",
				"--issuer",
				"https://idp.example",
				"--client-id",
				"isolated-client",
				"--client-secret-stdin",
				"--json",
			],
			text(admin.credential.bearer),
			0,
			"isolated-sso-secret\n",
		);
		expect(sso.oidc.issuer).toBe("https://idp.example");
		expect(JSON.stringify(sso)).not.toContain("isolated-sso-secret");
		const referenced = await cli([
			"auth",
			"sso",
			"set",
			"--issuer",
			"https://idp.example",
			"--client-id",
			"isolated-client",
			"--client-secret-ref",
			sso.oidc.clientSecretRef,
			"--json",
		]);
		expect(referenced.oidc.clientSecretRef).toBe(sso.oidc.clientSecretRef);

		const importPath = join(daemon.root, "cli-import.md");
		await writeFile(importPath, "# CLI source evidence\nCLI import classified marker.");
		const carol = fixture.user("carol");
		const imported = await cli(
			["import", importPath, "--agent", carol.agentId, "--classification", fixture.hrId, "--non-interactive", "--json"],
			text(carol.session.bearer),
		);
		expect(imported.imported).toBe(1);
		expect(imported.files[0].status).toBe("imported");
		const sourceId = imported.files[0].sourceId;
		expect(typeof sourceId).toBe("string");
		expect(
			JSON.stringify((await request(daemon.origin, `/api/sources?agentId=${carol.agentId}`, admin.credential)).body),
		).not.toContain(sourceId);
		expect(
			JSON.stringify((await request(daemon.origin, `/api/sources?agentId=${carol.agentId}`, carol.session)).body),
		).toContain(sourceId);
		const exportedPath = join(daemon.root, "organization-export.ndjson");
		const exported = await cli(["export", "bundle", "--all", "--output", exportedPath, "--json"]);
		expect(exported.exported).toBe(true);
		const exportedText = await readFile(exportedPath, "utf8");
		expect(exportedText).toContain("Operator backfill proof");
		expect(
			(
				await cli(
					["export", "bundle", "--all", "--output", join(daemon.root, "forbidden.ndjson"), "--json"],
					text(fixture.user("alice").session.bearer),
					4,
				)
			).reason,
		).toBe("not_owner");
		expect(
			(await cli(["repair", "queue", "requeue", "--wait", "--json"], text(fixture.user("alice").session.bearer), 4))
				.reason,
		).toBe("permission");
		expect((await cli(["logs", "--json", "--lines", "5"])).redacted).toBe(true);
		expect((await cli(["logs", "--local", "--json"], text(admin.credential.bearer), 1)).error).toBe(
			"JSON log output requires an organization target",
		);
		expect((await cli(["logs", "--follow", "--json"], text(fixture.user("alice").session.bearer), 4)).reason).toBe(
			"permission",
		);
		for (let iteration = 0; iteration < 3; iteration++) {
			const env: NodeJS.ProcessEnv = { ...daemon.env, SIGNET_API_KEY: admin.credential.bearer };
			delete env.SIGNET_DAEMON_ENTRYPOINT;
			const child = Bun.spawn([process.execPath, join(repo, "surfaces/cli/src/cli.ts"), "logs", "--follow", "--json"], {
				env,
				cwd: repo,
				stdout: "pipe",
				stderr: "pipe",
			});
			const errors = new Response(child.stderr).text();
			const reader = child.stdout.getReader();
			const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
			let output = "";
			try {
				while (!output.includes("\n")) {
					const chunk = await reader.read();
					if (chunk.done) throw new Error(`Log stream closed before connection: ${await errors}`);
					output += new TextDecoder().decode(chunk.value);
				}
				expect(JSON.parse(output.split("\n")[0] ?? "").type).toBe("connected");
				child.kill("SIGINT");
				expect(await child.exited, await errors).toBe(0);
				expect(output).not.toContain(text(admin.credential.bearer));
			} finally {
				clearTimeout(deadline);
				if (child.exitCode === null) child.kill("SIGKILL");
				await child.exited;
				await reader.cancel();
				reader.releaseLock();
			}
		}
		expect(
			(await request(daemon.origin, "/api/pipeline/pause", fixture.user("alice").session, "POST", {})).status,
		).toBe(403);
		const scopedOperator = success(
			await request(daemon.origin, "/api/auth/api-keys", admin.credential, "POST", {
				name: "scoped-operator",
				agentId: record(status.identity.agents).defaultWrite,
				permissions: ["admin", "diagnostics"],
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			}),
			"create scoped operator key",
		);
		expect(
			(await request(daemon.origin, "/api/pipeline/pause", { bearer: text(scopedOperator.secret) }, "POST", {})).status,
		).toBe(403);
		const paused = success(
			await request(daemon.origin, "/api/pipeline/pause", admin.credential, "POST", {}),
			"pause organization workers",
		);
		expect(paused.paused).toBe(true);
		const pauseAudit = success(
			await request(daemon.origin, "/api/org/audit?action=operator.pipeline_paused", admin.credential),
			"read pause audit",
		);
		expect(Array.isArray(pauseAudit.events) && pauseAudit.events.length > 0).toBe(true);
		await daemon.restart();
		expect(
			success(await request(daemon.origin, "/api/pipeline/pause", admin.credential, "POST", {}), "verify durable pause")
				.changed,
		).toBe(false);
		expect((await cli(["resume", "--json"])).paused).toBe(false);
		expect((await cli(["daemon", "pause", "--json"])).paused).toBe(true);
		expect((await cli(["daemon", "resume", "--json"])).paused).toBe(false);
		const browserKey = success(
			await request(daemon.origin, "/api/auth/api-keys", admin.credential, "POST", {
				name: "browser-ceiling-proof",
				permissions: ["recall"],
				expiresAt: new Date(Date.now() + 300_000).toISOString(),
			}),
			"create browser key",
		);
		const exchanged = await request(
			daemon.origin,
			"/api/auth/session",
			{ bearer: text(browserKey.secret) },
			"POST",
			{},
		);
		const exchangedBody = success(exchanged, "exchange browser key");
		expect(exchangedBody).not.toHaveProperty("accessToken");
		const keyBrowser = browser(exchanged);
		const keyIdentity = success(await request(daemon.origin, "/api/auth/whoami", keyBrowser), "key browser identity");
		expect(keyIdentity.permissions).toEqual(["recall"]);
		success(
			await request(daemon.origin, `/api/auth/api-keys/${text(record(browserKey.key).id)}`, admin.credential, "DELETE"),
			"revoke browser parent",
		);
		expect((await request(daemon.origin, "/api/agents", keyBrowser)).status).toBe(401);
		const definition = await cli(
			["classification", "create", "CLI-private", "--audience", `group:${fixture.hrGroupId}`, "--json"],
			fixture.user("cora").session.bearer,
		);
		expect(definition.id).toStartWith("cls_");
		const invite = await cli(["org", "users", "invite", "--email", "cli-member@example.com", "--json"]);
		const accepted = await request(daemon.origin, "/api/auth/invites/accept", {}, "POST", {
			token: new URL(invite.inviteUrl).pathname.split("/").pop(),
			username: "cli-member",
			displayName: "CLI member",
			password: "isolated test password",
		});
		const member = success(accepted, "accept CLI invitation");
		const memberId = text(record(member.user).id);
		const memberDevice = await device(daemon, browser(accepted), "cli-member");
		const connected = await cli(["connect", "codex", "--url", daemon.origin, "--json"], memberDevice.credential.bearer);
		expect(JSON.stringify(connected)).not.toContain("sig_sk_");
		const identity = success(
			await request(daemon.origin, "/api/auth/whoami", memberDevice.credential),
			"member identity",
		);
		const agentId = text(record(identity.agents).defaultWrite);
		const memory = success(
			await request(daemon.origin, "/api/memory/remember", memberDevice.credential, "POST", {
				content: "CLI org admin fixture evidence",
				agentId,
			}),
			"remember member evidence",
		);
		expect(memory).toBeTruthy();
		const classified = await cli(
			["classify", `agent:${agentId}`, "--agent", agentId, "--as", fixture.hrId, "--wait", "--json"],
			fixture.user("cora").session.bearer,
		);
		expect(classified.job.status).toBe("complete");
		const access = await cli(["org", "access", memberId, "--json"]);
		expect(access.actAs.some((entry: { agentId: string }) => entry.agentId === agentId)).toBe(true);
		const plan = await cli(["org", "users", "deactivate", memberId, "--json"]);
		expect(plan.plan.counts.keys).toBe(0);
		expect(plan.plan.counts.memories).toBe(0);
		expect(plan.plan.counts.sessions).toBeGreaterThan(0);
		const offboard = await cli(["org", "users", "deactivate", memberId, "--confirm", "--wait", "--json"]);
		expect(offboard.status).toBe("complete");
		const denied = await request(daemon.origin, "/api/agents", memberDevice.credential);
		expect(denied.status).toBe(401);
		const audit = await cli(["audit", "--action", "user.deactivated", "--json"]);
		expect(audit.events.some((event: { target_id: string }) => event.target_id === memberId)).toBe(true);
	} finally {
		await daemon.dispose();
	}
}, 120_000);
