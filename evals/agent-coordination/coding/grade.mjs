import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const rnd = (p) => `${p}-${crypto.randomBytes(6).toString("hex")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CAP = 4000;

export async function grade(projectDir) {
	const checks = Object.fromEntries(
			[
				"files_present",
				"backend_starts",
				"basic_submit_result",
				"request_id_idempotent",
				"identical_text_distinct_jobs",
				"retry_after_lost_response_no_duplicate",
				"queued_cancel_prevents_execution",
				"cancel_completed_preserved",
				"queued_survives_restart",
				"single_concurrency",
			].map((name) => [name, false]),
		),
		details = {};
	const rec = (n, ok, d) => {
		checks[n] = !!ok;
		if (!ok) details[n] = String(d ?? "failed").slice(0, 600);
	};
	const server = path.join(projectDir, "backend/server.mjs"),
		cli = path.join(projectDir, "cli/main.mjs");
	const finish = () => {
		const total = Object.keys(checks).length,
			passed = Object.values(checks).filter(Boolean).length;
		return { checks, passed, total, pass: passed === total, details };
	};
	rec(
		"files_present",
		fs.existsSync(server) && fs.existsSync(cli),
		`missing: ${[server, cli].filter((f) => !fs.existsSync(f)).join(", ")}`,
	);
	if (!checks.files_present) return finish();
	const calls = [];
	let active = 0,
		peak = 0,
		gate = null;
	const worker = http.createServer((req, res) => {
		let b = "";
		req.on("data", (c) => (b += c));
		req.on("end", async () => {
			let text;
			try {
				text = JSON.parse(b).text;
			} catch {
				res.statusCode = 400;
				return res.end("{}");
			}
			calls.push(text);
			active++;
			peak = Math.max(peak, active);
			try {
				if (gate) await gate.p;
				await sleep(30);
			} finally {
				active--;
			}
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ result: sha(String(text)) }));
		});
	});
	const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
	const wport = await listen(worker);
	const openGate = () => {
		const g = gate;
		gate = null;
		g?.rel();
	};
	const closeGate = () => {
		let rel;
		const p = new Promise((r) => (rel = r));
		gate = { p, rel };
	};
	const bport = await new Promise((r) => {
		const s = net.createServer().listen(0, "127.0.0.1", () => {
			const p = s.address().port;
			s.close(() => r(p));
		});
	});
	let dropNext = false;
	const proxy = http.createServer((req, res) => {
		const drop = dropNext && ["POST", "PUT"].includes(req.method) && ((dropNext = false), true);
		const up = http.request(
			{ host: "127.0.0.1", port: bport, method: req.method, path: req.url, headers: req.headers },
			(ur) => {
				if (drop) {
					ur.resume();
					ur.on("end", () => req.socket.destroy());
					return;
				}
				res.writeHead(ur.statusCode, ur.headers);
				ur.pipe(res);
			},
		);
		up.on("error", () => req.socket.destroy());
		req.pipe(up);
	});
	const pport = await listen(proxy);

	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "grade-data-"));
	let child = null,
		log = "";
	const start = async () => {
		child = spawn("node", [server], {
			cwd: projectDir,
			env: { ...process.env, PORT: String(bport), DATA_DIR: dataDir, WORKER_URL: `http://127.0.0.1:${wport}/work` },
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.on("data", (c) => (log = (log + c).slice(-CAP)));
		child.stderr.on("data", (c) => (log = (log + c).slice(-CAP)));
		for (let i = 0; i < 60; i++) {
			if (child.exitCode !== null) return false;
			if (
				await new Promise((r) => {
					const s = net.connect(bport, "127.0.0.1", () => {
						s.destroy();
						r(true);
					});
					s.on("error", () => r(false));
				})
			)
				return true;
			await sleep(250);
		}
		return false;
	};
	const stop = async () => {
		if (!child || child.exitCode !== null) return;
		const done = new Promise((r) => child.once("exit", r));
		child.kill("SIGTERM");
		await Promise.race([done, sleep(5000)]);
		if (child.exitCode === null) child.kill("SIGKILL");
	};
	const run = (...args) =>
		new Promise((resolve) => {
			const c = spawn("node", [cli, ...args], {
				cwd: projectDir,
				env: { ...process.env, JOB_URL: `http://127.0.0.1:${pport}` },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let out = "",
				err = "";
			c.stdout.on("data", (d) => (out = (out + d).slice(0, CAP)));
			c.stderr.on("data", (d) => (err = (err + d).slice(0, CAP)));
			const t = setTimeout(() => c.kill("SIGKILL"), 3000);
			c.on("close", (code) => {
				clearTimeout(t);
				let j = null;
				try {
					if (code === 0) j = JSON.parse(out);
				} catch {}
				resolve({ j, out, err });
			});
			c.on("error", () => {
				clearTimeout(t);
				resolve({ j: null, out, err: "spawn error" });
			});
		});
	const waitState = async (id, want, ms = 15000) => {
		const end = Date.now() + ms;
		let last;
		while (Date.now() < end) {
			last = (await run("status", id)).j;
			if (last && want.includes(last.state)) return last;
			await sleep(200);
		}
		return last ?? null;
	};
	const n = (t) => calls.filter((c) => c === t).length;

	try {
		if (!(await start())) {
			rec("backend_starts", false, `backend did not listen: ${log}`);
			return finish();
		}
		rec("backend_starts", true);
		const t1 = rnd("basic");
		const s1 = await run("submit", t1);
		const st = s1.j?.id ? await waitState(s1.j.id, ["completed"]) : null;
		rec(
			"basic_submit_result",
			st?.state === "completed" && st.result === sha(t1),
			`${s1.out} ${s1.err} ${JSON.stringify(st)}`,
		);
		const doneId = s1.j?.id;
		const t2 = rnd("rid"),
			rid = rnd("req");
		const a = await run("submit", t2, "--request-id", rid),
			b = await run("submit", t2, "--request-id", rid);
		const sa = a.j?.id ? await waitState(a.j.id, ["completed"]) : null;
		await sleep(100);
		rec(
			"request_id_idempotent",
			a.j?.id && a.j.id === b.j?.id && n(t2) === 1 && sa?.result === sha(t2),
			`ids ${a.j?.id}/${b.j?.id} calls ${n(t2)} ${a.err}`,
		);
		const t3 = rnd("same");
		const c1 = await run("submit", t3),
			c2 = await run("submit", t3);
		const states = await Promise.all([c1, c2].map((x) => (x.j?.id ? waitState(x.j.id, ["completed"]) : null)));
		await sleep(300);
		rec(
			"identical_text_distinct_jobs",
			c1.j?.id && c2.j?.id && c1.j.id !== c2.j.id && n(t3) === 2 && states.every((s) => s?.result === sha(t3)),
			`ids ${c1.j?.id}/${c2.j?.id} calls ${n(t3)}`,
		);
		const t4 = rnd("drop");
		dropNext = true;
		const d1 = await run("submit", t4),
			injected = !dropNext;
		dropNext = false;
		const sd = d1.j?.id ? await waitState(d1.j.id, ["completed"]) : null;
		await sleep(100);
		rec(
			"retry_after_lost_response_no_duplicate",
			injected && d1.j?.id && n(t4) === 1 && sd?.result === sha(t4),
			`injected ${injected} out ${d1.out} err ${d1.err} calls ${n(t4)}`,
		);
		closeGate();
		const tx = rnd("blocker"),
			ty = rnd("victim");
		const x = await run("submit", tx);
		if (x.j?.id) await waitState(x.j.id, ["running"], 8000);
		const y = await run("submit", ty);
		const cy = y.j?.id ? await run("cancel", y.j.id) : { j: null };
		openGate();
		if (x.j?.id) await waitState(x.j.id, ["completed"]);
		await sleep(600);
		const sy = y.j?.id ? (await run("status", y.j.id)).j : null;
		rec(
			"queued_cancel_prevents_execution",
			cy.j?.state === "cancelled" && sy?.state === "cancelled" && n(ty) === 0,
			`cancel ${JSON.stringify(cy.j)} status ${JSON.stringify(sy)} calls ${n(ty)}`,
		);
		const cc = doneId ? await run("cancel", doneId) : { j: null };
		const sc = doneId ? (await run("status", doneId)).j : null;
		rec(
			"cancel_completed_preserved",
			cc.j?.state === "completed" && sc?.state === "completed" && sc.result === sha(t1),
			`${cc.out} ${JSON.stringify(sc)}`,
		);
		closeGate();
		const tr = rnd("rblock"),
			tq = rnd("queued");
		const r = await run("submit", tr);
		if (r.j?.id) await waitState(r.j.id, ["running"], 8000);
		const q = await run("submit", tq);
		await stop();
		openGate();
		while (active) await sleep(10);
		const up = await start();
		const sq = up && q.j?.id ? await waitState(q.j.id, ["completed"], 20000) : null;
		rec(
			"queued_survives_restart",
			sq?.state === "completed" && sq.result === sha(tq),
			`restart ${up} ${JSON.stringify(sq)} ${q.out} ${q.err}`,
		);

		rec("single_concurrency", peak === 1, `peak ${peak}`);
	} catch (e) {
		rec("grader_error", false, e?.stack || e);
	} finally {
		openGate();
		await stop();
		worker.close();
		proxy.close();
		fs.rmSync(dataDir, { recursive: true, force: true });
	}
	return finish();
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
	const projectDir = path.resolve(process.env.PROJECT_DIR || "/project");
	let result;
	result = await grade(projectDir);
	console.log(JSON.stringify(result));
	process.exit(0);
}
