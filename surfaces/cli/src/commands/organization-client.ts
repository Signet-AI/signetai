import type { NodeTransport } from "../../../../libs/sdk/src/node.js";
import { SignetUnauthorizedError } from "../../../../libs/sdk/src/index.js";

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
