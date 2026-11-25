import { describe, expect, test } from "bun:test";
import {
	bindPrincipalAccess,
	canActAs,
	organizationReadRequest,
	reconcileAgentSources,
	resolveReadAgent,
	resolveWriteAgent,
} from "./agent-access";
import { localPrincipal, type Principal } from "./principal";

const user: Principal = {
	kind: "user",
	userId: "usr_alice",
	role: "member",
	permissions: new Set(["remember", "recall"]),
	compliance: false,
	groupIds: ["grp_eng"],
	credential: { kind: "session", id: "ses_a" },
	sessionId: "ses_a",
	deviceId: null,
	harness: null,
	boundAgentId: null,
	allowedProjects: null,
};
const agents = [
	{ id: "default", kind: "organization", owner_user_id: null, owner_group_id: null, archived_at: null },
	{ id: "alice", kind: "personal", owner_user_id: "usr_alice", owner_group_id: null, archived_at: null },
	{ id: "bob", kind: "personal", owner_user_id: "usr_bob", owner_group_id: null, archived_at: null },
	{ id: "eng", kind: "team", owner_user_id: null, owner_group_id: "grp_eng", archived_at: null },
	{ id: "old", kind: "legacy", owner_user_id: null, owner_group_id: null, archived_at: null },
] as const;
const org = {
	agentModel: "personal",
	personalAgentsSelfService: true,
	organizationAgentId: "default",
	personalAgentId: "alice",
	defaultReadAgentId: null,
	agents,
} as const;

describe("organization act-as boundary", () => {
	test("read-only POST transports resolve read reach without requiring peer write ownership", () => {
		for (const path of [
			"/api/assistant/chat",
			"/api/knowledge/expand",
			"/api/knowledge/expand/session",
			"/api/sessions/summaries/expand",
			...[
				"memory_head_read",
				"search_entities",
				"get_entity",
				"list_aspect_claims",
				"search_evidence",
				"validate_proposal",
				"zoom_history",
				"attention_list",
			].map((id) => `/api/dream/tools/${id}`),
		])
			expect(organizationReadRequest("POST", path)).toBe(true);
		for (const path of [
			"/api/dream/tools/apply_ontology_ops",
			"/api/dream/tools/runbook_write",
			"/api/dream/tools/review_evidence",
			"/api/memory/remember",
		])
			expect(organizationReadRequest("POST", path)).toBe(false);
	});
	test("personal ownership, groups, legacy credentials and archived state are enforced", () => {
		for (const agent of agents) expect(canActAs(user, agent)).toBe(["default", "alice", "eng"].includes(agent.id));
		const legacy = agents[4];
		if (!legacy) throw new Error("fixture missing");
		expect(canActAs({ ...user, role: "admin" }, legacy)).toBe(true);
		expect(canActAs({ ...user, boundAgentId: "old", credential: { kind: "api_key", id: "key_a" } }, legacy)).toBe(true);
		expect(canActAs(user, { ...legacy, archived_at: "now" })).toBe(false);
		expect(canActAs(localPrincipal(), legacy)).toBe(true);
	});
	test("organization writes redirect to personal while reads default to organization", () => {
		bindPrincipalAccess(user, org);
		expect(resolveWriteAgent(user, "default", org)).toEqual({ ok: true, value: "alice" });
		expect(resolveWriteAgent(user, undefined, org)).toEqual({ ok: true, value: "alice" });
		expect(resolveReadAgent(user, undefined)).toEqual({ ok: true, value: "default" });
		expect(resolveWriteAgent(user, "bob", org)).toMatchObject({ ok: false, error: { reason: "agent_not_permitted" } });
	});
	test("binding conflicts are rejected before organization redirect", () => {
		expect(resolveWriteAgent({ ...user, boundAgentId: "alice" }, "default", org)).toMatchObject({
			ok: false,
			error: { reason: "agent_binding_conflict" },
		});
	});
	test("agent input aliases cannot silently override one another", () => {
		expect(reconcileAgentSources(["alice", "bob"])).toMatchObject({
			ok: false,
			error: { status: 400, reason: "agent_conflict" },
		});
		expect(reconcileAgentSources([undefined, "alice", "alice"])).toEqual({ ok: true, value: "alice" });
	});
});
