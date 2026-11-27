import { attributeResults, printResultAttribution, resultField } from "../lib/result-attribution.js";
import { SignetError, SignetNetworkError, SignetTimeoutError } from "../../../../libs/sdk/src/index.js";
import { Command } from "commander";
import type { NodeTransport } from "../../../../libs/sdk/src/node.js";
import { cliTransport } from "../lib/organization-target.js";
import { authTransport, reportAuthError, type AuthCommandDeps } from "./auth.js";

interface Options {
	url?: string;
	json?: boolean;
	wait?: boolean;
	confirm?: boolean;
	mode?: string;
	transferTo?: string;
	email?: string;
	role?: string;
	team?: string[];
	actor?: string;
	action?: string;
	since?: string;
	as?: string;
	agent?: string;
	audience?: string[];
}
export async function waitForOrganizationJob(
	transport: NodeTransport,
	jobId: string,
	timeoutMs = 300_000,
): Promise<unknown> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const job = await transport
			.get<{ status: string; error?: string }>(`/api/org/jobs/${encodeURIComponent(jobId)}`, {
				timeoutMs: Math.min(10000, Math.max(1, deadline - Date.now())),
			})
			.catch((error: unknown) => {
				if (error instanceof SignetNetworkError || error instanceof SignetTimeoutError) return null;
				throw error;
			});
		if (!job) {
			await new Promise<void>((resolve) => setTimeout(resolve, 250));
			continue;
		}
		if (job.status === "complete") return job;
		if (job.status === "failed" || job.status === "cancelled" || job.status === "incomplete")
			throw new SignetError(
				`Job ${jobId} ${job.status}: ${job.error ?? "operation did not complete"}`,
				`job_${job.status}`,
			);
		await new Promise<void>((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Timed out waiting for ${jobId}; the job may still be running. Check signet org jobs ${jobId}.`);
}
export function registerOrganizationCommands(program: Command, deps: AuthCommandDeps = {}): void {
	const print = deps.print ?? console.log;
	const standard = (command: Command) =>
		command.option("--url <url>", "Instance URL").option("--json", "Machine-readable output");
	const run =
		(work: (transport: NodeTransport, opts: Options, args: readonly string[]) => Promise<unknown>) =>
		async (...args: unknown[]) => {
			const command = args.at(-1);
			if (!(command instanceof Command)) throw new Error("Missing command context");
			const opts = command.optsWithGlobals<Options>();
			try {
				const transport = cliTransport() ?? (await authTransport(opts, deps));
				const result = await work(
					transport,
					opts,
					args.filter((arg): arg is string => typeof arg === "string"),
				);
				if (command.name() === "audit" && !opts.json && typeof result === "object" && result !== null) {
					const entries: unknown = Reflect.get(result, "events");
					if (Array.isArray(entries)) {
						for (const row of await attributeResults(
							entries.filter((item: unknown): item is object => typeof item === "object" && item !== null),
							(body) => transport.post("/api/result-attribution", body),
						)) {
							print(`${resultField(row, "at", "created_at", "createdAt") ?? ""} ${resultField(row, "action") ?? ""}`);
							printResultAttribution(row, print);
						}
						return;
					}
				}
				print(JSON.stringify(result, null, opts.json ? undefined : 2));
			} catch (error) {
				reportAuthError(error, opts.json);
			}
		};
	const org = program.command("org").description("Organization administration");
	const users = org.command("users").description("Manage organization users");
	const encoded = (args: readonly string[], index = 0) => encodeURIComponent(args[index] ?? "");
	standard(users.command("list")).action(run((transport) => transport.get("/api/org/users")));
	standard(users.command("invite"))
		.option("--email <email>", "Invite email")
		.option("--role <role>", "Organization role", "member")
		.option("--team <ids...>", "Team IDs")
		.action(
			run((transport, opts) =>
				transport.post("/api/org/invites", { email: opts.email, role: opts.role, groupIds: opts.team ?? [] }),
			),
		);
	standard(users.command("role <user> <role>")).action(
		run((transport, _opts, args) =>
			transport.request("PATCH", `/api/org/users/${encoded(args)}`, { body: { role: args[1] } }),
		),
	);
	standard(users.command("reactivate <user>")).action(
		run((transport, _opts, args) => transport.post(`/api/org/users/${encoded(args)}/reactivate`, {})),
	);
	const teams = org.command("teams").description("Manage teams");
	standard(teams.command("list")).action(run((transport) => transport.get("/api/org/groups")));
	standard(teams.command("create <name>")).action(
		run((transport, _opts, args) => transport.post("/api/org/groups", { name: args[0] })),
	);
	standard(teams.command("show <team>")).action(
		run((transport, _opts, args) => transport.get(`/api/org/groups/${encoded(args)}`)),
	);
	standard(teams.command("delete <team>")).action(
		run((transport, _opts, args) => transport.request("DELETE", `/api/org/groups/${encoded(args)}`)),
	);
	standard(teams.command("rename <team> <name>")).action(
		run((transport, _opts, args) =>
			transport.request("PATCH", `/api/org/groups/${encoded(args)}`, { body: { name: args[1] } }),
		),
	);
	standard(teams.command("add <team> <user>"))
		.option("--role <role>", "Team role", "member")
		.action(
			run((transport, opts, args) =>
				transport.request("PUT", `/api/org/groups/${encoded(args)}/members/${encoded(args, 1)}`, {
					body: { role: opts.role },
				}),
			),
		);
	standard(teams.command("remove <team> <user>")).action(
		run((transport, _opts, args) =>
			transport.request("DELETE", `/api/org/groups/${encoded(args)}/members/${encoded(args, 1)}`),
		),
	);
	standard(org.command("access <user>")).action(
		run((transport, _opts, args) => transport.get(`/api/org/access/${encoded(args)}`)),
	);
	standard(org.command("jobs [id]")).action(
		run((transport, _opts, args) => transport.get(`/api/org/jobs${args[0] ? `/${encoded(args)}` : ""}`)),
	);
	standard(program.command("audit"))
		.option("--actor <id>", "Actor user ID")
		.option("--action <action>", "Audit action")
		.option("--since <iso>", "Inclusive UTC timestamp")
		.action(
			run((transport, opts) => {
				const query = new URLSearchParams();
				for (const key of ["actor", "action", "since"] as const) if (opts[key]) query.set(key, opts[key]);
				return transport.get(`/api/org/audit${query.size ? `?${query}` : ""}`);
			}),
		);
	const agents = org.command("agents").description("Inspect organization agents");
	standard(agents.command("list")).action(run((transport) => transport.get("/api/agents")));
	const classification = program.command("classification").description("Manage classifications");
	const audience = (values: readonly string[] | undefined) =>
		(values ?? []).map((value) => {
			const separator = value.indexOf(":");
			const kind = value.slice(0, separator);
			const id = value.slice(separator + 1);
			if (separator < 1 || !id || (kind !== "user" && kind !== "group"))
				throw new Error("Audience must be user:<id> or group:<id>");
			return { kind, id };
		});
	standard(classification.command("list")).action(run((transport) => transport.get("/api/classifications")));
	standard(classification.command("create <name>"))
		.option("--audience <principals...>", "user:<id> or group:<id>")
		.action(
			run((transport, opts, args) =>
				transport.post("/api/classifications", { name: args[0], audience: audience(opts.audience) }),
			),
		);
	standard(classification.command("audience <id>"))
		.requiredOption("--audience <principals...>", "Replace audience: user:<id> or group:<id>")
		.action(
			run((transport, opts, args) =>
				transport.request("PUT", `/api/classifications/${encoded(args)}/audience`, { body: audience(opts.audience) }),
			),
		);
	standard(program.command("classify <target>"))
		.requiredOption("--as <classification>", "Classification name or ID")
		.option("--agent <id>", "Target agent ID")
		.option("--wait", "Wait for classification completion")
		.action(
			run(async (transport, opts, args) => {
				const input = args[0] ?? "";
				const separator = input.indexOf(":");
				const kind = input.slice(0, separator);
				const id = input.slice(separator + 1);
				if (separator < 1 || !id || !["memory", "session", "source", "agent"].includes(kind))
					throw new Error("Use memory:<id>, session:<key>, source:<id>, or agent:<id>");
				const definitions = await transport.get<{ id: string; name: string }[]>("/api/classifications");
				const classification = definitions.find((item) => item.id === opts.as || item.name === opts.as);
				if (!classification) throw new Error("Classification not found");
				const path = `/api/classifications/${encodeURIComponent(classification.id)}`;
				const target = { kind, id, agentId: opts.agent };
				const preview = await transport.post(`${path}/preview`, { target });
				if (!opts.json) print(`Impact: ${JSON.stringify(preview)}`);
				const job = await transport.post<{ jobId: string }>(`${path}/apply`, { target });
				return { preview, ...job, ...(opts.wait ? { job: await waitForOrganizationJob(transport, job.jobId) } : {}) };
			}),
		);
	standard(users.command("deactivate <user>"))
		.option("--mode <mode>", "keep, transfer or purge", "keep")
		.option("--transfer-to <user>", "New owner of the user's agents")
		.option("--confirm", "Execute the offboarding plan")
		.option("--wait", "Wait for the tracked job")
		.action(
			run(async (transport, opts, args) => {
				const result = await transport.post<{ jobId?: string }>(
					`/api/org/users/${encodeURIComponent(args[0] ?? "")}/deactivate`,
					{ mode: opts.mode, transferTo: opts.transferTo, dryRun: opts.confirm !== true },
				);
				if (opts.wait && result.jobId) return waitForOrganizationJob(transport, result.jobId);
				return result;
			}),
		);
}
