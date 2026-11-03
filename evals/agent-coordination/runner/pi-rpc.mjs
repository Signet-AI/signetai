// Minimal real Pi RPC client (strict LF-delimited JSONL; NOT readline). Spawns whatever command is given
// (host `pi` or `docker run ... pi --mode rpc`). Records each protocol record with a wall timestamp; cumulative update records are compacted after a raw leak scan.
// "prompt accepted" is never treated as completion; only `agent_settled` marks idle.
import { spawn } from "node:child_process";
import { sha256hex } from "../lib/common.mjs";

export const MAX_RPC_LINE_BYTES = 4 * 1024 * 1024;

const CUMULATIVE = new Set(["rpc_message_update", "rpc_tool_execution_update"]);

export function compactUpdate(rec) {
	if (rec.type === "message_update") {
		const { message, assistantMessageEvent: ame, ...rest } = rec;
		const { partial: _p, message: _m, ...delta } = ame ?? {};
		return { ...rest, message: message ? { role: message.role ?? null } : undefined, assistantMessageEvent: ame ? delta : undefined, compacted: true };
	}
	if (rec.type === "tool_execution_update") {
		const { partialResult, ...rest } = rec;
		return { ...rest, partialResultBytes: partialResult === undefined ? 0 : JSON.stringify(partialResult).length, compacted: true };
	}
	return rec;
}

export class PiRpc {
	constructor({ label, command, args, onRecord: sink, env, scan, scrubText, maxLineBytes = MAX_RPC_LINE_BYTES }) {
		this.label = label;
		const scanFn = scan ?? (() => []);
		this.scrubText = scrubText ?? ((t) => t);
		this.maxLineBytes = maxLineBytes;
		this.settledCount = 0;
		this.lastPartial = null;
		this.violated = false;
		this.onRecord = (r, source = r) => {
			const m = scanFn(source);
			sink(m.length && !r.leakMarkers ? { ...r, leakMarkers: m } : r);
		};
		const onRecord = this.onRecord;
		this.nextId = 1;
		this.pending = new Map();
		this.settledWaiters = [];
		this.buf = "";
		this.child = spawn(command, args, { env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (d) => this.#feed(d));
		this.errBuf = "";
		this.errSkip = false;
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (d) => this.#feedErr(d));
		const stderrDone = new Promise((r) => {
			this.child.stderr.once("end", r);
			this.child.stderr.once("close", r);
		});
		this.exited = new Promise((r) =>
			this.child.on("exit", async (code) => {
				// Let already-buffered stderr chunks arrive (bounded wait) before flushing the unterminated tail.
				await Promise.race([stderrDone, new Promise((t) => setTimeout(t, 1000).unref())]);
				this.#flushErr();
				this.#flushPartial("process_exit");
				r(code);
			}),
		);
	}
	#emitErr(line) {
		if (!line) return;
		this.onRecord({ src: "pi", type: "stderr", agent: this.label, wallMs: Date.now(), text: this.scrubText(line).slice(0, 2000) }, line);
	}
	#feedErr(chunk) {
		let data = this.errBuf + chunk;
		this.errBuf = "";
		let i;
		while ((i = data.search(/[\r\n]/)) >= 0) {
			const line = data.slice(0, i);
			data = data.slice(i + 1);
			if (this.errSkip) this.errSkip = false;
			else this.#emitErr(line);
		}
		if (this.errSkip) return;
		if (data.length > this.maxLineBytes) {
			// Scan the raw prefix before dropping it; persist only a marker-bearing placeholder, never the unknown raw tail.
			this.onRecord({ src: "pi", type: "stderr", agent: this.label, wallMs: Date.now(), text: "[stderr line exceeds bound; dropped]", oversize: true }, data);
			this.errSkip = true;
			return;
		}
		this.errBuf = data;
	}
	#flushErr() {
		const rest = this.errBuf;
		this.errBuf = "";
		if (!this.errSkip) this.#emitErr(rest);
	}
	#flushPartial(reason) {
		if (!this.lastPartial) return;
		const partial = this.lastPartial;
		this.lastPartial = null;
		this.onRecord({ src: "pi", type: "partial_snapshot", agent: this.label, wallMs: Date.now(), reason, message: partial });
	}
	#violate(reason, bytes) {
		if (this.violated) return;
		this.violated = true;
		this.buf = "";
		this.onRecord({ src: "infra", type: "error", class: "protocol", agent: this.label, message: reason, bytes, wallMs: Date.now() });
		this.child.kill("SIGKILL");
	}
	#feed(chunk) {
		if (this.violated) return;
		this.buf += chunk;
		let i;
		while ((i = this.buf.indexOf("\n")) >= 0) {
			let line = this.buf.slice(0, i);
			this.buf = this.buf.slice(i + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line) continue;
			if (Buffer.byteLength(line) > this.maxLineBytes) return this.#violate("rpc line exceeds bound", Buffer.byteLength(line));
			let rec;
			try {
				rec = JSON.parse(line);
			} catch {
				this.onRecord({ src: "pi", type: "unparseable", agent: this.label, wallMs: Date.now(), text: this.scrubText(line).slice(0, 500) }, line);
				continue;
			}
			this.#handle(rec);
		}
		if (this.buf.length > this.maxLineBytes) this.#violate("rpc buffer exceeds bound without newline", this.buf.length);
	}
	#handle(rec) {
		const wallMs = Date.now();
		const type = `rpc_${rec.type}`;
		if (CUMULATIVE.has(type)) {
			if (rec.type === "message_update" && rec.message) this.lastPartial = rec.message;
			this.onRecord({ src: "pi", type, agent: this.label, wallMs, raw: compactUpdate(rec) }, rec);
		} else {
			if (rec.type === "message_end") this.lastPartial = null;
			this.onRecord({ src: "pi", type, agent: this.label, wallMs, raw: rec });
		}
		if (rec.type === "response" && rec.id && this.pending.has(rec.id)) this.pending.get(rec.id)(rec);
		// Normalised events the grader consumes:
		if (rec.type === "agent_start") this.onRecord({ src: "pi", type: "agent_start", agent: this.label, wallMs });
		if (rec.type === "agent_settled") {
			this.settledCount++;
			this.#flushPartial("settled_without_message_end");
			this.onRecord({ src: "pi", type: "agent_settled", agent: this.label, wallMs });
			for (const w of this.settledWaiters.splice(0)) w();
		}
		if (rec.type === "tool_execution_start") this.onRecord({ src: "pi", type: "tool_call", agent: this.label, wallMs, name: rec.toolName, args: rec.args ?? null });
		if (rec.type === "tool_execution_end") this.onRecord({ src: "pi", type: "tool_result", agent: this.label, wallMs, name: rec.toolName, output: rec.result ?? null, error: rec.isError === true });
		if (rec.type === "auto_retry_start") this.onRecord({ src: "pi", type: "retry", agent: this.label, wallMs });
		if (rec.type === "message_end" && rec.message?.role === "assistant") {
			const m = rec.message;
			this.onRecord({ src: "pi", type: "model", agent: this.label, wallMs, requested: m.model ?? null, served: m.responseModel ?? null, provider: m.provider ?? null });
			if (m.usage) this.onRecord({ src: "pi", type: "usage", agent: this.label, wallMs, input: m.usage.input ?? null, output: m.usage.output ?? null, truncated: m.stopReason === "length" });
		}
	}
	send(cmd, timeoutMs = 30000) {
		const id = `${this.label}-${this.nextId++}`;
		const p = new Promise((res, rej) => {
			const t = setTimeout(() => (this.pending.delete(id), rej(new Error(`rpc timeout ${cmd.type}`))), timeoutMs);
			this.pending.set(id, (r) => (clearTimeout(t), this.pending.delete(id), res(r)));
		});
		this.child.stdin.write(`${JSON.stringify({ id, ...cmd })}\n`);
		return p;
	}
	async prompt(message, kind = "initial") {
		this.onRecord({ src: "runner", type: "prompt", agent: this.label, kind, promptSha256: sha256hex(message), wallMs: Date.now() });
		return this.send({ type: "prompt", message });
	}
	/** Latched: resolves at once if an agent_settled arrived after `sinceCount` (take it BEFORE prompting). */
	waitSettled(timeoutMs, sinceCount = this.settledCount) {
		if (this.settledCount > sinceCount) return Promise.resolve();
		return new Promise((res, rej) => {
			const t = setTimeout(() => rej(new Error("settle timeout")), timeoutMs);
			this.settledWaiters.push(() => (clearTimeout(t), res()));
		});
	}
	async stop() {
		try {
			await this.send({ type: "abort" }, 1500);
		} catch {}
		this.child.stdin.end();
		setTimeout(() => this.child.kill("SIGKILL"), 2000).unref();
		return this.exited;
	}
}
