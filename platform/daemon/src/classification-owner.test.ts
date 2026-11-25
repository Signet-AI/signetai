import { compartmentFor } from "@signet/core";
import { executeClassificationJob, resumeClassificationJobs } from "./classifications";
import { classificationFixture as legacyClassificationFixture } from "./test-support/classification-fixture.test";
import { expect, test } from "bun:test";
import { purgeMemoryInTx } from "./source-purge-tx";
import { executeClassification } from "./classification-owner";
import { up as dreamingPartitionMigration } from "../../core/src/migrations/179-dreaming-evidence-leases";
import type { ClassificationActor } from "./classifications";
import { enqueueDreamingAttentionInTx } from "./pipeline/dreaming-attention";

function classificationFixture() {
	const db = legacyClassificationFixture();
	dreamingPartitionMigration(db);
	return db;
}

const compliance: ClassificationActor = {
	userId: "carol",
	groupIds: [],
	local: false,
	compliance: true,
	boundAgentId: null,
	allowedProjects: null,
	credential: "session:test",
};
const alice: ClassificationActor = {
	userId: "alice",
	groupIds: [],
	local: false,
	compliance: false,
	boundAgentId: null,
	allowedProjects: null,
	credential: "session:alice",
};
const bob: ClassificationActor = { ...alice, userId: "bob" };
test("classification and rebuild never relabel structural person identities", () => {
	const db = classificationFixture();
	try {
		db.exec("UPDATE agents SET kind='organization' WHERE id='default'; UPDATE organization SET agent_model='single'");
		dreamingPartitionMigration(db);
		const before = db.prepare("SELECT * FROM entities WHERE person_user_id IS NOT NULL ORDER BY id").all();
		expect(before).toHaveLength(3);
		const created = executeClassification(db, {
			op: "create",
			actor: compliance,
			name: "Private",
			color: null,
			description: null,
			audience: [{ kind: "user", id: "alice" }],
			appliers: [],
		});
		if (typeof created !== "object" || created === null || !("id" in created) || typeof created.id !== "string")
			throw new Error("Classification fixture failed");
		const queued = executeClassification(db, {
			op: "enqueue",
			actor: compliance,
			id: created.id,
			target: { kind: "agent", id: "default", agentId: "default" },
			remove: false,
		});
		if (typeof queued !== "object" || queued === null || !("jobId" in queued) || typeof queued.jobId !== "string")
			throw new Error("Job fixture failed");
		executeClassification(db, { op: "execute", jobId: queued.jobId });
		executeClassification(db, { op: "rebuild", agentId: "default" });
		expect(db.prepare("SELECT * FROM entities WHERE person_user_id IS NOT NULL ORDER BY id").all()).toEqual(before);
		expect(db.prepare("SELECT compartment_id FROM memories WHERE id='m'").get()?.compartment_id).toBeNumber();
	} finally {
		db.close();
	}
});

const target = { kind: "memory", id: "m", agentId: "default" } as const;
test("rebuild preserves the pass label when an entity cites only public evidence", () => {
	const db = classificationFixture();
	try {
		dreamingPartitionMigration(db);
		db.exec(`INSERT INTO classifications(id,name) VALUES('cls_secret','Secret');
			INSERT INTO compartments(id,key) VALUES(4,'cls_secret');
			INSERT INTO compartment_members VALUES(4,'cls_secret');
			INSERT INTO dreaming_passes(id,agent_id,status,compartment_id) VALUES('pass-labeled','default','completed',4);
			INSERT INTO ontology_proposals(id,agent_id,operation,payload,evidence,created_by,created_at,updated_at,compartment_id,dreaming_pass_id)
			VALUES('proposal-labeled','default','create_entity','{}','[]','dreaming','now','now',4,'pass-labeled');
			UPDATE entities SET proposal_id='proposal-labeled',compartment_id=4 WHERE id='e';`);
		executeClassification(db, { op: "rebuild", agentId: "default" });
		expect(db.prepare("SELECT compartment_id FROM entities WHERE id='e'").get()).toEqual({ compartment_id: 4 });
	} finally {
		db.close();
	}
});

test("owners apply, only compliance removes, hidden definitions are absent and fanout is atomic", () => {
	const db = classificationFixture();
	dreamingPartitionMigration(db);
	const attentionId = enqueueDreamingAttentionInTx(db, {
		agentId: "default",
		kind: "evidence_requeue",
		subjectRef: "memory:m",
		details: { summary: "private secret" },
	});
	const created = executeClassification(db, {
		op: "create",
		actor: compliance,
		name: "HR",
		color: null,
		description: null,
		audience: [{ kind: "user", id: "alice" }],
		appliers: [],
	});
	const id =
		typeof created === "object" && created !== null && "id" in created && typeof created.id === "string"
			? created.id
			: "";
	expect(id.startsWith("cls_")).toBe(true);
	expect(executeClassification(db, { op: "list", actor: bob })).toEqual([]);
	expect(() => executeClassification(db, { op: "get", actor: bob, id })).toThrow("not_found");
	expect(() => executeClassification(db, { op: "get", actor: bob, id: "cls_missing" })).toThrow("not_found");
	const enqueue = executeClassification(db, { op: "enqueue", actor: alice, id, target, remove: false });
	const jobId =
		typeof enqueue === "object" && enqueue !== null && "jobId" in enqueue && typeof enqueue.jobId === "string"
			? enqueue.jobId
			: "";
	executeClassification(db, { op: "execute", jobId });
	const m = db.prepare("SELECT compartment_id FROM memories WHERE id=?").get("m");
	expect(m?.compartment_id).toBeNumber();
	expect(db.prepare("SELECT compartment_id FROM entities WHERE id=?").get("e")).toEqual(m);
	expect(db.prepare("SELECT compartment_id FROM dreaming_attention WHERE id=?").get(attentionId)).toEqual(m);
	expect(executeClassification(db, { op: "readable", subject: alice })).toEqual([m?.compartment_id]);
	expect(executeClassification(db, { op: "readable", subject: compliance })).toEqual([]);
	expect(() => executeClassification(db, { op: "enqueue", actor: alice, id, target, remove: true })).toThrow(
		"permission",
	);
	const remove = executeClassification(db, { op: "enqueue", actor: compliance, id, target, remove: true });
	const removeId =
		typeof remove === "object" && remove !== null && "jobId" in remove && typeof remove.jobId === "string"
			? remove.jobId
			: "";
	executeClassification(db, { op: "execute", jobId: removeId });
	expect(db.prepare("SELECT compartment_id FROM memories WHERE id=?").get("m")).toEqual({ compartment_id: null });
	expect(db.prepare("SELECT compartment_id FROM entities WHERE id=?").get("e")).toEqual({ compartment_id: null });
	expect(
		db
			.prepare(
				"SELECT count(*) n FROM audit_events WHERE action='classification.apply' OR action='classification.remove'",
			)
			.get(),
	).toEqual({ n: 2 });
	db.close();
});

function field(value: unknown, name: string): string {
	if (typeof value === "object" && value !== null && name in value) {
		const result = Reflect.get(value, name);
		if (typeof result === "string") return result;
	}
	throw new Error("missing field");
}
function classification(db: ReturnType<typeof classificationFixture>): string {
	return field(
		executeClassification(db, {
			op: "create",
			actor: compliance,
			name: "HR",
			color: null,
			description: null,
			audience: [{ kind: "user", id: "alice" }],
			appliers: [],
		}),
		"id",
	);
}
test("audit failure rolls back assignments, derived rows and FTS and leaves a failed durable job", () => {
	const db = classificationFixture(),
		id = classification(db);
	const jobId = field(executeClassification(db, { op: "enqueue", actor: alice, id, target, remove: false }), "jobId");
	db.exec(
		"CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events WHEN new.action='classification.apply' BEGIN SELECT RAISE(ABORT,'crash'); END",
	);
	expect(() => executeClassification(db, { op: "execute", jobId })).toThrow("crash");
	expect(db.prepare("SELECT count(*) n FROM classification_assignments").get()).toEqual({ n: 0 });
	expect(db.prepare("SELECT compartment_id FROM memories WHERE id=?").get("m")).toEqual({ compartment_id: null });
	expect(db.prepare("SELECT compartment_id FROM entities WHERE id=?").get("e")).toEqual({ compartment_id: null });
	expect(db.prepare("SELECT count(*) n FROM memories_fts WHERE memories_fts MATCH 'secret'").get()).toEqual({ n: 1 });
	expect(db.prepare("SELECT status FROM org_jobs WHERE id=?").get(jobId)).toEqual({ status: "failed" });
	db.close();
});
test("audience intersection and group revocation are effective on the next owner read", () => {
	const db = classificationFixture(),
		first = classification(db);
	db.exec(
		"INSERT INTO groups(id,name) VALUES('hr','HR'); INSERT INTO group_members(group_id,user_id,role) VALUES('hr','bob','member')",
	);
	executeClassification(db, {
		op: "audience",
		id: first,
		actor: compliance,
		principals: [{ kind: "group", id: "hr" }],
	});
	const jobId = field(
		executeClassification(db, { op: "enqueue", actor: compliance, id: first, target, remove: false }),
		"jobId",
	);
	executeClassification(db, { op: "execute", jobId });
	expect(executeClassification(db, { op: "readable", subject: bob })).toHaveLength(1);
	db.exec("DELETE FROM group_members WHERE group_id='hr' AND user_id='bob'");
	expect(executeClassification(db, { op: "readable", subject: bob })).toEqual([]);
	expect(executeClassification(db, { op: "readable", subject: compliance })).toEqual([]);
	const second = field(
		executeClassification(db, {
			op: "create",
			actor: compliance,
			name: "Legal",
			color: null,
			description: null,
			audience: [{ kind: "user", id: "bob" }],
			appliers: [],
		}),
		"id",
	);
	const job2 = field(
		executeClassification(db, { op: "enqueue", actor: compliance, id: second, target, remove: false }),
		"jobId",
	);
	executeClassification(db, { op: "execute", jobId: job2 });
	expect(executeClassification(db, { op: "readable", subject: bob })).toHaveLength(0);
	const current = db.prepare("SELECT compartment_id FROM memories WHERE id=?").get("m");
	expect(executeClassification(db, { op: "readable", subject: bob })).not.toContain(current?.compartment_id);
	db.close();
});
test("session and managed source fan out once and rebuild repairs tampered derived labels", () => {
	const db = classificationFixture(),
		id = classification(db);
	db.exec(
		"INSERT INTO session_transcripts(session_key,content,agent_id,created_at,source_id) VALUES('s','transcript','default','now','src'); INSERT INTO memory_artifacts(agent_id,source_path,source_sha256,source_kind,session_id,session_key,session_token,captured_at,updated_at,source_id,content) VALUES('default','notes/x','sha','source','s','s','token','now','now','src','artifact'); UPDATE memories SET source_type='transcript',source_id='s' WHERE id='m'; INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,created_at,updated_at) VALUES('second','Second','second','concept','default','now','now'); INSERT INTO evidence_citations VALUES('entity','second','default','artifact','notes/x');",
	);
	const sourceTarget = { kind: "source", id: "src", agentId: "default" } as const;
	const job = field(
		executeClassification(db, { op: "enqueue", actor: compliance, id, target: sourceTarget, remove: false }),
		"jobId",
	);
	executeClassification(db, { op: "execute", jobId: job });
	const c = db.prepare("SELECT compartment_id FROM memories WHERE id=?").get("m");
	expect(c?.compartment_id).toBeNumber();
	expect(db.prepare("SELECT compartment_id FROM entities WHERE id='second'").get()).toEqual(c);
	db.exec("UPDATE entities SET compartment_id=NULL WHERE id='second'");
	executeClassification(db, { op: "rebuild", agentId: "default" });
	expect(db.prepare("SELECT compartment_id FROM entities WHERE id='second'").get()).toEqual(c);
	executeClassification(db, { op: "recover" });
	expect(db.prepare("SELECT count(*) n FROM org_jobs WHERE status='running'").get()).toEqual({ n: 0 });
	db.close();
});

test("direct attributes, their materialized memories, hints and vectors move without transitive fanout", () => {
	const db = classificationFixture(),
		id = classification(db);
	db.exec(`INSERT INTO memories(id,content,agent_id,memory_kind,created_at,updated_at) VALUES('derived','claim','default','derived','now','now');
 INSERT INTO entity_aspects(id,entity_id,agent_id,name,canonical_name) VALUES('aspect','e','default','Aspect','aspect');
 INSERT INTO entity_attributes(id,aspect_id,agent_id,memory_id,kind,content,normalized_content) VALUES('attr','aspect','default','derived','fact','claim','claim');
 INSERT INTO evidence_citations VALUES('attribute','attr','default','memory','m');
 INSERT INTO memory_hints(id,memory_id,agent_id,hint) VALUES('hint','derived','default','claim');
 INSERT INTO embeddings(id,content_hash,source_type,source_id,vector,dimensions,chunk_text,created_at,agent_id) VALUES('emb','derived-hash','memory','derived',X'0000803f0000000000000000',3,'claim','now','default');
 INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,created_at,updated_at) VALUES('second','Second','second','concept','default','now','now');
 INSERT INTO evidence_citations VALUES('entity','second','default','memory','derived');`);
	const jobId = field(
		executeClassification(db, { op: "enqueue", actor: compliance, id, target, remove: false }),
		"jobId",
	);
	executeClassification(db, { op: "execute", jobId });
	const expected = db.prepare("SELECT compartment_id FROM memories WHERE id='m'").get();
	for (const [table, key] of [
		["entity_attributes", "attr"],
		["memories", "derived"],
		["memory_hints", "hint"],
		["embeddings", "emb"],
	])
		expect({ table, row: db.prepare(`SELECT compartment_id FROM ${table} WHERE id=?`).get(key) }).toEqual({
			table,
			row: expected,
		});
	expect(db.prepare("SELECT count(*) n FROM memory_hints_fts WHERE memory_hints_fts MATCH 'claim'").get()).toEqual({
		n: 0,
	});
	expect(db.prepare("SELECT count(*) n FROM entities_fts WHERE entities_fts MATCH 'E'").get()).toEqual({ n: 0 });
	expect(db.prepare("SELECT compartment_id FROM entities WHERE id='second'").get()).toEqual({ compartment_id: null });
	expect(
		executeClassification(db, {
			op: "preview",
			actor: compliance,
			id,
			target,
			scope: { reach: { kind: "all" }, projects: null, compartments: [] },
		}),
	).toEqual({ evidence: 0, derived: 0 });
	db.close();
});

test("an execution admission failure preserves a pending job for startup resumption", async () => {
	const db = classificationFixture(),
		id = classification(db);
	const jobId = field(
		executeClassification(db, { op: "enqueue", actor: compliance, id, target, remove: false }),
		"jobId",
	);
	await expect(
		executeClassificationJob(jobId, async (request) => {
			if (request.op === "execute") throw new Error("owner_admission_failed");
			return executeClassification(db, request);
		}),
	).rejects.toThrow("owner_admission_failed");
	expect(db.prepare("SELECT status,error FROM org_jobs WHERE id=?").get(jobId)).toEqual({
		status: "pending",
		error: "owner_admission_failed",
	});
	expect(db.prepare("SELECT count(*) n FROM classification_assignments").get()).toEqual({ n: 0 });
	await resumeClassificationJobs(async (request) => executeClassification(db, request));
	expect(db.prepare("SELECT status,error FROM org_jobs WHERE id=?").get(jobId)).toEqual({
		status: "complete",
		error: null,
	});
	db.close();
});

test("classification authority never overrides credential agent or project bindings", () => {
	const db = classificationFixture(),
		id = classification(db);
	expect(() =>
		executeClassification(db, {
			op: "enqueue",
			actor: { ...compliance, boundAgentId: "other" },
			id,
			target,
			remove: false,
		}),
	).toThrow("agent_binding_conflict");
	expect(() =>
		executeClassification(db, {
			op: "enqueue",
			actor: { ...compliance, allowedProjects: ["atlas"] },
			id,
			target,
			remove: false,
		}),
	).toThrow("project_not_permitted");
	db.exec("UPDATE memories SET project='atlas' WHERE id='m'");
	executeClassification(db, { op: "appliers", actor: compliance, id, principals: [{ kind: "user", id: "bob" }] });
	expect(() => executeClassification(db, { op: "enqueue", actor: alice, id, target, remove: false })).toThrow(
		"permission",
	);
	const scoped = { ...compliance, boundAgentId: "default", allowedProjects: ["atlas"] };
	const jobId = field(executeClassification(db, { op: "enqueue", actor: scoped, id, target, remove: false }), "jobId");
	executeClassification(db, { op: "execute", jobId });
	expect(
		executeClassification(db, {
			op: "items",
			id,
			actor: { ...compliance, boundAgentId: "other" },
			cursor: null,
			scope: { reach: { kind: "own", agentId: "other" }, projects: null, compartments: [] },
		}),
	).toEqual({ items: [], nextCursor: null });
	db.exec("UPDATE agents SET archived_at='now' WHERE id='default'");
	const removal = field(executeClassification(db, { op: "enqueue", actor: scoped, id, target, remove: true }), "jobId");
	executeClassification(db, { op: "execute", jobId: removal });
	expect(db.prepare("SELECT compartment_id FROM memories WHERE id='m'").get()).toEqual({ compartment_id: null });
	db.close();
});

test("routine user activity leaves the audience generation unchanged", () => {
	const db = classificationFixture();
	const version = () => db.prepare("SELECT version FROM classification_access_version WHERE id=1").get();
	const before = version();
	db.prepare("UPDATE users SET last_active_at='later',display_name='Alice A' WHERE id='alice'").run();
	expect(version()).toEqual(before);
	db.prepare("UPDATE users SET role='admin' WHERE id='alice'").run();
	expect(version()).not.toEqual(before);
	db.close();
});

test("hidden definitions and unreadable targets cannot be distinguished by apply or remove", () => {
	const db = classificationFixture(),
		id = classification(db);
	for (const remove of [false, true])
		expect(() => executeClassification(db, { op: "enqueue", actor: bob, id, target, remove })).toThrow("not_found");
	db.exec("INSERT INTO classifications(id,name) VALUES('cls_other','Other')");
	const c = compartmentFor(db, ["cls_other"]);
	db.prepare("UPDATE memories SET compartment_id=? WHERE id='m'").run(c);
	expect(() => executeClassification(db, { op: "enqueue", actor: alice, id, target, remove: false })).toThrow(
		"not_found",
	);
	db.close();
});
test("preview requires acting authority on the target agent even when its content is readable", () => {
	const db = classificationFixture(),
		id = classification(db);
	db.exec(
		"INSERT INTO agents(id,name,kind,owner_user_id,created_at,updated_at) VALUES('foreign','Foreign','personal','bob','now','now');INSERT INTO memories(id,content,agent_id,author_user_id,created_at,updated_at) VALUES('foreign-memory','readable','foreign','alice','now','now')",
	);
	expect(() =>
		executeClassification(db, {
			op: "preview",
			actor: alice,
			id,
			target: { kind: "memory", id: "foreign-memory", agentId: "foreign" },
			scope: { reach: { kind: "all" }, compartments: [], projects: null },
		}),
	).toThrow("not_found");
	db.close();
});

test("child relabel closure retains independent pass provenance through classify, remove and rebuild", () => {
	const db = classificationFixture();
	try {
		db.exec(`INSERT INTO classifications(id,name) VALUES('cls_child','Child');
			INSERT INTO compartments(id,key) VALUES(44,'cls_child');
			INSERT INTO compartment_members VALUES(44,'cls_child');
			INSERT INTO dreaming_passes(id,agent_id,status,compartment_id) VALUES('child-pass','default','completed',44);
			INSERT INTO memory_entity_mentions(memory_id,entity_id,agent_id,compartment_id,dreaming_pass_id) VALUES('m','e','default',44,'child-pass');
			INSERT INTO memory_history(id,memory_id,event,changed_by,created_at,agent_id,compartment_id,dreaming_pass_id) VALUES('child-event','m','updated','test','now','default',44,'child-pass');
			INSERT INTO derived_memory_sources(derived_memory_id,source_kind,source_id,agent_id,created_at,compartment_id,dreaming_pass_id) VALUES('m','memory','m','default','now',44,'child-pass');
			INSERT INTO relations(id,source_entity_id,target_entity_id,relation_type,created_at,agent_id,compartment_id,dreaming_pass_id) VALUES('child-edge','e','e','uses','now','default',44,'child-pass');`);
		const tables = ["memory_entity_mentions", "memory_history", "derived_memory_sources", "relations"];
		executeClassification(db, { op: "rebuild", agentId: "default" });
		for (const table of tables)
			expect(db.prepare(`SELECT compartment_id FROM ${table}`).all()).toEqual([{ compartment_id: 44 }]);
		const classification = field(
			executeClassification(db, {
				op: "create",
				actor: compliance,
				name: "Root",
				color: null,
				description: null,
				audience: [{ kind: "user", id: "alice" }],
				appliers: [],
			}),
			"id",
		);
		const apply = field(
			executeClassification(db, { op: "enqueue", actor: compliance, id: classification, target, remove: false }),
			"jobId",
		);
		executeClassification(db, { op: "execute", jobId: apply });
		for (const table of tables)
			expect(
				db
					.prepare(
						`SELECT cm.classification_id FROM ${table} child JOIN compartment_members cm ON cm.compartment_id=child.compartment_id ORDER BY cm.classification_id`,
					)
					.all()
					.map((row) => row.classification_id)
					.sort(),
			).toEqual(["cls_child", classification].sort());
		const remove = field(
			executeClassification(db, { op: "enqueue", actor: compliance, id: classification, target, remove: true }),
			"jobId",
		);
		executeClassification(db, { op: "execute", jobId: remove });
		executeClassification(db, { op: "rebuild", agentId: "default" });
		for (const table of tables)
			expect(db.prepare(`SELECT compartment_id FROM ${table}`).all()).toEqual([{ compartment_id: 44 }]);
		purgeMemoryInTx(db, "m");
		for (const table of tables.filter((table) => table !== "relations"))
			expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
		expect(db.prepare("SELECT id FROM relations").all()).toEqual([{ id: "child-edge" }]);
	} finally {
		db.close();
	}
});
