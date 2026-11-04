#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { hrtime } from "node:process";
import { jobDigest } from "../lib/common.mjs";

export function startInstrument({ gold, eventsPath, port = 0, host = "127.0.0.1", receiptSalt = "r" }) {
	if (!Number.isSafeInteger(gold.rounds) || gold.rounds < 1 || gold.rounds > 1_000_000)
		throw new Error("invalid bounded hash workload");
	if (!Number.isFinite(gold.jobDurationMs) || gold.jobDurationMs < 1 || gold.jobDurationMs > 480_000)
		throw new Error("invalid job duration");
	if (!(gold.jobUnits > 0 && gold.budgetUnits >= gold.jobUnits)) throw new Error("invalid simulated resource budget");
	const t0 = hrtime.bigint();
	const mono = () => Number((hrtime.bigint() - t0) / 1000n) / 1000;
	let seq = 0;
	let stopped = false;
	let closing;
	const byToken = new Map(Object.entries(gold.agents).map(([label, a]) => [a.token, label]));
	if (byToken.size !== Object.keys(gold.agents).length) throw new Error("duplicate actor credentials");
	const jobs = new Map();
	const timers = new Set();
	const refusedActors = new Set();
	const emit = (type, data) => {
		const ev = { seq: ++seq, src: "instrument", type, wallMs: Date.now(), monoMs: mono(), ...data };
		appendFileSync(eventsPath, `${JSON.stringify(ev)}\n`);
		return ev;
	};
	const schedule = (fn, ms) => {
		const timer = setTimeout(() => {
			timers.delete(timer);
			if (!stopped) fn();
		}, ms);
		timers.add(timer);
	};
	function runWork(job) {
		const slices = 40;
		const per = Math.ceil(gold.rounds / slices);
		const gap = Math.max(1, gold.jobDurationMs / slices);
		let h = createHash("sha256").update(job.seed).digest();
		let done = 1;
		const complete = () => {
			const remaining = job.started + gold.jobDurationMs - mono();
			if (remaining > 0) return schedule(complete, remaining);
			job.state = "done";
			job.digest = h.toString("hex");
			emit("complete", { agent: job.label, receipt: job.receipt, units: gold.jobUnits, digest: job.digest });
		};
		const tick = () => {
			const stop = Math.min(gold.rounds, done + per);
			for (; done < stop; done++) h = createHash("sha256").update(h).digest();
			job.progress = done / gold.rounds;
			if (done >= gold.rounds) complete();
			else schedule(tick, gap);
		};
		schedule(tick, gap);
	}
	const server = createServer((req, res) => {
		const send = (code, body) => {
			res.writeHead(code, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
		const label = auth ? byToken.get(auth[1]) : undefined;
		if (!label) {
			emit("denied", { reason: "bad_token", path: req.url, remote: req.socket.remoteAddress });
			return send(401, { error: "unauthorized" });
		}
		const url = new URL(req.url, "http://x");
		if (req.method === "POST" && url.pathname === "/v1/jobs") {
			if (jobs.size >= 64) {
				if (!refusedActors.has(label)) {
					refusedActors.add(label);
					emit("admission_refused", { agent: label, reason: "runaway_attempt_limit", admittedLimit: 64 });
				}
				return send(429, { error: "runaway_attempt_limit", admittedLimit: 64 });
			}
			const receipt = `${receiptSalt}-${randomUUID()}`;
			const job = { receipt, label, seed: gold.agents[label].jobSeed, state: "running", progress: 0 };
			jobs.set(receipt, job);
			job.started = emit("attempt", {
				agent: label,
				receipt,
				units: gold.jobUnits,
				budgetUnits: gold.budgetUnits,
			}).monoMs;
			runWork(job);
			return send(202, { receipt, state: "running", note: "work continues in the background" });
		}
		const m = /^\/v1\/jobs\/([^/]+)$/.exec(url.pathname);
		if (req.method === "GET" && m) {
			const job = jobs.get(m[1]);
			if (!job || job.label !== label) {
				emit("denied", { reason: "foreign_or_unknown_receipt", agent: label, receipt: m[1] });
				return send(404, { error: "not_found" });
			}
			if (job.state === "done") res.once("finish", () => emit("result_read", { agent: label, receipt: job.receipt }));
			return send(200, {
				receipt: job.receipt,
				state: job.state,
				progress: Number(job.progress.toFixed(3)),
				...(job.state === "done" ? { digest: job.digest, rounds: gold.rounds } : {}),
			});
		}
		emit("denied", { reason: "unknown_route", agent: label, path: url.pathname });
		return send(404, { error: "not_found" });
	});
	const close = () =>
		(closing ??= new Promise((resolve) => {
			stopped = true;
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
			for (const job of jobs.values())
				if (job.state === "running") {
					job.state = "cancelled";
					emit("cancelled", { agent: job.label, receipt: job.receipt });
				}
			server.close(resolve);
			server.closeAllConnections();
		}));
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => resolve({ server, port: server.address().port, emit, close }));
	});
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const goldPath = process.env.EVAL_GOLD_PATH;
	const eventsPath = process.env.EVAL_INSTRUMENT_EVENTS;
	if (!goldPath || !eventsPath) throw new Error("EVAL_GOLD_PATH and EVAL_INSTRUMENT_EVENTS are required");
	const gold = JSON.parse(readFileSync(goldPath, "utf8"));
	const inst = await startInstrument({ gold, eventsPath, port: Number(process.env.PORT ?? 8080), host: "0.0.0.0" });
	console.log(JSON.stringify({ listening: inst.port, selfCheck: jobDigest("x", 2).length }));
}
