#!/usr/bin/env node
// Live pilot orchestrator (PR2181 agent-coordination eval).
//
//   node runner/run-live.mjs --prepare [--approved <file>]      full offline preparation, then WAIT for explicit approval
//   node runner/run-live.mjs --dry-run [--keep-viewer]          same preparation, never generates; tears down unless --keep-viewer
//   node runner/run-live.mjs --teardown <runDir|runId>          remove this run's labelled containers/networks
//
// Lifecycle safety: --teardown never kills by bare PID. It writes <runDir>/stop.request.json (the runner polls it at all times,
// including while waiting for approval) and only signals a PID whose /proc start time matches the one recorded in prepared.json.
// A run directory is never reused: an existing one is refused.
//
// Preparation makes ZERO generation calls: uses pinned images, creates an --internal network, starts the isolated TEST Signet
// daemon, the instrument and a keyless relay, mints role=agent tokens (scope {}; not scope-restricted), starts two REAL Pi RPC processes (docker run -i), bootstraps
// them with get_state/get_available_models/get_commands only, verifies the Signet extension loaded (tools + presence), seeds
// labelled synthetic distractor presence, and starts the loopback-only viewer. It then writes <runDir>/prepared.json.
//
// Generation starts ONLY after the parent places a valid approval file (this runner never writes it). The approval must name
// this runId and carry the promptsSha256 + graderSha256 printed in prepared.json. The provider key (ZAI_CODING_CN_API_KEY, injected by
// the parent via secret exec) lives only in this process env and is served by the host proxy only after approval. Agents get
// opaque per-run tokens.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentPrompt, buildCase, seedProfiles } from "../lib/fixtures.mjs";
import { readJsonl } from "../lib/common.mjs";
import { makeCollector } from "../lib/collector.mjs";
import { grade, makeLeakScanner, proxyEventToInfra } from "../lib/grader.mjs";
import { startProxy } from "../services/provider-proxy.mjs";
import { startViewer } from "../viewer/server.mjs";
import { makeObserver } from "./daemon-observer.mjs";
import { LABEL, assertNoSecrets, containerIp, docker, dockerOut, imageExists, imageIdentity, networkGateway, piRunArgs, renderCompose } from "./dockerctl.mjs";
import { PiRpc } from "./pi-rpc.mjs";
import { verifyAgentIsolation } from "./probe-isolation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const evalDir = resolve(here, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

export const IMAGES = {
	pi: arg("pi-image", "coord-eval-pi:1.0.0-pr2181"),
	daemon: arg("daemon-image", "coord-eval-daemon:pr2181"),
	instrument: arg("instrument-image", "coord-eval-instrument:pr2181"),
	relay: "alpine/socat@sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed",
};
const EXPECTED_TOOLS = ["agent_peers", "agent_context_update", "agent_session_inspect", "agent_message_send", "agent_message_inbox", "agent_message_ack"];
const HARD = { requests: Infinity, output: 131072, wallMs: Infinity };

export const sha = (s) => createHash("sha256").update(s).digest("hex");

/** Hash of every file that decides what a run does and how it is judged (runner, lib, services, viewer, docker). */
export function harnessHash(dir = evalDir) {
	const files = [];
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			if (e.name === "node_modules") continue;
			const f = join(d, e.name);
			if (e.isDirectory()) walk(f);
			else files.push(f);
		}
	};
	for (const sub of ["runner", "lib", "services", "viewer", "docker", "coding"]) if (existsSync(join(dir, sub))) walk(join(dir, sub));
	const h = createHash("sha256");
	for (const f of files.sort()) h.update(`${f.slice(dir.length)}\0${createHash("sha256").update(readFileSync(f)).digest("hex")}\n`);
	return h.digest("hex");
}

export const imagesDigest = (idents) => sha(JSON.stringify(Object.fromEntries(Object.entries(idents).sort().map(([k, v]) => [k, v.id]))));

export const FINGERPRINT_ROOTS = ["integrations/pi", "platform/daemon", "libs/sdk", "evals/agent-coordination"];
export const FINGERPRINT_EXCLUDES = [":(exclude)evals/agent-coordination/results", ":(exclude)evals/agent-coordination/results/**", ":(exclude)**/node_modules/**", ":(exclude)**/_gold/**"];

/** Read-only content hash of every git-visible (tracked + untracked, not ignored) file under the intended roots. Never mutates the repo. */
export function sourceFingerprint(repo = resolve(evalDir, "..", ".."), roots = FINGERPRINT_ROOTS) {
	const git = (a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	try {
		const listed = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...roots, ...FINGERPRINT_EXCLUDES]).split("\0").filter(Boolean);
		const files = [...new Set(listed)].sort();
		const h = createHash("sha256");
		let newest = 0;
		let missing = 0;
		for (const f of files) {
			const full = join(repo, f);
			let line;
			try {
				const st = statSync(full);
				if (!st.isFile()) continue;
				newest = Math.max(newest, st.mtimeMs);
				line = createHash("sha256").update(readFileSync(full)).digest("hex");
			} catch {
				missing++;
				line = "deleted";
			}
			h.update(`${f}\0${line}\n`);
		}
		const dirty = git(["status", "--porcelain", "--", ...roots, ...FINGERPRINT_EXCLUDES]).split("\n").filter(Boolean).length;
		return { head: git(["rev-parse", "HEAD"]).trim(), scope: { roots, excludes: FINGERPRINT_EXCLUDES, includes: "git ls-files --cached --others --exclude-standard" }, hashedFiles: files.length, deletedTracked: missing, dirtyFiles: dirty, workingTreeSha256: h.digest("hex"), newestModifiedMs: newest };
	} catch (e) {
		return { error: String(e.message).slice(0, 200) };
	}
}

/** /proc start time (clock ticks since boot) of a pid; null if gone or unreadable. Distinguishes PID reuse. */
export function procStart(pid) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
	} catch {
		return null;
	}
}
export const ownedRunAlive = (prepared) => Boolean(prepared?.pid && prepared.pidStart && procStart(prepared.pid) === prepared.pidStart);

export const STOP_FILE = "stop.request.json";
export const requestStop = (runDir, runId) => writeFileSync(join(runDir, STOP_FILE), JSON.stringify({ runId, at: Date.now() }));
export function stopRequested(runDir, runId) {
	try {
		return JSON.parse(readFileSync(join(runDir, STOP_FILE), "utf8")).runId === runId;
	} catch {
		return false;
	}
}

/** Classify a rejected prompt RPC. Never a model behaviour: the model has not produced anything yet. */
export function classifyPromptFailure(resp) {
	const t = String(resp?.error ?? resp?.data?.error ?? "");
	if (/auth|api key|401|403|unauthori[sz]ed/i.test(t)) return "auth";
	if (/tool|extension/i.test(t)) return "tool_missing";
	return "setup";
}

/** Validate an approval file against this prepared run. Pure; unit-tested. */
export function validateApproval(approval, prepared) {
	const bad = (m) => ({ ok: false, reason: m });
	if (!approval || typeof approval !== "object") return bad("approval is not an object");
	if (typeof approval.approvedBy !== "string" || !approval.approvedBy.trim()) return bad("approvedBy missing");
	if (approval.runId !== prepared.runId) return bad("runId does not match prepared run");
	if (!Array.isArray(approval.caseIds) || !approval.caseIds.includes(prepared.caseId)) return bad("approval does not cover this case");
	if (approval.promptsSha256 !== prepared.promptsSha256) return bad("promptsSha256 mismatch (prompts changed since approval)");
	if (approval.graderSha256 !== prepared.graderSha256) return bad("graderSha256 mismatch (grader changed since approval)");
	if (!prepared.harnessSha256 || approval.harnessSha256 !== prepared.harnessSha256) return bad("harnessSha256 mismatch (runner/lib/services changed since approval)");
	if (!prepared.imagesSha256 || approval.imagesSha256 !== prepared.imagesSha256) return bad("imagesSha256 mismatch (image ids differ from approval)");
	const limits = {
		requests: Math.min(HARD.requests, Number(approval.maxProviderRequests ?? HARD.requests)),
		output: Math.min(HARD.output, Number(approval.maxOutputTokens ?? HARD.output)),
		wallMs: Math.min(HARD.wallMs, Number(approval.maxWallMs ?? HARD.wallMs)),
	};
	if (!Object.values(limits).every((v) => v > 0)) return bad("limits invalid");
	return { ok: true, limits };
}

export function makeTailer(path, onEvent) {
	let offset = 0;
	let carry = "";
	return () => {
		if (!existsSync(path)) return;
		const size = statSync(path).size;
		if (size <= offset) return;
		const fd = openSync(path, "r");
		const buf = Buffer.alloc(size - offset);
		readSync(fd, buf, 0, buf.length, offset);
		closeSync(fd);
		offset = size;
		const parts = (carry + buf.toString("utf8")).split("\n");
		carry = parts.pop() ?? "";
		for (const l of parts) {
			if (!l.trim()) continue;
			try {
				onEvent(JSON.parse(l));
			} catch {}
		}
	};
}

async function teardown(runId, project, extra = {}) {
	const ids = (await dockerOut(["ps", "-aq", "--filter", `label=${LABEL}=${runId}`], { allowFail: true })).split("\n").filter(Boolean);
	if (ids.length) await docker(["rm", "-f", "-v", ...ids], { allowFail: true });
	for (const n of [`${project}_evalnet`, `${project}_control`, `${project}_egress`]) await docker(["network", "rm", n], { allowFail: true });
	const nets = (await dockerOut(["network", "ls", "-q", "--filter", `label=${LABEL}=${runId}`], { allowFail: true })).split("\n").filter(Boolean);
	if (nets.length) await docker(["network", "rm", ...nets], { allowFail: true });
	const vols = (await dockerOut(["volume", "ls", "-q", "--filter", `label=${LABEL}=${runId}`], { allowFail: true })).split("\n").filter(Boolean);
	if (vols.length) await docker(["volume", "rm", "-f", ...vols], { allowFail: true });
	if (extra.secretsDir) rmSync(extra.secretsDir, { recursive: true, force: true });
}

async function main() {
	if (flag("teardown")) {
		const t = arg("teardown");
		const pj = t && existsSync(join(t, "prepared.json")) ? join(t, "prepared.json") : null;
		const p = pj ? JSON.parse(readFileSync(pj, "utf8")) : { runId: t, project: "unknown" };
		const out = { teardown: p.runId, stopRequested: false, signalled: false };
		if (pj && ownedRunAlive(p)) {
			requestStop(t, p.runId);
			out.stopRequested = true;
			for (let i = 0; i < 40 && ownedRunAlive(p); i++) await sleep(500);
			if (ownedRunAlive(p)) {
				process.kill(p.pid, "SIGTERM");
				out.signalled = true;
				for (let i = 0; i < 20 && ownedRunAlive(p); i++) await sleep(500);
			}
		}
		out.runnerStillAlive = Boolean(pj && ownedRunAlive(p));
		await teardown(p.runId, p.project, { secretsDir: p.secretsDir });
		console.log(JSON.stringify(out));
		return;
	}
	if (flag("prepare") && flag("dry-run")) {
		console.error("--prepare and --dry-run are mutually exclusive: --dry-run never generates, --prepare waits for approval to generate");
		process.exit(2);
	}
	const prepare = flag("prepare");
	const dry = !prepare;
	const keepViewer = flag("keep-viewer") || prepare;
	const coding = flag("coding");
	const baseline = coding && flag("no-messaging");
	const caseId = arg("case", coding ? "c2-split-coding" : "c1-discovery-wake");
	const seed = Number(arg("seed", 1));
	const rep = arg("rep", `r${Date.now().toString(36)}${randomBytes(2).toString("hex")}`);
	const runId = `${caseId}-s${seed}-${rep}-${randomBytes(3).toString("hex")}`;
	const project = `coordeval-${randomBytes(4).toString("hex")}`;
	const runDir = join(evalDir, "results", caseId, `seed${seed}-${rep}`);
	const goldDir = join(evalDir, "results", "_gold", `${caseId}-${seed}-${rep}`);
	const instDir = join(runDir, "instrument");
	const secretsDir = join(process.env.TMPDIR ?? tmpdir(), `coord-eval-${project}`);
	if (existsSync(runDir) || existsSync(goldDir)) {
		console.error(`FAILED: run directory already exists (${runDir}); runs are never overwritten. Use a new --rep.`);
		process.exit(2);
	}
	for (const d of [runDir, goldDir, instDir]) mkdirSync(d, { recursive: true });
	mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
	chmodSync(instDir, 0o777);
	const eventsPath = join(runDir, "events.jsonl");
	writeFileSync(eventsPath, "");
	writeFileSync(join(instDir, "instrument.jsonl"), "");
	chmodSync(join(instDir, "instrument.jsonl"), 0o666);
	writeFileSync(join(runDir, "proxy.jsonl"), "");

	const collector = makeCollector({ eventsPath });
	const emit = collector.emit;
	const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
	const infra = (cls, message, extra = {}) => emit({ src: "infra", type: "error", class: cls, message: String(message).slice(0, 300), ...extra });

	// ---- case ----
	const c = buildCase({ caseId: coding ? "c1-discovery-wake" : caseId, seed, now: Date.now() });
	const projectDir = coding ? join(runDir, "project") : undefined;
	if (coding) {
		mkdirSync(projectDir, { mode: 0o777 });
		chmodSync(projectDir, 0o777);
		c.public = { caseId, host: "split-code", objective: "Correct combined job service and CLI from private split briefs", variant: baseline ? "without-messaging" : "with-messaging", realAgents: 2, syntheticProfiles: 0 };
	}
	writeFileSync(join(goldDir, "gold.json"), JSON.stringify(c.gold));
	writeFileSync(join(runDir, "case.public.json"), JSON.stringify(c.public, null, 2));
	collector.setScan(makeLeakScanner(c.gold));
	collector.registerGold(c.gold);
	const labels = Object.keys(c.gold.agents);
	const order = [c.gold.roles.responder, c.gold.roles.initiator]; // responder first, left idle; initiator starts later
	const prompts = coding ? (await import("../coding/task.mjs")).prompts : Object.fromEntries(labels.map((l) => [l, agentPrompt(c, l)]));
	writeFileSync(join(runDir, "prompts.json"), JSON.stringify(prompts, null, 2));
	const promptsSha256 = sha(JSON.stringify(prompts));
	const graderSha256 = sha(readFileSync(join(evalDir, coding ? "coding" : "lib", coding ? "grade.mjs" : "grader.mjs")));

	const ids = Object.fromEntries(labels.map((l) => [l, { agentId: randomUUID(), proxyToken: `pt_${randomBytes(18).toString("hex")}` }]));
	collector.register(process.env.ZAI_CODING_CN_API_KEY, ...labels.map((l) => ids[l].proxyToken));
	const proxyTokens = Object.fromEntries(labels.map((l) => [ids[l].proxyToken, l]));
	const syntheticIds = new Set(coding ? [] : c.gold.profileTruth.map((p) => p.agentId));

	// ---- viewer first: the user can watch before any prompt ----
	const viewer = await startViewer(runDir);
	emit({ src: "runner", type: "viewer_ready", url: viewer.url });
	log(`VIEWER ${viewer.url}`);

	const state = { runId, project, caseId, seed, rep, runDir, goldDir, secretsDir, pid: process.pid, pidStart: procStart(process.pid), harnessSha256: harnessHash(), viewerUrl: viewer.url, promptsSha256, graderSha256, images: IMAGES, phase: "preparing", containers: [] };
	const savePrepared = () => writeFileSync(join(runDir, "prepared.json"), JSON.stringify(state, null, 2));
	savePrepared();

	let approved = false;
	const proxyKey = () => (approved ? process.env.ZAI_CODING_CN_API_KEY : undefined);
	let proxy;
	const pis = {};
	let observer;
	let tailTimer;
	let ending = false;
	let viewerClosed = false;
	const closeViewer = () => {
		if (viewerClosed) return;
		viewerClosed = true;
		void viewer.close();
	};
	// Stops billing first (proxy), then the agents, then daemon/instrument containers. The viewer is closed here unless asked to stay.
	const cleanup = async (why, { holdViewer = false } = {}) => {
		if (ending) return;
		ending = true;
		log(`teardown (${why})`);
		clearInterval(tailTimer);
		clearInterval(stopTimer);
		await proxy?.close().catch(() => {});
		for (const p of Object.values(pis)) await p.stop().catch(() => {});
		await observer?.stop().catch(() => {});
		if (!holdViewer) closeViewer();
		state.phase = state.phase === "done" ? "done" : `torn_down:${why}`;
		savePrepared();
		await teardown(runId, project, { secretsDir });
	};
	for (const sg of ["SIGINT", "SIGTERM"]) process.on(sg, () => void cleanup(sg).then(() => process.exit(0)));
	// Trusted stop control: the host-only run directory. Honoured at any phase, including waiting for approval.
	const stopTimer = setInterval(() => {
		if (!ending && stopRequested(runDir, runId)) void cleanup("stop_requested").then(() => process.exit(0));
	}, 500);

	try {
		// ---- images (building is explicit; see README "Build") ----
		for (const [k, tag] of Object.entries(IMAGES)) {
			if (await imageExists(tag)) continue;
			if (k === "relay") await docker(["pull", "-q", tag], { timeoutMs: 300000 });
			else throw new Error(`image ${tag} missing; build it first (README "Build")`);
		}
		const imageIdents = Object.fromEntries(await Promise.all(Object.entries(IMAGES).map(async ([k, tag]) => [k, await imageIdentity(tag)])));
		state.imageIdentities = imageIdents;
		state.imagesSha256 = imagesDigest(imageIdents);
		state.sourceFingerprint = sourceFingerprint();
		state.imagesPredateSource = ["pi", "daemon", "instrument"].filter((k) => Date.parse(imageIdents[k].created) < (state.sourceFingerprint.newestModifiedMs ?? 0));
		savePrepared();

		// ---- networks and gated host proxy bound to the private bridge gateway only ----
		await docker(["network", "create", "--internal", "--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated", "--label", `${LABEL}=${runId}`, `${project}_evalnet`]);
		await docker(["network", "create", "--internal", "--label", `${LABEL}=${runId}`, `${project}_control`]);
		await docker(["network", "create", "--label", `${LABEL}=${runId}`, `${project}_egress`]);
		const gateway = await networkGateway(`${project}_egress`);
		proxy = await startProxy({ tokens: proxyTokens, eventsPath: join(runDir, "proxy.jsonl"), maxRequests: HARD.requests, maxOutput: HARD.output, key: proxyKey, host: gateway, port: 0 });
		state.proxy = { bind: `${gateway}:${proxy.port}`, keyServedBeforeApproval: false };
		log(`proxy bound ${state.proxy.bind} (gated; serves no key before approval)`);

		// ---- compose render (validated) ----
		const modelsTpl = JSON.parse(readFileSync(join(evalDir, "docker", "models.json.template"), "utf8"));
		const modelsJson = JSON.stringify(modelsTpl);
		const envFiles = Object.fromEntries(labels.map((l) => [l, join(secretsDir, `pi-${l}.env`)]));
		const hostname = c.public.host;
		const composeSpec = renderCompose({ runId, project, images: IMAGES, relayTarget: `${gateway}:${proxy.port}`, goldDir, instrumentDir: instDir, hostname, piEnvFiles: envFiles });
		if (coding) delete composeSpec.services.instrument;
		assertNoSecrets(composeSpec, [process.env.ZAI_CODING_CN_API_KEY, ...Object.keys(proxyTokens)]);
		const composePath = join(runDir, "compose.rendered.yml");
		writeFileSync(composePath, JSON.stringify(composeSpec, null, 2));
		for (const l of labels) writeFileSync(envFiles[l], "", { mode: 0o600 });
		await docker(["compose", "-f", composePath, "--profile", "rpc", "config", "-q"]);
		log("compose config validated");
		const services = coding ? ["daemon", "relay"] : ["daemon", "instrument", "relay"];
		await docker(["compose", "-f", composePath, "up", "-d", ...services], { timeoutMs: 180000 });
		const cname = (s) => `${project}-${s}-1`;
		state.containers = services.map(cname);
		savePrepared();

		// ---- daemon health ----
		const daemonUrl = `http://${await containerIp(cname("daemon"), `${project}_control`)}:3850`;
		let healthy = false;
		for (let i = 0; i < 90 && !healthy; i++) {
			try {
				healthy = (await fetch(`${daemonUrl}/health`, { signal: AbortSignal.timeout(2000) })).ok;
			} catch {}
			if (!healthy) await sleep(1000);
		}
		if (!healthy) {
			infra("setup", "daemon never became healthy");
			throw new Error("daemon not healthy");
		}
		emit({ src: "runner", type: "daemon_healthy" });
		const mint = async (role, sub) => (await dockerOut(["exec", cname("daemon"), "bun", "/app/deploy/docker/scripts/create-token.mjs", "--role", role, "--sub", sub, "--ttl", "21600"])).split("\n").pop().trim();
		const adminToken = await mint("admin", "eval:observer");
		const agentTokens = Object.fromEntries(await Promise.all(labels.map(async (l) => [l, await mint("agent", `eval:${randomBytes(8).toString("hex")}`)])));
		collector.register(adminToken, ...Object.values(agentTokens));
		const adminHeaders = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };
		const dget = async (p) => (await fetch(`${daemonUrl}${p}`, { headers: adminHeaders })).json();
		// Every actor (real and synthetic) is a registered agent row with the SHARED read policy, via the admin agent API, so scope
		// resolution never sees an unknown id. 409 means it already exists. Anything else is a setup failure before any prompt.
		const registerAgent = async (name) => {
			const r = await fetch(`${daemonUrl}/api/agents`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ name, read_policy: "shared" }) });
			if (r.status !== 201 && r.status !== 409) {
				infra("setup", `agent registration failed with status ${r.status}`);
				throw new Error(`agent registration failed (${r.status})`);
			}
			const back = await fetch(`${daemonUrl}/api/agents/${encodeURIComponent(name)}`, { headers: adminHeaders });
			const row = back.ok ? await back.json() : null;
			if (!row || row.id !== name || row.read_policy !== "shared") {
				infra("setup", `agent ${name.slice(0, 8)} readback status ${back.status} read_policy ${row?.read_policy ?? null}`);
				throw new Error("agent registration readback mismatch");
			}
		};
		for (const l of labels) await registerAgent(ids[l].agentId);
		for (const id of syntheticIds) await registerAgent(id);
		for (const l of labels) {
			const self = await fetch(`${daemonUrl}/api/agents/${encodeURIComponent(ids[l].agentId)}`, { headers: { authorization: `Bearer ${agentTokens[l]}` } });
			const row = self.ok ? await self.json() : null;
			if (!row || row.id !== ids[l].agentId || row.read_policy !== "shared") {
				infra("setup", `agent-token view of own agent failed: status ${self.status}`);
				throw new Error("agent view readback mismatch");
			}
		}
		state.agentsRegistered = { realAgents: labels.length, presenceSessions: labels.length + c.gold.profileTruth.length, uniqueAgents: new Set([...labels.map((l) => ids[l].agentId), ...syntheticIds]).size, syntheticOnlyAgents: [...syntheticIds].filter((x) => !labels.some((l) => ids[l].agentId === x)).length, readPolicy: "shared", readBackAsAdmin: true, readBackAsOwnAgentToken: labels.length };
		state.tokenScope = "role=agent via deploy create-token.mjs; role-limited, not path/scope-restricted (that script mints scope {})";

		if (!coding) {
		const instIp = await containerIp(cname("instrument"), `${project}_control`);
		const probeRes = await fetch(`http://${instIp}:8080/v1/jobs/none`, { headers: { authorization: "Bearer nope" } });
		if (probeRes.status !== 401) throw new Error(`instrument unauthenticated probe expected 401, got ${probeRes.status}`);
		}
		// the instrument's own bad-token probe is a host-origin check; it must not count against an agent (no agent attribution)

		// ---- real Pi RPC processes ----
		for (const l of labels) {
			writeFileSync(
				envFiles[l],
				`${[
					...(baseline ? [] : ["SIGNET_DAEMON_URL=http://daemon:3850", `SIGNET_TOKEN=${agentTokens[l]}`, `SIGNET_AGENT_ID=${ids[l].agentId}`]),
					...(coding ? [] : ["SIMGPU_URL=http://instrument:8080", `SIMGPU_TOKEN=${c.gold.agents[l].token}`]),
					`ZAI_CODING_CN_API_KEY=${ids[l].proxyToken}`, `EVAL_MODELS_JSON=${modelsJson}`, "PI_OFFLINE=1", "PI_CODING_AGENT_DIR=/home/agent/.pi/agent",
				].join("\n")}\n`,
				{ mode: 0o600 },
			);
		}
		const tailInst = makeTailer(join(instDir, "instrument.jsonl"), (e) => emit(e));
		let budgetEmitted = false;
		const tailProxy = makeTailer(join(runDir, "proxy.jsonl"), (e) => {
			emit(e);
			if (e.type === "refused" && e.reason === "request_cap" && !budgetEmitted) {
				budgetEmitted = true;
				emit({ src: "runner", type: "timeout", kind: "request_budget", cap: e.cap ?? null });
			}
			const m = proxyEventToInfra(e);
			if (m?.infra) infra(m.infra.class, `provider status ${m.infra.status}`, { agent: e.agent, status: m.infra.status, upstreamClass: e.class ?? null });
			if (m?.timeout && !budgetEmitted) {
				budgetEmitted = true;
				emit({ src: "runner", type: "timeout", ...m.timeout });
			}
		});
		const flush = () => {
			tailInst();
			tailProxy();
		};
		tailTimer = setInterval(flush, 100);
		// Pi records are ingested synchronously, in arrival order: each gets its host observedSeq at once, nothing is held or
		// reordered. agent_start is emitted when Pi reports it. Every user message of a run is then emitted as its own `user_input`
		// event (ordinal, and the real wake Message ID if the text is the formatted direct-message injection) referencing the
		// observedSeq of that run's agent_start. The backend DM is correlated later by the grader, by id only.
		const runs = {};
		const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((x) => x?.text ?? "").join("\n"));
		const piRecord = (r) => {
			const ev = emit(r);
			if (r.src !== "pi") return;
			const a = r.agent;
			if (r.type === "agent_start") runs[a] = { startObservedSeq: ev.observedSeq, users: 0 };
			if (r.type === "rpc_message_start" && r.raw?.message?.role === "user" && runs[a]) {
				const text = textOf(r.raw.message);
				const idm = /Direct message from another agent/.test(text) ? /Message ID:\s*([0-9a-fA-F-]{8,})/.exec(text) : null;
				const sk = /Your session key is\s+(\S+?)\./.exec(text)?.[1];
				emit({ src: "pi", type: "user_input", agent: a, startObservedSeq: runs[a].startObservedSeq, ordinal: runs[a].users++, wakeMessageId: idm?.[1] ?? null, session: sk ?? null });
			}
		};
		for (const l of labels) {
			const name = `${project}-pi-${l.toLowerCase()}`;
			const args = piRunArgs({ name, runId, network: `${project}_evalnet`, image: IMAGES.pi, hostname, envFile: envFiles[l], workdir: coding ? "/project" : `/work/${c.public.agentTasks[l].context.cwd.split("/").pop()}`, projectDir, baseline });
			assertNoSecrets(args, [process.env.ZAI_CODING_CN_API_KEY, ids[l].proxyToken, agentTokens[l], c.gold.agents[l].token]);
			pis[l] = new PiRpc({ label: l, command: "docker", args, onRecord: piRecord, scan: collector.scan, scrubText: collector.scrubText });
			state.containers.push(name);
		}
		savePrepared();
		for (const l of labels) pis[l].exited.then((code) => !ending && state.phase !== "done" && infra("container", `pi ${l} exited ${code}`, { agent: l }));

		// ---- bootstrap: no generation ----
		const boot = {};
		for (const l of labels) {
			const st = await pis[l].send({ type: "get_state" });
			const models = await pis[l].send({ type: "get_available_models" });
			const cmds = await pis[l].send({ type: "get_commands" });
			boot[l] = {
				model: st.data?.model?.id ?? null, provider: st.data?.model?.provider ?? null, thinkingLevel: st.data?.thinkingLevel ?? null,
				modelAvailable: JSON.stringify(models.data ?? {}).includes("glm-5.3-flash"),
				signetCommands: (cmds.data?.commands ?? []).map((x) => x.name).filter((n) => /recall|remember|signet/.test(n)),
			};
			if (boot[l].model !== "glm-5.3-flash" || boot[l].provider !== "zai-coding-cn") throw new Error(`pi ${l} wrong model ${JSON.stringify(boot[l])}`);
			if (!boot[l].modelAvailable) throw new Error(`pi ${l}: model not in available list`);
			if (!baseline && !boot[l].signetCommands.length) throw new Error(`pi ${l}: Signet extension commands not registered`);
		}
		emit({ src: "runner", type: "pi_bootstrap", boot });
		state.isolation = await verifyAgentIsolation({ project, actors: Object.fromEntries(labels.map((l) => [l, `${project}-pi-${l.toLowerCase()}`])) });
		emit({ src: "runner", type: "isolation_verified", ...state.isolation });

		// tool registration of the REAL built extension bundle from the agent image (fake host API, real bundle code)
		const probe = `import m from "/opt/signet/signet-pi.mjs";const t=[];const noop=()=>{};const api=new Proxy({registerTool:(x)=>t.push(x.name),registerCommand:noop,on:noop,registerProvider:noop},{get:(o,k)=>k in o?o[k]:noop});try{await (m.default??m)(api)}catch(e){console.error(String(e))}console.log(JSON.stringify(t))`;
		const toolOut = baseline ? "[]" : await dockerOut(["run", "--rm", "-i", "--network", "none", "--label", `${LABEL}=${runId}`, "-e", "SIGNET_DAEMON_URL=http://127.0.0.1:1", "-e", "SIGNET_AGENT_ID=probe", IMAGES.pi, "node", "--input-type=module", "-e", probe], { timeoutMs: 60000 });
		const tools = JSON.parse(toolOut.split("\n").filter((x) => x.startsWith("[")).pop() ?? "[]");
		const missing = baseline ? [] : EXPECTED_TOOLS.filter((t) => !tools.includes(t));
		emit({ src: "runner", type: "extension_tools", tools, missing });
		if (missing.length) throw new Error(`extension tools missing: ${missing}`);

		// ---- presence registered by the real extension with each session's own key ----
		const sessions = {};
		for (let i = 0; !baseline && i < 60 && Object.keys(sessions).length < labels.length; i++) {
			for (const l of labels) {
				if (sessions[l]) continue;
				try {
					const r = await dget(`/api/cross-agent/presence?agent_id=${ids[l].agentId}&include_self=true&limit=50`);
					const mine = (r.sessions ?? []).find((s) => s.agentId === ids[l].agentId);
					if (mine?.sessionKey) sessions[l] = { agentId: ids[l].agentId, sessionKey: mine.sessionKey, harness: mine.harness, context: mine.context ?? null };
				} catch {}
			}
			if (Object.keys(sessions).length < labels.length) await sleep(1000);
		}
		if (!baseline && Object.keys(sessions).length < labels.length) {
			infra("setup", "real Pi sessions never registered presence");
			throw new Error("presence not registered");
		}
		emit({ src: "runner", type: "presence_registered", sessions: Object.fromEntries(Object.entries(sessions).map(([l, s]) => [l, { agentId: s.agentId, harness: s.harness, context: s.context }])) });

		for (const l of Object.keys(sessions)) emit({ src: "runner", type: "binding", label: l, agentId: sessions[l].agentId, sessionKey: sessions[l].sessionKey });
		// ---- synthetic presence rows (uniform shape; trap row reuses the responder's agent id). The daemon API cannot backdate
		// context time, so stale rows are seeded fresh; recorded as staleBackdated:false. ----
		const rows = coding ? [] : seedProfiles(c, Object.fromEntries(labels.map((l) => [l, sessions[l]])));
		let seeded = 0;
		const real = sessions[labels[0]];
		for (const d of rows) {
			const r = await fetch(`${daemonUrl}/api/cross-agent/presence`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ agentId: d.agentId, sessionKey: d.sessionKey, harness: real.harness ?? "pi", context: d.context }) });
			if (r.ok) seeded++;
			else emit({ src: "runner", type: "seed_error", status: r.status });
		}
		if (seeded !== rows.length) throw new Error(`seeded ${seeded}/${rows.length} presence rows; refusing to continue`);
		state.agentsRegistered.presenceSessions = Object.keys(sessions).length + seeded;
		emit({ src: "runner", type: "distractors_seeded", seeded, total: rows.length, realStaleCaseTested: false });

		// ---- observer (HTTP/SSE only; no direct DB) ----
		observer = makeObserver({ baseUrl: daemonUrl, token: adminToken, agents: sessions, syntheticIds, emit });
		observer.start();
		emit({ src: "runner", type: "setup_verified", tools: tools.length, presence: Object.keys(sessions).length, seeded });

		Object.assign(state, { phase: "prepared", daemonUrl, bootstrap: boot, tools, distractorsSeeded: seeded });
		state.approvalFile = resolve(arg("approved", join(runDir, "approval.json")));
		state.approvalTemplate = { approvedBy: "<user>", runId, caseIds: [caseId], promptsSha256, graderSha256, harnessSha256: state.harnessSha256, imagesSha256: state.imagesSha256, maxProviderRequests: HARD.requests, maxOutputTokens: HARD.output, maxWallMs: HARD.wallMs };
		savePrepared();
		emit({ src: "runner", type: "prepared", viewer: viewer.url });
		console.log(JSON.stringify({ prepared: true, runId, pid: process.pid, viewer: viewer.url, runDir, approvalFile: state.approvalFile, approvalTemplate: state.approvalTemplate, containers: state.containers }));

		if (dry) {
			if (!keepViewer) {
				await cleanup("dry-run");
				process.exit(0);
			}
			log("dry-run: preparation complete; this mode NEVER generates. SIGTERM or --teardown to tear down.");
			await new Promise(() => {});
		}

		// ---- wait for explicit approval (written by the parent, never by this process) ----
		const deadline = Date.now() + Number(arg("wait-ms", 4 * 3600_000));
		let limits;
		log(`waiting for approval file ${state.approvalFile}`);
		while (Date.now() < deadline) {
			if (existsSync(state.approvalFile)) {
				let a;
				try {
					a = JSON.parse(readFileSync(state.approvalFile, "utf8"));
				} catch {
					await sleep(500);
					continue;
				}
				const v = validateApproval(a, state);
				if (v.ok) {
					limits = v.limits;
					state.approvedBy = a.approvedBy;
					break;
				}
				if (state.lastApprovalReject !== v.reason) {
					state.lastApprovalReject = v.reason;
					log(`approval file rejected: ${v.reason}`);
					savePrepared();
				}
			}
			await sleep(1000);
		}
		if (!limits) {
			await cleanup("approval_wait_expired");
			process.exit(0);
		}

		// ================= LIVE (approved) =================
		// Nothing below runs unless the approval named the exact harness and images that are on disk right now.
		if (harnessHash() !== state.harnessSha256) throw new Error("harness files changed after preparation/approval; refusing to generate");
		const nowImages = Object.fromEntries(await Promise.all(Object.entries(IMAGES).map(async ([k, tag]) => [k, await imageIdentity(tag)])));
		if (imagesDigest(nowImages) !== state.imagesSha256) throw new Error("image ids changed after approval; refusing to generate");
		if (!process.env.ZAI_CODING_CN_API_KEY) {
			infra("setup", "provider key absent from runner environment after approval (checked presence only)");
			throw new Error("provider key missing; no prompt was sent");
		}
		approved = true;
		const t0Mono = performance.now();
		const wallLeft = () => limits.wallMs - (performance.now() - t0Mono);
		proxy.setLimits({ requests: limits.requests, output: limits.output, wallMs: limits.wallMs });
		state.phase = "running";
		savePrepared();
		emit({ src: "runner", type: "case_start", limits, approvedBy: state.approvedBy });
		if (coding) {
			await (await import("../coding/run.mjs")).runCoding({ pis, prompts, flush, eventsPath, wallLeft });
		} else {
		for (const l of order) {
			if (l === c.gold.roles.initiator) await sleep(1500);
			const settledBefore = pis[l].settledCount;
			const resp = await pis[l].prompt(prompts[l], "initial");
			emit({ src: "runner", type: "prompt_response", agent: l, success: resp.success, disposition: resp.data?.disposition ?? null });
			if (!resp.success) {
				infra(classifyPromptFailure(resp), `prompt rejected for agent: ${String(resp.error ?? "").slice(0, 200)}`, { agent: l });
				break;
			}
			if (l === c.gold.roles.responder) {
				try {
					await pis[l].waitSettled(Math.min(2 ** 31 - 1, Math.max(1000, wallLeft())), settledBefore);
				} catch {
					emit({ src: "runner", type: "timeout", kind: "responder_initial_settle" });
					break;
				}
			}
		}
		// Run until both jobs are complete and both agents idle (agent_settled), or the budget is exhausted. No runner nudges.
		for (;;) {
			flush();
			const evs = readJsonl(readFileSync(eventsPath, "utf8"));
			const idle = (l) => {
				const st = evs.filter((e) => e.src === "pi" && e.type === "agent_start" && e.agent === l).pop();
				const se = evs.filter((e) => e.src === "pi" && e.type === "agent_settled" && e.agent === l).pop();
				return Boolean(se) && (!st || se.observedSeq > st.observedSeq);
			};
			const done = (l) => evs.some((e) => e.src === "instrument" && e.type === "complete" && e.agent === l);
			if (labels.every(done) && labels.every(idle)) break;
			if (evs.some((e) => (e.src === "infra" && e.type === "error") || (e.src === "proxy" && e.type === "upstream_error" && !e.recovered))) break;
			if (evs.some((e) => e.src === "runner" && e.type === "timeout")) break;
			if (wallLeft() <= 0) {
				emit({ src: "runner", type: "timeout", kind: "trial_wall", wallLimitMs: limits.wallMs });
				break;
			}
			await sleep(250);
		}
		}
		// Stop billing first, then end the agents (abort is bounded to 1.5s inside PiRpc.stop).
		await proxy.close().catch(() => {});
		await sleep(300);
		flush();
		await observer.stop();
		flush();
		state.phase = "done";
		emit({ src: "runner", type: "case_end" });
		for (const p of Object.values(pis)) await p.stop().catch(() => {});
		flush();
		const trace = readJsonl(readFileSync(eventsPath, "utf8"));
		const result = coding ? await (await import("../coding/run.mjs")).gradeCoding({ projectDir, image: IMAGES.pi, evalDir, trace }) : grade(c.gold, trace);
		writeFileSync(join(runDir, "grade.json"), JSON.stringify(result, null, 2));
		const summary = {
			runId, grade: { pass: result.pass, status: result.status, failureClass: result.failureClass, failed: result.failedChecks }, providerRequests: proxy.count(),
			proxyUsage: trace.filter((e) => e.src === "proxy" && e.type === "request").map((e) => ({ agent: e.agent, status: e.status, servedModel: e.servedModel, finishReason: e.finishReason, truncated: e.truncated, usage: e.usage })),
			piUsage: trace.filter((e) => e.src === "pi" && e.type === "usage"),
		};
		writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
		console.log(JSON.stringify(summary));
		const holdMs = Number(arg("viewer-hold-ms", 1800000));
		log(`agents and proxy are down; viewer ${viewer.url} and the test daemon dashboard stay up for ${Math.round(holdMs / 60000)} min`);
		await new Promise((r) => {
			setTimeout(r, holdMs).unref?.();
			process.once("SIGTERM", r);
			process.once("SIGINT", r);
		});
		await cleanup("finished");
		closeViewer();
		process.exit(0);
	} catch (e) {
		emit({ src: "runner", type: "prepare_failed", message: String(e.message).slice(0, 400) });
		state.phase = "failed";
		state.error = String(e.message);
		console.error(`FAILED: ${e.message}`);
		await cleanup("failure");
		process.exit(1);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
