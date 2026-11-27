import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";
import type { DbOwnerJobMetrics, DbOwnerRequest } from "./db-owner-protocol";

interface Operation {
	readonly kind: string;
	readonly lane: string;
	readonly access: "read" | "write";
	readonly operation: string;
	readonly tables: readonly string[];
	count: number;
	measured: number;
	busyMs: number;
	queueMs: number;
}
interface Profile {
	readonly operations: Map<string, Operation>;
	closed: boolean;
	dropped: number;
}
const profiles = new AsyncLocalStorage<Profile>();

export function observeRequestOwnerJob(
	request: DbOwnerRequest,
	lane: string,
	operation: string,
	enqueuedAt: number,
	metrics: Promise<DbOwnerJobMetrics | undefined>,
): void {
	const profile = profiles.getStore();
	if (!profile || profile.closed) return;
	const statements =
		request.kind === "query"
			? [request.statement]
			: request.kind === "batch"
				? request.statements
				: request.kind === "transaction"
					? request.transaction.statements
					: [];
	const tables = [
		...new Set(
			statements.flatMap((s) =>
				[...s.sql.slice(0, 2048).matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_][a-z_0-9]*)/gi)].map((m) =>
					(m[1] ?? "").replace(/__c.*$/, "__compartment"),
				),
			),
		),
	]
		.sort()
		.slice(0, 8);
	const label = operation.replace(/:\d+(?::\d+)?$/, "").slice(0, 100);
	const key = JSON.stringify([request.kind, lane, label, tables]);
	let sample = profile.operations.get(key);
	if (!sample) {
		if (profile.operations.size >= 32) {
			profile.dropped++;
			return;
		}
		sample = {
			kind: request.kind,
			lane,
			access:
				lane === "read" || (statements.length > 0 && statements.every((s) => s.readonly === true)) ? "read" : "write",
			operation: label,
			tables,
			count: 0,
			measured: 0,
			busyMs: 0,
			queueMs: 0,
		};
		profile.operations.set(key, sample);
	}
	sample.count++;
	const target = sample;
	void metrics.then((value) => {
		if (!value || profile.closed) return;
		target.measured++;
		target.busyMs += Math.max(0, value.finishedAt - value.startedAt);
		target.queueMs += Math.max(0, value.startedAt - enqueuedAt);
	});
}

export function withoutRequestOwnerProfile<T>(work: () => T): T {
	return profiles.exit(work);
}

export function ownerRequestProfiling(enabled: boolean): MiddlewareHandler {
	return async (c, next) => {
		if (!enabled) return await next();
		const profile: Profile = { operations: new Map(), closed: false, dropped: 0 };
		await profiles.run(profile, async () => {
			try {
				await next();
			} finally {
				profile.closed = true;
				if (c.res.status !== 401 && c.res.status !== 403 && c.res.status !== 404) {
					c.header("x-signet-owner-profile", JSON.stringify([...profile.operations.values()]));
					c.header("x-signet-owner-profile-dropped", String(profile.dropped));
				}
			}
		});
	};
}
