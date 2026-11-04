import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { makeObserver } from "../runner/daemon-observer.mjs";
import { assertNoSecrets, piRunArgs, renderCompose } from "../runner/dockerctl.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTailer, validateApproval } from "../runner/run-live.mjs";

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

test("observer: HTTP+SSE only, labels DMs, dedupes poll vs SSE, no sqlite", async () => {
	const msg = { id: "m1", createdAt: "2026-01-01T00:00:01.000Z", fromAgentId: "agA", toAgentId: "agB", content: "hi", type: "info", broadcast: false, deliveryStatus: "pending", deliveryState: "queued", deliveryAttempts: 0 };
	const toSyn = { ...msg, id: "m2", toAgentId: "syn1", createdAt: "2026-01-01T00:00:02.000Z" };
	const seenAuth = [];
	const srv = createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		if (req.method === "HEAD" && (url.pathname === "/health" || url.pathname === "/")) return res.writeHead(200).end();
		seenAuth.push(`${req.method} ${url.pathname}|${req.headers.authorization}`);
		if (url.pathname === "/api/cross-agent/messages") {
			res.setHeader("content-type", "application/json");
			return res.end(JSON.stringify({ messages: [msg, toSyn, { ...msg, acknowledgedAt: "2026-01-01T00:00:03.000Z" }] }));
		}
		if (url.pathname === "/api/cross-agent/stream") {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(`data: ${JSON.stringify({ type: "message", message: msg })}\n\n`);
			return void setTimeout(() => res.end(), 50);
		}
		res.writeHead(404).end();
	});
	const port = await listen(srv);
	const out = [];
	const obs = makeObserver({ baseUrl: `http://127.0.0.1:${port}`, token: "tok", agents: { A: { agentId: "agA", sessionKey: "sa" }, B: { agentId: "agB", sessionKey: "sb" } }, syntheticIds: new Set(["syn1"]), emit: (e) => out.push(e), pollMs: 30 });
	obs.start();
	await new Promise((r) => setTimeout(r, 250));
	await obs.stop();
	srv.close();
	const dms = out.filter((e) => e.type === "dm");
	assert.deepEqual(dms.map((d) => [d.messageId, d.fromAgent, d.toAgent, d.toSynthetic]), [["m1", "agA", "agB", false], ["m2", "agA", "syn1", true]]);
	assert.equal(dms[0].fromSession, null);
	assert.equal(obs.knows("m1"), true);
	assert.equal(out.filter((e) => e.type === "dm_ack").length, 1);
	const paths = new Set(seenAuth.map((a) => a.split("|")[0].split(" ")[1]));
	assert.ok(paths.has("/api/cross-agent/messages") && paths.has("/api/cross-agent/stream"), JSON.stringify([...paths]));
	assert.ok(seenAuth.every((a) => a.endsWith("|Bearer tok")), JSON.stringify([...new Set(seenAuth)]));
	assert.ok(!/node:sqlite|better-sqlite3|bun:sqlite|DatabaseSync/.test(readFileSync(new URL("../runner/daemon-observer.mjs", import.meta.url), "utf8")));
});

test("approval binds run, case, prompts and grader hashes; limits hard-capped", () => {
	const prepared = { runId: "r1", caseId: "c1", promptsSha256: "p", graderSha256: "g", harnessSha256: "h", imagesSha256: "i" };
	const good = { approvedBy: "user", runId: "r1", caseIds: ["c1"], promptsSha256: "p", graderSha256: "g", harnessSha256: "h", imagesSha256: "i", maxProviderRequests: 999, maxOutputTokens: 999999, maxWallMs: 9e9 };
	const v = validateApproval(good, prepared);
	assert.ok(v.ok);
	assert.deepEqual(v.limits, { requests: 24, output: 131072, wallMs: 480000 });
	for (const bad of [{}, { ...good, approvedBy: "" }, { ...good, runId: "x" }, { ...good, caseIds: [] }, { ...good, promptsSha256: "q" }, { ...good, graderSha256: "q" }, { ...good, harnessSha256: "x" }, { ...good, imagesSha256: "x" }, { ...good, harnessSha256: undefined }, null]) assert.equal(validateApproval(bad, prepared).ok, false);
});

test("coding shares only its project and baseline omits the Signet extension", () => {
	const common = { name: "n", runId: "r", network: "net", image: "img", hostname: "h", envFile: "/owned/pi.env", workdir: "/project", projectDir: "/owned/project" };
	const enabled = piRunArgs(common).join(" ");
	const baseline = piRunArgs({ ...common, baseline: true }).join(" ");
	assert.ok(enabled.includes("type=bind,source=/owned/project,target=/project"));
	assert.ok(enabled.includes("--provider zai-coding-cn"));
	assert.ok(enabled.includes("-e /opt/signet/signet-pi.mjs"));
	assert.ok(baseline.includes("--no-extensions"));
	assert.ok(!baseline.includes("-e /opt/signet/signet-pi.mjs"));
});

test("docker specs: hardened, no mounts for agents, secrets only via env-file", () => {
	const args = piRunArgs({ name: "n", runId: "r", network: "net", image: "img", hostname: "h", envFile: "/tmp/e.env", workdir: "/work/w" });
	const s = args.join(" ");
	for (const must of ["--read-only", "--cap-drop ALL", "no-new-privileges:true", "--env-file /tmp/e.env", "--network net", "--label coord-eval.run=r", "--thinking medium"]) assert.ok(s.includes(must), must);
	assert.ok(!args.includes("-v") && !s.includes("docker.sock") && !s.includes("--privileged"));
	const spec = renderCompose({ runId: "r", project: "p", images: { pi: "pi", daemon: "d", instrument: "i", relay: "r" }, relayTarget: "172.1.1.1:9", goldDir: "/g", instrumentDir: "/i", hostname: "h", piEnvFiles: { A: "/a.env", B: "/b.env" } });
	assert.equal(spec.services.instrument.mem_limit, "512m");
	assert.equal(spec.services.instrument.cpus, 1);
	assert.equal(spec.services.instrument.pids_limit, 128);
	assert.equal(spec.services.daemon.mem_limit, "2g");
	assert.equal(spec.services.daemon.cpus, 2);
	assert.ok(!JSON.stringify(spec.services.daemon).match(/gpu|devices/i));
	assert.ok(!spec.services["pi-a"].volumes);
	assert.ok(!JSON.stringify(spec.services.daemon).includes("/gold"));
	assert.ok(!spec.services.relay.environment);
	assert.throws(() => assertNoSecrets(spec, ["172.1.1.1"]));
});

test("tailer reads appended JSONL incrementally", () => {
	const f = join(mkdtempSync(join(tmpdir(), "tl-")), "x.jsonl");
	writeFileSync(f, '{"a":1}\n{"a":');
	const got = [];
	const tail = makeTailer(f, (e) => got.push(e.a));
	tail();
	appendFileSync(f, "2}\n");
	tail();
	assert.deepEqual(got, [1, 2]);
});

test("CLI: --prepare with --dry-run is rejected early (exit 2) with no side effects", () => {
	const script = fileURLToPath(new URL("../runner/run-live.mjs", import.meta.url));
	const results = fileURLToPath(new URL("../results", import.meta.url));
	const before = existsSync(results) ? readdirSync(results).sort().join() : null;
	const r = spawnSync(process.execPath, [script, "--prepare", "--dry-run"], { encoding: "utf8", timeout: 20000, env: { ...process.env, PATH: "/nonexistent" } });
	assert.equal(r.status, 2);
	assert.match(r.stderr, /mutually exclusive/);
	assert.equal(r.stdout, "");
	assert.equal(existsSync(results) ? readdirSync(results).sort().join() : null, before);
});
