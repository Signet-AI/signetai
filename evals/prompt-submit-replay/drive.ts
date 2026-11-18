import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Message = { readonly customType?: string; readonly content?: unknown };
type OpencodeHooks = Record<string, ((input: unknown, output: unknown) => Promise<unknown>) | undefined>;
type OpencodePlugin = { readonly SignetPlugin: (input: unknown) => Promise<OpencodeHooks> };
type PiExtension = { readonly default: (api: unknown) => void };

const [run, port, session] = process.argv.slice(2);
if (!run || !port || !session) throw new Error("usage: bun drive.ts <run> <port> <pi|opencode>");
const dir = resolve(process.env.REPLAY_DIR ?? join(import.meta.dir, "runs"));
const realHome = process.env.REAL_HOME ?? process.env.HOME ?? "";
const sandboxHome = join(dir, "home");
const opencodePlugin = process.env.OPENCODE_PLUGIN ?? join(realHome, ".config/opencode/plugins/signet.mjs");
const piExtension = process.env.PI_EXTENSION ?? join(realHome, ".pi/agent/extensions/signet-pi.js");
const agentId = process.env.REPLAY_AGENT_ID ?? "default";

mkdirSync(sandboxHome, { recursive: true });
for (const key of Object.keys(process.env)) {
	if (/^(SIGNET|HERMES|XDG|PI|OPENCODE|CLAUDE|CODEX)_/.test(key)) delete process.env[key];
}
Object.assign(process.env, {
	HOME: sandboxHome,
	XDG_CONFIG_HOME: join(sandboxHome, ".config"),
	XDG_DATA_HOME: join(sandboxHome, ".local/share"),
	XDG_STATE_HOME: join(sandboxHome, ".local/state"),
	XDG_CACHE_HOME: join(sandboxHome, ".cache"),
	HERMES_HOME: join(sandboxHome, ".hermes"),
	SIGNET_AGENT_ID: agentId,
	SIGNET_DAEMON_URL: `http://127.0.0.1:${port}`,
	SIGNET_PATH: join(dir, "ws"),
	SIGNET_TELEMETRY_OPTOUT: "1",
});

const transcripts = JSON.parse(readFileSync(join(dir, "transcripts.json"), "utf8"));
const turns: readonly string[] = transcripts[session]?.turns ?? [];
const out = join(dir, `results-${run}.jsonl`);

const pinned = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("SIGNET_")));

function isOpencodePlugin(value: unknown): value is OpencodePlugin {
	return (
		typeof value === "object" && value !== null && "SignetPlugin" in value && typeof value.SignetPlugin === "function"
	);
}

function isPiExtension(value: unknown): value is PiExtension {
	return typeof value === "object" && value !== null && "default" in value && typeof value.default === "function";
}

function isMessage(value: unknown): value is Message {
	return typeof value === "object" && value !== null;
}

async function importConnector(path: string): Promise<unknown> {
	const connector = await import(path);
	const changed = Object.keys(process.env)
		.filter((key) => key.startsWith("SIGNET_"))
		.filter((key) => process.env[key] !== pinned[key]);
	if (changed.length > 0) {
		throw new Error(`${path} rebinds ${changed.join(", ")} at import; reinstall it without baked settings to replay`);
	}
	return connector;
}

function record(sessionKey: string, turn: number, kind: string, text: string): void {
	appendFileSync(out, `${JSON.stringify({ run, harness: session, sessionKey, turn, kind, text })}\n`);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

function messagesOf(results: readonly unknown[]): Message[] {
	return results.flatMap((result) =>
		result && typeof result === "object" && "messages" in result && Array.isArray(result.messages)
			? result.messages
			: [],
	);
}

async function runOpencode(): Promise<void> {
	const plugin = await importConnector(opencodePlugin);
	if (!isOpencodePlugin(plugin)) throw new Error(`${opencodePlugin} does not export SignetPlugin`);
	const sessionID = `${run}-${session}`;
	const hooks = await plugin.SignetPlugin({ directory: sandboxHome, client: {} });
	const system: string[] = [];
	const hook = (name: string) => {
		const fn = hooks[name];
		if (!fn) throw new Error(`${opencodePlugin} has no ${name} hook`);
		return fn;
	};
	await hooks["experimental.chat.system.transform"]?.({ sessionID }, { system });
	record(sessionID, 0, "session-start", system.join("\n"));
	for (const [index, turn] of turns.entries()) {
		const messageID = `${sessionID}-m${index + 1}`;
		await hook("chat.message")(
			{ sessionID, messageID },
			{ message: { id: messageID }, parts: [{ type: "text", text: turn }] },
		);
		const messages = [{ info: { id: messageID, role: "user", sessionID }, parts: [{ type: "text", text: turn }] }];
		await hook("experimental.chat.messages.transform")({}, { messages });
		const delivered = messages[0]?.parts[0]?.text ?? "";
		record(sessionID, index + 1, "prompt", delivered.replace(turn.trim(), "").trim());
	}
}

async function runPi(): Promise<void> {
	const extension = await importConnector(piExtension);
	if (!isPiExtension(extension)) throw new Error(`${piExtension} has no default export`);
	const handlers = new Map<string, Handler[]>();
	const sent: Message[] = [];
	const history: unknown[] = [];
	const api = new Proxy(
		{
			on(name: string, fn: Handler): void {
				handlers.set(name, [...(handlers.get(name) ?? []), fn]);
			},
			sendMessage(message: Message): void {
				sent.push(message);
			},
		},
		{ get: (target, key) => (key in target ? Reflect.get(target, key) : () => undefined) },
	);
	extension.default(api);
	const sessionId = `${run}-${session}`;
	const ctx = {
		cwd: sandboxHome,
		mode: "print",
		hasUI: false,
		ui: { notify() {}, setStatus() {}, theme: { fg: (_color: string, text: string) => text } },
		sessionManager: {
			getHeader: () => ({ id: sessionId, cwd: sandboxHome }),
			getSessionId: () => sessionId,
			getSessionFile: () => undefined,
			getSessionName: () => undefined,
			getEntries: () => [],
			getBranch: () => [],
			buildSessionContext: () => ({ messages: history }),
		},
	};
	const fire = async (name: string, event: unknown): Promise<unknown[]> => {
		const results: unknown[] = [];
		for (const fn of handlers.get(name) ?? []) results.push(await fn(event, ctx));
		return results;
	};
	const delivered = async (name: string, event: unknown): Promise<Message[]> => {
		const results = await fire(name, event);
		const returned = results.flatMap((result) =>
			result && typeof result === "object" && "message" in result && isMessage(result.message) ? [result.message] : [],
		);
		return [...messagesOf(results), ...returned, ...sent.splice(0)];
	};
	await fire("session_start", {});
	const start = await delivered("context", { messages: [] });
	record(sessionId, 0, "session-start", start.map((message) => textOf(message.content)).join("\n"));
	for (const [index, turn] of turns.entries()) {
		history.push({ role: "user", content: turn });
		await fire("input", { text: turn, source: "interactive" });
		const injected = [
			...(await delivered("before_agent_start", { prompt: turn, systemPrompt: "" })),
			...(await delivered("context", { messages: [] })),
		];
		history.push(...injected.map((message) => ({ role: "custom", ...message })));
		const text = injected
			.filter((message) => message.customType?.startsWith("signet-pi-"))
			.map((message) => textOf(message.content))
			.join("\n");
		record(sessionId, index + 1, "prompt", text);
	}
}

const harness = transcripts[session]?.harness;
if (harness === "opencode") await runOpencode();
else if (harness === "pi") await runPi();
else throw new Error(`${session}: ${harness} is driven by drive.py`);
console.error(`${run} ${session} done`);
process.exit(0);
