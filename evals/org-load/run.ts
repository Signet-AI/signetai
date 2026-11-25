import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createToken } from "../../platform/daemon/src/auth/tokens";
import { OrgDaemon } from "../../tests/integration/org-mode/daemon";
import { Fixture, type User } from "../../tests/integration/org-mode/fixture";
import { record, request, success, type Credential } from "../../tests/integration/org-mode/http";

interface Sample {
	ms: number;
	status: number;
	error: string | null;
}
type Developer = Pick<User, "name" | "agentId" | "connector">;
export function percentile(values: readonly number[], p: number): number | null {
	assert(p > 0 && p <= 1);
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
}
export function summarize(samples: readonly Sample[]) {
	const latencies = samples.map((sample) => sample.ms);
	const errors: Record<string, number> = {};
	for (const sample of samples) if (sample.error) errors[sample.error] = (errors[sample.error] ?? 0) + 1;
	return {
		requests: samples.length,
		errors: samples.filter((sample) => sample.error !== null).length,
		errorCounts: errors,
		p50Ms: percentile(latencies, 0.5),
		p95Ms: percentile(latencies, 0.95),
		p99Ms: percentile(latencies, 0.99),
	};
}
function argument(name: string, fallback: number): number {
	const index = process.argv.indexOf(name);
	const value = index < 0 ? fallback : Number(process.argv[index + 1]);
	assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
	return value;
}
async function baseline(daemon: OrgDaemon, developers: number): Promise<{ users: Developer[]; admin: Credential }> {
	const secret = await readFile(join(daemon.workspace, "runtime/auth-secret"));
	const admin = { bearer: createToken(secret, { sub: "load-control", role: "admin", scope: {} }, 3600) };
	const users: Developer[] = [];
	for (let index = 0; index < developers; index++) {
		const name = `load-dev-${index}`;
		success(await request(daemon.origin, "/api/agents", admin, "POST", { name }), "baseline POST /api/agents");
		users.push({
			name,
			agentId: name,
			connector: { bearer: createToken(secret, { sub: name, role: "agent", scope: { agent: name } }, 3600) },
		});
	}
	return { users, admin };
}
export async function run(): Promise<void> {
	const developers = argument("--developers", 50);
	const iterations = argument("--iterations", 20);
	const endEvery = argument("--session-end-every", 5);
	const thinkMs = argument("--think-ms", 100);
	assert(
		developers <= 2000 && developers * iterations <= 100_000,
		"Load admission limit: <=2000 developers and <=100000 developer-iterations",
	);
	const daemon = await OrgDaemon.create();
	const routes = new Map<string, Sample[]>();
	const queue: {
		observedAt: string;
		status: number;
		queuedJobs: number | null;
		owner: unknown;
		error: string | null;
	}[] = [];
	let sampling = true;
	let interrupted = false;
	const interrupt = () => {
		interrupted = true;
		sampling = false;
	};
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", interrupt);
	let sampleTask: Promise<void> | undefined;
	try {
		const isBaseline = process.argv.includes("--baseline");
		const model = process.argv.includes("--single") ? "single" : "personal";
		let users: Developer[];
		let admin: Credential;
		if (isBaseline) ({ users, admin } = await baseline(daemon, developers));
		else {
			const fixture = await Fixture.create(daemon, model);
			admin = fixture.admin;
			users = [];
			for (let index = 0; index < developers && !interrupted; index++)
				users.push(await fixture.invite(`dev-${index}`, [fixture.engId]));
		}
		const call = async (path: string, user: Developer, body: object) => {
			const start = performance.now();
			let status = 0;
			let error: string | null = null;
			try {
				const reply = await request(daemon.origin, path, user.connector, "POST", body);
				status = reply.status;
				if (status < 200 || status >= 300) error = `http_${status}`;
				else if (record(reply.body).error) error = "semantic_error";
			} catch (failure) {
				error = failure instanceof Error ? failure.name : "transport_error";
			}
			const samples = routes.get(path) ?? [];
			samples.push({ ms: performance.now() - start, status, error });
			routes.set(path, samples);
		};
		sampleTask = (async () => {
			while (sampling) {
				try {
					const reply = await request(daemon.origin, "/health", admin);
					const owner = record(reply.body).dbOwner;
					const depth = owner !== null && typeof owner === "object" ? record(owner).queuedJobs : null;
					queue.push({
						observedAt: new Date().toISOString(),
						status: reply.status,
						queuedJobs: typeof depth === "number" ? depth : null,
						owner,
						error: reply.status !== 200 ? `http_${reply.status}` : null,
					});
				} catch (error) {
					queue.push({
						observedAt: new Date().toISOString(),
						status: 0,
						queuedJobs: null,
						owner: null,
						error: error instanceof Error ? error.name : "transport_error",
					});
				}
				if (queue.length >= 3600) sampling = false;
				await Bun.sleep(1000);
			}
		})();
		const startedAt = performance.now();
		let completedIterations = 0;
		await Promise.all(
			users.map(async (user) => {
				let session = 0;
				const payload = () => ({
					harness: "codex",
					agentId: user.agentId,
					sessionKey: `org-load-${user.name}-${session}`,
					project: "atlas",
				});
				await call("/api/hooks/session-start", user, payload());
				for (let iteration = 0; iteration < iterations && !interrupted; iteration++) {
					await call("/api/hooks/user-prompt-submit", user, {
						...payload(),
						userMessage: "What do we know about atlas storage and release?",
					});
					await call("/api/memory/remember", user, {
						agentId: user.agentId,
						project: "atlas",
						content: `Atlas ${user.name} iteration ${iteration} validated component ${iteration} with test result ${user.name}-${iteration}.`,
						type: "fact",
					});
					if ((iteration + 1) % endEvery === 0 || iteration === iterations - 1) {
						await call("/api/hooks/session-end", user, {
							...payload(),
							transcript: `User: Atlas ${user.name} completed iteration ${iteration}.\nAssistant: Verified.`,
							lastAssistantMessage: "Verified.",
						});
						if (iteration < iterations - 1) {
							session++;
							await call("/api/hooks/session-start", user, payload());
						}
					}
					completedIterations++;
					await Bun.sleep(thinkMs);
				}
			}),
		);
		sampling = false;
		await sampleTask;
		const report = {
			mode: isBaseline ? "legacy-agent-control-not-org-proof" : "organization",
			developers,
			provisionedDevelopers: users.length,
			iterations,
			completedIterations,
			interrupted,
			agentModel: isBaseline ? null : model,
			runtime: process.env.SIGNET_DAEMON_BIN ? "compiled" : "source",
			elapsedMs: performance.now() - startedAt,
			routes: Object.fromEntries([...routes].map(([path, samples]) => [path, summarize(samples)])),
			dbOwnerQueue: {
				endpoint: "/health",
				metric: "dbOwner.queuedJobs",
				available: queue.some((sample) => sample.queuedJobs !== null),
				samples: queue,
			},
		};
		const index = process.argv.indexOf("--out");
		if (index >= 0) {
			const path = process.argv[index + 1];
			assert(path);
			await writeFile(path, JSON.stringify(report, null, 2));
		}
		console.log(JSON.stringify(report, null, 2));
	} finally {
		sampling = false;
		try {
			await sampleTask;
		} finally {
			process.removeListener("SIGINT", interrupt);
			process.removeListener("SIGTERM", interrupt);
			await daemon.dispose();
		}
	}
}
if (import.meta.main) await run();
