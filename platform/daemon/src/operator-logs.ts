import { z } from "zod";
import { IdentityError } from "./auth/organization-store";
import { operatorActor, operatorRequest } from "./operator-jobs";
import type { Principal } from "./auth/principal";
import { logger, type LogEntry } from "./logger";
import { openBoundedSse } from "./sse-stream";

const query = z
	.object({
		limit: z.coerce.number().int().min(1).max(500).default(100),
		level: z.enum(["debug", "info", "warn", "error"]).optional(),
		category: z
			.string()
			.regex(/^[a-z][a-z-]{0,63}$/)
			.optional(),
		since: z.string().datetime({ offset: true }).optional(),
	})
	.strict();
const subscriptions = new Map<string, number>();
let active = 0;
function authorize(p: Principal): void {
	if (p.kind !== "user" || !p.permissions.has("admin") || !p.permissions.has("diagnostics"))
		throw new IdentityError(403, "permission", "Requires the admin role");
	if (p.boundAgentId !== null) throw new IdentityError(403, "agent_not_permitted");
	if (p.allowedProjects !== null) throw new IdentityError(403, "project_not_permitted");
}
function view(entry: LogEntry) {
	return {
		timestamp: entry.timestamp,
		level: entry.level,
		category: entry.category,
		message: "[content omitted in organization mode]",
		redacted: true,
	};
}
type LogAccess = { readonly compartments: "all" | readonly number[] };
function visible(entry: LogEntry, access: LogAccess): boolean {
	if (entry.data && Object.hasOwn(entry.data, "compartmentId")) {
		const compartment = entry.data.compartmentId;
		return (
			compartment === null ||
			(typeof compartment === "number" && (access.compartments === "all" || access.compartments.includes(compartment)))
		);
	}
	const data = entry.data;
	if (data && ["memoryId", "sourceId", "documentId", "entityId", "sessionKey"].some((key) => Object.hasOwn(data, key)))
		return false;
	return !/memory|pipeline|dreaming|source|classif|embedding|synthesis|document|transcript|reflection|session-memories/.test(
		entry.category,
	);
}
const recent: LogEntry[] = [];
const severity = { debug: 0, info: 1, warn: 2, error: 3 };
logger.on("log", (entry: LogEntry) => {
	if (!visible(entry, { compartments: [] })) return;
	recent.push(entry);
	if (recent.length > 500) recent.shift();
});
function accepts(entry: Pick<LogEntry, "timestamp" | "level" | "category">, options: z.infer<typeof query>): boolean {
	return (
		(!options.level || severity[entry.level] >= severity[options.level]) &&
		(!options.category || entry.category === options.category) &&
		(!options.since || entry.timestamp >= new Date(options.since).toISOString())
	);
}
function filters(input: unknown) {
	const parsed = query.safeParse(input);
	if (!parsed.success) throw new IdentityError(400, "invalid_log_query");
	return parsed.data;
}
export async function operatorLogSnapshot(p: Principal, input: unknown) {
	authorize(p);
	const options = filters(input);
	const access = await operatorRequest<LogAccess>({ op: "logs-access", actor: operatorActor(p), audit: true });
	const logs = recent
		.filter((entry) => visible(entry, access) && accepts(entry, options))
		.slice(-options.limit)
		.map(view);
	return { logs, count: logs.length, redacted: true };
}
export async function operatorLogStream(
	p: Principal,
	input: unknown,
	signal: AbortSignal,
	expiresAt?: number,
): Promise<Response> {
	authorize(p);
	const options = filters(input);
	if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now()))
		throw new IdentityError(401, "expired");
	const key = p.userId ?? p.credential.id;
	if (active >= 32 || (subscriptions.get(key) ?? 0) >= 2) throw new IdentityError(429, "log_capacity");
	active++;
	subscriptions.set(key, (subscriptions.get(key) ?? 0) + 1);
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		active--;
		const remaining = (subscriptions.get(key) ?? 1) - 1;
		if (remaining) subscriptions.set(key, remaining);
		else subscriptions.delete(key);
	};
	try {
		const access = await operatorRequest<LogAccess>({ op: "logs-access", actor: operatorActor(p), audit: true });
		return openBoundedSse({
			highWaterMarkBytes: 64 * 1024,
			maxFrameBytes: 1024,
			overflowPolicy: "close",
			heartbeat: { intervalMs: 10_000, comment: "operator log stream" },
			onStart(producer) {
				producer.addDisposer(release);
				const abort = () => producer.close();
				signal.addEventListener("abort", abort, { once: true });
				producer.addDisposer(() => signal.removeEventListener("abort", abort));
				if (signal.aborted) {
					producer.close();
					return;
				}
				let checking = false;
				const recheck = setInterval(() => {
					if (checking) return;
					checking = true;
					void operatorRequest<LogAccess>({ op: "logs-access", actor: operatorActor(p), audit: false })
						.then(
							(fresh) => {
								if (JSON.stringify(fresh) !== JSON.stringify(access)) {
									producer.write({ type: "error", reason: "scope_changed" });
									producer.close();
								}
							},
							() => {
								producer.write({ type: "error", reason: "scope_changed" });
								producer.close();
							},
						)
						.finally(() => {
							checking = false;
						});
				}, 2000);
				producer.addDisposer(() => clearInterval(recheck));
				let events = 0;
				const onLog = (entry: LogEntry) => {
					if (!visible(entry, access) || !accepts(entry, options)) return;
					producer.write(view(entry));
					if (++events >= options.limit) producer.close();
				};
				producer.addDisposer(() => logger.off("log", onLog));
				const timer = setTimeout(
					() => producer.close(),
					Math.min(60_000, expiresAt === undefined ? 60_000 : expiresAt - Date.now()),
				);
				producer.addDisposer(() => clearTimeout(timer));
				if (producer.signal.aborted) return;
				logger.on("log", onLog);
				producer.write({ type: "connected", redacted: true, maxDurationMs: 60_000, maxEvents: options.limit });
			},
		}).response;
	} catch (error) {
		release();
		throw error;
	}
}
