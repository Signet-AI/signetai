import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin =
	process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];
let port = 38990;

afterEach(() => {
	for (const child of children.splice(0)) child.kill();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(existing?: string) {
	const dir = existing ?? mkdtempSync(join(tmpdir(), "signet-job-contract-"));
	if (!existing) dirs.push(dir);
	const p = port++;
	const child = Bun.spawn([bin], {
		env: { ...process.env, SIGNET_PATH: dir, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: String(p), SIGNET_AGENT_ID: "" },
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	const origin = `http://127.0.0.1:${p}`;
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { origin, dir, child };
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

async function eventValues(response: Response) {
	const line = (await response.text()).split("\n").find((value) => value.startsWith("data: "));
	if (!line) throw new Error("native daemon returned no SSE data event");
	return JSON.parse(line.slice("data: ".length)) as Array<{ cursor: number; event: string }>;
}

const headers = (agent: string, workspace: string) => ({
	"content-type": "application/json",
	"x-signet-agent-id": agent,
	"x-workspace-id": workspace,
});

it("exercises native durable job identity, cursor, cancellation, and recovery contracts", async () => {
	const first = await start();
	const h = headers("agent-a", "workspace-a");
	const jobs: Array<{ id: string; state: string; workspaceId: string }> = [];
	for (let index = 0; index < 3; index++) {
		const created = await fetch(`${first.origin}/api/jobs`, {
			method: "POST",
			headers: h,
			body: JSON.stringify({ kind: "dream.trigger", payload: { index } }),
		});
		expect(created.status).toBe(200);
		jobs.push(await created.json());
	}
	expect(jobs[0].state).toBe("queued");
	expect(jobs[0].workspaceId).toBe("workspace-a");
	expect((await fetch(`${first.origin}/api/memory/jobs/${jobs[0].id}`, { headers: h })).status).toBe(200);
	expect(
		(await fetch(`${first.origin}/api/jobs/${jobs[0].id}`, { headers: headers("agent-a", "workspace-b") })).status,
	).toBe(404);
	const otherAgentList = await fetch(`${first.origin}/api/jobs`, { headers: headers("agent-b", "workspace-a") });
	expect(otherAgentList.status).toBe(200);
	expect((await otherAgentList.json()).items).toHaveLength(0);

	const pageOneResponse = await fetch(`${first.origin}/api/jobs?limit=2`, { headers: h });
	expect(pageOneResponse.status).toBe(200);
	const pageOne = await pageOneResponse.json();
	expect(pageOne.items).toHaveLength(2);
	expect(typeof pageOne.cursor).toBe("string");
	const pageTwoResponse = await fetch(`${first.origin}/api/jobs?limit=2&cursor=${encodeURIComponent(pageOne.cursor)}`, {
		headers: h,
	});
	expect(pageTwoResponse.status).toBe(200);
	const pageTwo = await pageTwoResponse.json();
	expect(pageTwo.items).toHaveLength(1);
	expect(pageOne.items.map((item: { id: string }) => item.id)).not.toContain(pageTwo.items[0].id);
	expect(pageTwo.cursor).toBe(pageTwo.items[0].id);

	const cancelled = await fetch(`${first.origin}/api/jobs/${jobs[0].id}`, {
		method: "DELETE",
		headers: { ...h, "x-actor": "test", "x-reason": "contract" },
	});
	const cancellation = await cancelled.json();
	expect(cancelled.status).toBe(200);
	expect(cancellation.state).toBe("cancelled");
	expect(cancellation.cancellation.actor).toBe("test");
	expect(cancellation.cancellation.reason).toBe("contract");
	const eventsAfterCancel = await fetch(`${first.origin}/api/jobs/${jobs[0].id}/events?cursor=0&limit=10`, {
		headers: h,
	});
	const initialEvents = await eventValues(eventsAfterCancel);
	expect(initialEvents.map((event) => event.event)).toEqual(["queued", "cancelled"]);
	const fromQueued = await fetch(
		`${first.origin}/api/jobs/${jobs[0].id}/events?cursor=${initialEvents[0].cursor}&limit=1`,
		{ headers: h },
	);
	expect((await eventValues(fromQueued)).map((event) => event.event)).toEqual(["cancelled"]);
	const fromCancelled = await fetch(
		`${first.origin}/api/jobs/${jobs[0].id}/events?cursor=${initialEvents[1].cursor}&limit=10`,
		{ headers: h },
	);
	expect(await eventValues(fromCancelled)).toHaveLength(0);

	const repeated = await fetch(`${first.origin}/api/jobs/${jobs[0].id}`, {
		method: "DELETE",
		headers: { ...h, "x-actor": "other", "x-reason": "retry" },
	});
	const repeatedCancellation = await repeated.json();
	expect(repeatedCancellation.state).toBe("cancelled");
	expect(repeatedCancellation.cancellation.actor).toBe("test");
	expect(repeatedCancellation.cancellation.reason).toBe("contract");
	const eventsAfterRepeat = await fetch(`${first.origin}/api/jobs/${jobs[0].id}/events?cursor=0&limit=10`, {
		headers: h,
	});
	expect(await eventValues(eventsAfterRepeat)).toHaveLength(2);

	const malformed = await fetch(`${first.origin}/api/jobs`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ kind: "", payload: {} }),
	});
	expect(malformed.status).toBe(400);
	const invalidDeadline = await fetch(`${first.origin}/api/jobs`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ kind: "deadline", payload: {}, deadline_at: "not-a-deadline" }),
	});
	expect(invalidDeadline.status).toBe(400);
	const oversizedDeadline = await fetch(`${first.origin}/api/jobs`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ kind: "deadline", payload: {}, deadline_at: "2".repeat(65) }),
	});
	expect(oversizedDeadline.status).toBe(400);

	const recoveryJobResponse = await fetch(`${first.origin}/api/jobs`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ kind: "dream.trigger", payload: {} }),
	});
	const recoveryJob = await recoveryJobResponse.json();
	await stop(first.child);
	const db = new Database(join(first.dir, "memory", "memories.db"));
	db.run("UPDATE jobs SET state='running', updated_at=datetime('now') WHERE id=?", [recoveryJob.id]);
	db.run(
		"INSERT INTO pipeline_state(agent_id,state,paused,updated_at) VALUES(?, 'paused', 1, datetime('now')) ON CONFLICT(agent_id) DO UPDATE SET paused=1",
		["agent-a"],
	);
	db.close();

	const restarted = await start(first.dir);
	const recovered = await fetch(`${restarted.origin}/api/jobs/${recoveryJob.id}`, { headers: h });
	expect(recovered.status).toBe(200);
	expect((await recovered.json()).state).toBe("queued");
	const recoveryEvents = await fetch(`${restarted.origin}/api/jobs/${recoveryJob.id}/events?cursor=0&limit=10`, {
		headers: h,
	});
	expect((await eventValues(recoveryEvents)).map((event) => event.event)).toEqual(["queued", "recovered"]);
	await stop(restarted.child);
	const restartedAgain = await start(first.dir);
	const recoveryEventsAgain = await fetch(
		`${restartedAgain.origin}/api/jobs/${recoveryJob.id}/events?cursor=0&limit=10`,
		{ headers: h },
	);
	expect(await eventValues(recoveryEventsAgain)).toHaveLength(2);
});

it("terminalizes unsupported and overdue jobs with durable events", async () => {
	const started = await start();
	const h = headers("agent-lifecycle", "workspace-lifecycle");
	const unsupportedResponse = await fetch(`${started.origin}/api/jobs`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ kind: "never-supported", payload: {} }),
	});
	expect(unsupportedResponse.status).toBe(200);
	const unsupported = await unsupportedResponse.json();
	expect(unsupported.state).toBe("unsupported");
	const unsupportedEvents = await fetch(`${started.origin}/api/jobs/${unsupported.id}/events?cursor=0`, { headers: h });
	expect((await eventValues(unsupportedEvents)).map((event) => event.event)).toEqual(["unsupported"]);
	const overdueResponse = await fetch(`${started.origin}/api/jobs`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ kind: "dream.trigger", payload: {}, deadline_at: "2000-01-01T00:00:00Z" }),
	});
	expect(overdueResponse.status).toBe(200);
	const overdue = await overdueResponse.json();
	expect(overdue.state).toBe("expired");
	const overdueEvents = await fetch(`${started.origin}/api/jobs/${overdue.id}/events?cursor=0`, { headers: h });
	expect((await eventValues(overdueEvents)).map((event) => event.event)).toEqual(["expired"]);
});
