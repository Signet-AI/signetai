import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deriveClaim, dreamOperation } from "./graph";
import type { OrgDaemon } from "./daemon";
import { browser, id, record, request, success, text, until, type Credential } from "./http";

export interface User {
	id: string;
	name: string;
	agentId: string;
	browser: Credential;
	session: Credential;
	deviceId: string;
	sessionId: string;
	refreshToken: string;
	connector: Credential;
	keyId: string;
	keyPrefix: string;
}
export const hrMarker = "atlasHRquokka";
export const publicMarker = "atlasPublicquokka";
export const rankingQuery = "atlas rankprobe";
export async function device(daemon: OrgDaemon, credential: Credential, name: string) {
	const start = success(
		await request(daemon.origin, "/api/auth/device/start", {}, "POST", {
			client: "cli",
			deviceName: `${name}-acceptance`,
			platform: "linux",
		}),
		"POST /api/auth/device/start",
	);
	success(
		await request(daemon.origin, "/api/auth/device/approve", credential, "POST", {
			userCode: text(start.userCode),
			decision: "approve",
		}),
		"POST /api/auth/device/approve",
	);
	const token = success(
		await request(daemon.origin, "/api/auth/device/token", {}, "POST", { deviceCode: text(start.deviceCode) }),
		"POST /api/auth/device/token",
	);
	return {
		credential: { bearer: text(token.accessToken) },
		deviceId: text(token.deviceId),
		sessionId: text(token.sessionId),
		refreshToken: text(token.refreshToken),
	};
}
export async function connector(
	daemon: OrgDaemon,
	session: Credential,
	deviceId: string,
	agentId: string,
	harness = "codex",
) {
	const result = success(
		await request(daemon.origin, "/api/auth/connector-keys", session, "POST", { harness, deviceId, agentId }),
		"POST /api/auth/connector-keys",
	);
	return { credential: { bearer: text(result.secret) }, id: id(result.key), prefix: text(record(result.key).prefix) };
}
export async function captureThread(
	daemon: OrgDaemon,
	user: Pick<User, "agentId" | "connector" | "session">,
	sessionKey: string,
	content: string,
): Promise<void> {
	const body = { harness: "codex", sessionKey, agentId: user.agentId, project: "atlas" };
	for (const [event, extra] of [
		["session-start", {}],
		["user-prompt-submit", { userMessage: content }],
		[
			"session-end",
			{
				reason: "session_shutdown",
				transcript: `User: ${content}\nAssistant: Recorded.`,
				lastAssistantMessage: "Recorded.",
			},
		],
	] as const) {
		success(
			await request(daemon.origin, `/api/hooks/${event}`, user.connector, "POST", { ...body, ...extra }),
			`POST /api/hooks/${event}`,
		);
	}
	await until(async () => {
		const transcript = await request(
			daemon.origin,
			`/api/sessions/${encodeURIComponent(sessionKey)}/transcript?agent_id=${user.agentId}`,
			user.session,
		);
		return (
			transcript.status === 200 &&
			typeof record(transcript.body).completedAt === "string" &&
			JSON.stringify(transcript.body).includes(content)
		);
	}, "GET /api/sessions/:key/transcript fixture capture");
}

export class Fixture {
	readonly users = new Map<string, User>();
	admin: Credential = {};
	hrId = "";
	engId = "";
	hrGroupId = "";
	engAgent = "";
	hrMemory = "";
	hrEntity = "";
	hrRelatedEntity = "";
	hrAspect = "";
	hrAttribute = "";
	hrSource = "";
	hrDocument = "org-hr-document";
	hrPass = "org-hr-pass";
	publicMemory = "";
	readonly publicRankingMemories: string[] = [];
	readonly hiddenRankingMemories: string[] = [];
	readonly hiddenMemoryIds = new Set<string>();
	hrSession = "org-hr-thread";
	extraSession = "org-extra-thread";
	private constructor(
		readonly daemon: OrgDaemon,
		readonly model: "personal" | "single",
	) {}
	static async create(
		daemon: OrgDaemon,
		model: "personal" | "single" = "personal",
		seedEvidence = true,
	): Promise<Fixture> {
		const fixture = new Fixture(daemon, model);
		await fixture.setup(seedEvidence);
		return fixture;
	}
	user(name: string): User {
		const user = this.users.get(name);
		assert(user, `Missing fixture user ${name}`);
		return user;
	}
	static async createIdentity(daemon: OrgDaemon): Promise<Fixture> {
		const fixture = new Fixture(daemon, "personal");
		await fixture.setupIdentity();
		return fixture;
	}
	async setupIdentity(): Promise<void> {
		const claim = await request(this.daemon.origin, "/api/org/claim", {}, "POST", {
			setupToken: await this.daemon.setupToken(),
			organizationName: "Org acceptance",
			admin: { username: "admin", displayName: "Admin", password: randomBytes(24).toString("base64url") },
		});
		success(claim, "POST /api/org/claim");
		this.admin = browser(claim);
		if (this.model === "single")
			success(
				await request(this.daemon.origin, "/api/org/settings", this.admin, "PATCH", { agentModel: "single" }),
				"PATCH /api/org/settings",
			);
		this.engId = id(
			success(
				await request(this.daemon.origin, "/api/org/groups", this.admin, "POST", { name: "eng" }),
				"POST /api/org/groups",
			),
		);
		this.hrGroupId = id(
			success(
				await request(this.daemon.origin, "/api/org/groups", this.admin, "POST", { name: "hr" }),
				"POST /api/org/groups",
			),
		);
		for (const name of ["alice", "bob", "carol", "cora"])
			await this.invite(
				name,
				name === "carol" ? [this.hrGroupId] : name === "alice" || name === "bob" ? [this.engId] : [],
				"member",
				name === "cora",
			);
		await this.invite("audra", [this.hrGroupId], "admin");
	}
	async setup(seedEvidence = true): Promise<void> {
		await this.setupIdentity();
		this.engAgent = text(
			success(
				await request(this.daemon.origin, "/api/agents", this.admin, "POST", {
					name: "eng-agent",
					kind: "team",
					ownerGroupId: this.engId,
				}),
				"POST /api/agents team",
			).agentId,
		);
		const inventory = success(
			await request(this.daemon.origin, "/api/agents", this.admin),
			"GET /api/agents fixture verification",
		);
		assert(Array.isArray(inventory.agents), "GET /api/agents must return the agent inventory");
		const agents = inventory.agents.map(record);
		assert.equal(
			agents.find((agent) => agent.id === "default")?.kind,
			"organization",
			"Claim must convert default into the organization agent",
		);
		assert.equal(
			agents.find((agent) => agent.id === this.engAgent)?.ownerGroupId,
			this.engId,
			"Engineering agent must be group-owned",
		);
		if (this.model === "personal") {
			assert.equal(
				new Set(["alice", "bob", "carol"].map((name) => this.user(name).agentId)).size,
				3,
				"Multi-agent fixture must have three distinct personal stores",
			);
			for (const name of ["alice", "bob", "carol"]) {
				const user = this.user(name);
				const agent = agents.find((candidate) => candidate.id === user.agentId);
				assert(agent, "Personal store is missing from GET /api/agents");
				assert.equal(agent.kind, "personal", "Fixture default write agent must actually be personal");
				assert.equal(agent.ownerUserId, user.id, "Personal store must be owned by the corresponding credential user");
			}
		}
		const classification = success(
			await request(this.daemon.origin, "/api/classifications", this.user("cora").session, "POST", {
				name: "HR",
				audience: [{ kind: "group", id: this.hrGroupId }],
			}),
			"POST /api/classifications",
		);
		this.hrId = id(classification);
		if (!seedEvidence) return;
		for (const name of ["alice", "bob", "carol"])
			await this.remember(
				this.user(name),
				`${publicMarker} Project atlas ${name} owns ${name === "alice" ? "API" : name === "bob" ? "storage" : "release"}.`,
			);
		this.publicMemory = await this.remember(
			this.user("alice"),
			`${publicMarker} Project atlas uses PostgreSQL and ships on Friday.`,
		);
		for (let index = 0; index < 12; index++)
			this.publicRankingMemories.push(
				await this.remember(
					this.user("alice"),
					`Project atlas rankprobe atlasrankpublic${index} release planning uses a visible checkpoint.`,
				),
			);
		await deriveClaim(
			this,
			this.user("alice").agentId,
			this.publicRankingMemories[0],
			"Project atlas rankprobe atlasrankpublic0 release planning uses a visible checkpoint.",
			rankingQuery,
		);
		await this.growHiddenRanking();
		await this.thread(
			this.user("carol"),
			this.hrSession,
			`${hrMarker} HR compensation review: confidential retention award is 73000.`,
		);
		await this.classify("session", this.hrSession, this.user("carol").agentId);
		const hrQuote = `${hrMarker} HR confidential compensation review is 73000.`;
		this.hrMemory = await this.remember(this.user("carol"), hrQuote);
		const graph = await deriveClaim(this, this.user("carol").agentId, this.hrMemory, hrQuote, hrMarker);
		this.hrEntity = graph.entityId;
		this.hrAspect = graph.aspectId;
		this.hrAttribute = graph.attributeId;
		this.hiddenMemoryIds.add(graph.memoryId);
		const related = await deriveClaim(this, this.user("carol").agentId, this.hrMemory, hrQuote, `${hrMarker}-related`);
		this.hrRelatedEntity = related.entityId;
		this.hiddenMemoryIds.add(related.memoryId);
		await dreamOperation(
			this,
			this.user("carol").agentId,
			"create_link",
			{
				fromEntityId: this.hrEntity,
				toEntityId: related.entityId,
				linkType: "related_to",
				reason: "Both claims concern the same HR compensation review.",
			},
			[{ source_ref: `memory:${this.hrMemory}`, quote: hrQuote }],
		);
		await this.classify("memory", this.hrMemory, this.user("carol").agentId);
		await this.remember(this.user("alice"), `${hrMarker} Alice-authored HR export control is 73000.`, true);
		await this.seedReadState(0);
		await this.classify("source", this.hrSource, this.user("carol").agentId);
	}
	async invite(
		name: string,
		groupIds: string[] = [],
		role: "member" | "admin" = "member",
		compliance = false,
	): Promise<User> {
		const invited = success(
			await request(this.daemon.origin, "/api/org/invites", this.admin, "POST", { role, groupIds }),
			"POST /api/org/invites",
		);
		const url = new URL(text(invited.inviteUrl), this.daemon.origin);
		const token = url.searchParams.get("token") ?? url.pathname.split("/").filter(Boolean).at(-1);
		assert(token, "Invite URL contains no token");
		const accepted = await request(this.daemon.origin, "/api/auth/invites/accept", {}, "POST", {
			token,
			username: name,
			displayName: name,
			password: randomBytes(24).toString("base64url"),
		});
		success(accepted, "POST /api/auth/invites/accept");
		const web = browser(accepted);
		if (compliance)
			success(
				await request(this.daemon.origin, `/api/org/users/${id(record(accepted.body).user)}`, this.admin, "PATCH", {
					compliance: true,
				}),
				"Set compliance before approving the device",
			);
		const who = success(await request(this.daemon.origin, "/api/auth/whoami", web), "GET /api/auth/whoami");
		assert.equal(record(who.user).role, role, "Invite must preserve the requested organization role");
		const dev = await device(this.daemon, web, name);
		const agentId = text(record(who.agents).defaultWrite);
		assert.equal(
			record(who.agents).defaultRead,
			"default",
			"Fixture users must read through the organization agent by default",
		);
		assert(
			this.model === "single" ? agentId === "default" : agentId !== "default",
			"Fixture default write agent does not match organization.agentModel",
		);
		const groups = record(who.user).groups;
		assert(Array.isArray(groups), "GET /api/auth/whoami must report group membership");
		for (const groupId of groupIds)
			assert(
				groups.some((group) => id(group) === groupId),
				"Invite group binding did not survive acceptance",
			);
		if (name === "carol")
			assert.equal(record(who.user).compliance, false, "Carol must be an ordinary HR audience member, not compliance");
		const key = await connector(this.daemon, dev.credential, dev.deviceId, agentId);
		const user = {
			id: id(who.user),
			name,
			agentId,
			browser: web,
			session: dev.credential,
			deviceId: dev.deviceId,
			sessionId: dev.sessionId,
			refreshToken: dev.refreshToken,
			connector: key.credential,
			keyId: key.id,
			keyPrefix: key.prefix,
		};
		this.users.set(name, user);
		return user;
	}
	async remember(user: User, content: string, hidden = false): Promise<string> {
		const result = success(
			await request(this.daemon.origin, "/api/memory/remember", user.connector, "POST", {
				content,
				project: "atlas",
				agentId: user.agentId,
				type: "fact",
				visibility: "private",
				importance: 0.9,
			}),
			"POST /api/memory/remember",
		);
		const memoryId = typeof result.id === "string" ? result.id : id(result.memory);
		const persisted = success(
			await request(
				this.daemon.origin,
				`/api/memory/${memoryId}?agentId=${encodeURIComponent(user.agentId)}`,
				user.session,
			),
			"GET /api/memory/:id fixture readback",
		);
		assert(JSON.stringify(persisted).includes(content), "Remember did not durably preserve fixture content");
		assert(
			JSON.stringify(
				success(
					await request(this.daemon.origin, "/api/dream/tools/search_evidence", user.session, "POST", {
						agentId: user.agentId,
						input: { agentId: user.agentId, sourceRef: `memory:${memoryId}` },
					}),
					"Dreaming evidence attribution readback",
				),
			).includes(user.id),
			"Remember did not attribute fixture content to credential user",
		);
		if (hidden) await this.classify("memory", memoryId, user.agentId);
		return memoryId;
	}
	async thread(user: User, sessionKey: string, content: string): Promise<void> {
		await captureThread(this.daemon, user, sessionKey, content);
	}
	async classify(kind: "memory" | "session" | "source" | "agent", targetId: string, agentId: string): Promise<void> {
		const endpoint = `/api/classifications/${this.hrId}/apply?wait=1`;
		const result = success(
			await request(this.daemon.origin, endpoint, this.user("cora").session, "POST", {
				target: { kind, id: targetId, agentId },
			}),
			`POST ${endpoint}`,
		);
		if (result.jobId) await this.waitJob(text(result.jobId));
		if (kind === "memory") this.hiddenMemoryIds.add(targetId);
	}
	async waitJob(jobId: string): Promise<void> {
		await until(
			async () => {
				const job = success(
					await request(this.daemon.origin, `/api/org/jobs/${jobId}`, this.admin),
					"GET /api/org/jobs/:id",
				);
				assert(!["failed", "cancelled"].includes(text(job.status)), `Organization job ${jobId} failed`);
				return job.status === "complete";
			},
			"classification/offboard durable job completion",
			120_000,
		);
	}
	async seedReadState(generation: number): Promise<void> {
		const inputPath = join(this.daemon.root, "derived-fixture.json");
		await writeFile(
			inputPath,
			JSON.stringify({
				workspace: this.daemon.workspace,
				root: this.daemon.root,
				agentId: this.user("carol").agentId,
				userId: this.user("carol").id,
				entityId: this.hrEntity,
				attributeId: this.hrAttribute,
				memoryId: this.hrMemory,
				publicMemoryIds: [this.publicMemory, ...this.publicRankingMemories.slice(0, 3)],
				hiddenMemoryIds: [this.hrMemory, ...this.hiddenRankingMemories],
				sessionKey: this.hrSession,
				marker: hrMarker,
				generation,
			}),
		);
		await this.daemon.stop();
		try {
			const child = Bun.spawn([process.execPath, join(import.meta.dir, "derived-seed.ts"), inputPath], {
				env: this.daemon.env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			assert.equal(await child.exited, 0, `Offline derived-read fixture seed failed: ${stderr}`);
			this.hrSource = text(record(JSON.parse(stdout)).sourceId);
		} finally {
			await this.daemon.start();
		}
		success(
			await request(this.daemon.origin, "/api/hooks/session-start", this.user("carol").connector, "POST", {
				harness: "codex",
				sessionKey: this.hrSession,
				agentId: this.user("carol").agentId,
				project: "atlas",
			}),
			"Restore HR session presence after offline seed",
		);
	}
	async growHiddenRanking(): Promise<void> {
		for (let index = 0; index < 24; index++) {
			const memory = await this.remember(
				this.user("carol"),
				`Project atlas rankprobe ${hrMarker} hidden ranking finding ${this.hiddenRankingMemories.length} is 73000.`,
				true,
			);
			this.hiddenRankingMemories.push(memory);
		}
	}
	async perturbHidden(): Promise<void> {
		await this.growHiddenRanking();
		const quote = `${hrMarker} second hidden HR finding: atlas retention award revised to 74000.`;
		const memory = await this.remember(this.user("carol"), quote);
		const growth = await deriveClaim(this, this.user("carol").agentId, memory, quote, `${hrMarker}-growth`);
		this.hiddenMemoryIds.add(growth.memoryId);
		await this.classify("memory", memory, this.user("carol").agentId);
		await this.thread(
			this.user("carol"),
			this.hrSession,
			`${hrMarker} HR transcript growth: confidential award revised to 74000.`,
		);
		await this.thread(
			this.user("carol"),
			this.extraSession,
			`${hrMarker} newly ingested HR session for reclassification.`,
		);
		await this.classify("session", this.extraSession, this.user("carol").agentId);
		await this.remember(this.user("alice"), `${hrMarker} Alice-authored hidden export growth is 74000.`, true);
		await this.seedReadState(1);
	}
}
