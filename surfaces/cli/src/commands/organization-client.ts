import { waitForOrganizationJob } from "./organization.js";
import type { NodeTransport } from "../../../../libs/sdk/src/node.js";
import { SignetError, SignetUnauthorizedError } from "../../../../libs/sdk/src/index.js";

interface Identity {
	readonly authenticated: boolean;
	readonly mode: string;
	readonly organization: { readonly name: string } | null;
	readonly user: { readonly email?: string | null; readonly username: string } | null;
	readonly agents: { readonly defaultRead: string | null };
	readonly credential: { readonly expiresAt: string | null } | null;
}
export async function organizationStatus(
	transport: NodeTransport,
	json = false,
	print: (value: string) => void = console.log,
): Promise<void> {
	const identity = await transport.get<Identity>("/api/auth/whoami");
	if (!identity.authenticated) throw new SignetUnauthorizedError("missing_credential");
	if (!json) {
		const remaining = identity.credential?.expiresAt
			? Math.max(0, Date.parse(identity.credential.expiresAt) - Date.now())
			: null;
		const expires =
			remaining === null
				? "unknown"
				: remaining >= 86400_000
					? `${Math.floor(remaining / 86400_000)}d`
					: `${Math.floor(remaining / 60_000)}m`;
		print(
			`${identity.organization?.name ?? "Signet"} (${identity.mode}) · ${identity.user?.email ?? identity.user?.username ?? "unknown"} · agent: ${identity.agents.defaultRead ?? "unknown"} · session expires in ${expires}`,
		);
	}
	const status = await transport.get("/api/status");
	print(JSON.stringify({ identity, status }, null, json ? undefined : 2));
}
export async function organizationDashboard(
	transport: NodeTransport,
	url: string,
	nonInteractive: boolean,
	open: (url: string) => Promise<unknown>,
): Promise<void> {
	if (nonInteractive) throw new Error("Dashboard opening is disabled by --non-interactive");
	const handoff = await transport.post<{ code: string; expiresAt: string }>("/api/auth/handoff", {});
	if (!/^[A-Za-z0-9_-]{1,256}$/.test(handoff.code) || Date.parse(handoff.expiresAt) <= Date.now())
		throw new Error("Invalid dashboard handoff");
	const destination = new URL(url);
	destination.hash = `handoff=${handoff.code}`;
	destination.search = "";
	await open(destination.href);
}

export async function organizationRestart(transport: NodeTransport, options: { json?: boolean; wait?: boolean }) {
	const capability = await transport.get<{ restart: boolean }>("/api/org/operator/capabilities");
	if (!capability.restart)
		throw new SignetError(
			"This daemon has no verified supervisor. Restart it on the instance host.",
			"supervisor_required",
		);
	const result = await transport.post<{ jobId: string }>("/api/org/operator/restart", {});
	console.log(
		JSON.stringify(
			options.wait ? await waitForOrganizationJob(transport, result.jobId) : result,
			null,
			options.json ? undefined : 2,
		),
	);
}
export async function organizationPause(
	transport: NodeTransport,
	paused: boolean,
	json = false,
	print: (value: string) => void = console.log,
): Promise<void> {
	const result = await transport.post<{ success: boolean; paused: boolean }>(
		`/api/pipeline/${paused ? "pause" : "resume"}`,
		{},
	);
	if (result.success !== true || result.paused !== paused)
		throw new Error("The instance did not confirm the pipeline transition");
	print(json ? JSON.stringify(result) : `Organization workers ${paused ? "paused" : "resumed"}.`);
}
