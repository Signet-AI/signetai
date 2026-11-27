import { attempt } from "@signet/core/attempt";
import { type FormEvent, type ReactNode, useState } from "react";
import { SignetMark } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { PageHeading } from "@/components/dashboard/heading";
import { Panel } from "@/components/shell/panel";
import { getJSONResult } from "@/lib/api";
import { refreshSession, useWhoami } from "@/lib/session";
import { usePanelQuery } from "@/lib/use-panel-query";

export function authEntryKind(path: string, mode: string): "claim" | "invite" | "device" | null {
	if (mode !== "team") return null;
	if (path === "/auth/setup" || path === "/auth/claim") return "claim";
	if (path === "/auth/invite" || path.startsWith("/auth/invite/")) return "invite";
	return path === "/auth/device" ? "device" : null;
}

export function AuthPage({
	title,
	description,
	organizationName,
	instanceOrigin = typeof location === "undefined" ? "" : location.origin,
	children,
}: {
	readonly title: string;
	readonly description: string;
	readonly organizationName?: string;
	readonly instanceOrigin?: string;
	readonly children?: ReactNode;
}) {
	return (
		<section className="settings-page">
			{organizationName && (
				<header className="flex shrink-0 items-center gap-2.5">
					<SignetMark className="h-6 w-5 shrink-0" aria-label="Signet" />
					<span className="text-[15px] font-medium tracking-tight">Signet</span>
				</header>
			)}
			<div className="mx-auto flex w-full max-w-xl flex-col gap-6 overflow-auto p-6">
				<PageHeading
					title={title}
					description={
						organizationName ? (
							<>
								<span className="inline-block rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground">
									{organizationName} · {instanceOrigin}
								</span>
								<span className="mt-3 block text-small">{description}</span>
							</>
						) : (
							description
						)
					}
				/>
				{children}
			</div>
		</section>
	);
}

export function AuthField({
	label,
	name,
	type = "text",
	value,
	onChange,
	required = true,
}: {
	readonly label: string;
	readonly name: string;
	readonly type?: string;
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly required?: boolean;
}) {
	return (
		<label htmlFor={`auth-${name}`} className="flex flex-col gap-1.5 text-small">
			{label}
			<Input
				id={`auth-${name}`}
				name={name}
				type={type}
				value={value}
				required={required}
				autoComplete={type === "password" ? "new-password" : "off"}
				onChange={(event) => onChange(event.target.value)}
			/>
		</label>
	);
}

type DeviceDecision = { readonly client: "cli" | "desktop"; readonly decision: "approve" | "deny" };

export function DeviceApprovalResult({ client, decision }: DeviceDecision) {
	return (
		<div className="flex flex-col gap-4">
			<p role="status">
				{decision === "approve" ? "Sign-in approved. Return to your device." : "Sign-in denied. No access was granted."}
			</p>
			{client === "desktop" && decision === "approve" && (
				<Button asChild className="self-start">
					<a href="signet://auth/complete">Return to Signet</a>
				</Button>
			)}
		</div>
	);
}

export function DeviceApprovalPage() {
	const whoami = useWhoami();
	const [code, setCode] = useState(() => new URLSearchParams(location.search).get("user_code") ?? "");
	const [lookup, setLookup] = useState("");
	const [done, setDone] = useState<DeviceDecision | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const { result, refresh } = usePanelQuery<{
		client: "cli" | "desktop";
		deviceName: string;
		platform: string | null;
		createdAt: string;
	}>(lookup ? `/api/auth/device/${encodeURIComponent(lookup)}` : null);
	const decide = async (decision: "approve" | "deny") => {
		const client = result?.data?.client;
		if (!client) return;
		setBusy(true);
		setError(null);
		const response = await getJSONResult<{ ok: boolean }>("/api/auth/device/approve", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userCode: lookup, decision }),
		});
		setBusy(false);
		if (response.error) setError(response.error);
		else setDone({ client, decision });
	};
	return (
		<AuthPage
			title="Approve device sign-in"
			organizationName={whoami?.organization.name}
			description="Only approve a code from a device you are signing in on."
		>
			{done ? (
				<DeviceApprovalResult {...done} />
			) : (
				<>
					<form
						className="flex flex-col gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							setLookup(code.trim().toUpperCase());
							refresh();
						}}
					>
						<AuthField name="userCode" label="Code from your terminal" value={code} onChange={setCode} />
						<Button type="submit" variant="outline" className="self-start">
							Review device
						</Button>
					</form>
					{error && (
						<p role="alert" className="text-small text-destructive">
							{error}
						</p>
					)}
					{lookup && (
						<Panel result={result} onRetry={refresh}>
							{(device) => (
								<div className="flex flex-col gap-4 rounded-lg border p-4">
									<p className="m-0">
										Requested by a device calling itself <strong>{device.deviceName}</strong>. Client: {device.client}{" "}
										(self-declared). Device name and platform are also self-declared, not verified by Signet.
									</p>
									<p className="m-0 text-small text-muted-foreground">
										{device.platform ?? "Platform unavailable"} · Requested{" "}
										{new Date(device.createdAt).toLocaleString()}
									</p>
									<div className="flex gap-3">
										<Button disabled={busy} onClick={() => void decide("approve")}>
											Approve
										</Button>
										<Button disabled={busy} variant="outline" onClick={() => void decide("deny")}>
											Deny
										</Button>
									</div>
								</div>
							)}
						</Panel>
					)}
				</>
			)}
		</AuthPage>
	);
}

export function ClaimPage() {
	const [token, setToken] = useState("");
	const [organizationName, setOrganizationName] = useState("");
	const [username, setUsername] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState(false);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		const response = await getJSONResult("/api/org/claim", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				setupToken: token,
				organizationName,
				admin: { username, displayName, ...(email ? { email } : {}), password },
			}),
		});
		setBusy(false);
		if (response.error) setError(response.error);
		else {
			setToken("");
			setPassword("");
			setDone(true);
			await refreshSession();
		}
	};
	return (
		<AuthPage
			title="Claim your organization"
			description="Use the one-time setup token printed by the daemon. Keep your bootstrap password, or configure SSO after claiming."
		>
			{done ? (
				<>
					<p role="status">Organization claimed. Your administrator session is ready.</p>
					<Button asChild>
						<a href="/">Open dashboard</a>
					</Button>
				</>
			) : (
				<form className="flex flex-col gap-4" onSubmit={submit}>
					<AuthField name="setupToken" label="Setup token" type="password" value={token} onChange={setToken} />
					<AuthField
						name="organizationName"
						label="Organization name"
						value={organizationName}
						onChange={setOrganizationName}
					/>
					<AuthField name="username" label="Administrator username" value={username} onChange={setUsername} />
					<AuthField name="displayName" label="Your name" value={displayName} onChange={setDisplayName} />
					<AuthField name="email" label="Email" type="email" value={email} onChange={setEmail} required={false} />
					<AuthField
						name="password"
						label="Bootstrap password"
						type="password"
						value={password}
						onChange={setPassword}
					/>
					{error && (
						<p role="alert" className="text-small text-destructive">
							{error}
						</p>
					)}
					<Button type="submit" disabled={busy}>
						{busy ? "Claiming…" : "Claim organization"}
					</Button>
				</form>
			)}
		</AuthPage>
	);
}

export function invitationContinuationHref(path: string, origin: string): string | null {
	if (!path.startsWith("/api/auth/sso/start?")) return null;
	const url = attempt(() => new URL(path, origin));
	if (
		!url ||
		url.origin !== origin ||
		url.pathname !== "/api/auth/sso/start" ||
		url.hash ||
		url.username ||
		url.password ||
		Array.from(url.searchParams.keys()).length !== 1 ||
		!url.searchParams.get("continuation")
	)
		return null;
	return path;
}

export function InvitationPage() {
	const [token, setToken] = useState(() => {
		const value = location.pathname.startsWith("/auth/invite/") ? location.pathname.slice("/auth/invite/".length) : "";
		if (value) history.replaceState(null, "", "/auth/invite");
		return value;
	});
	const [username, setUsername] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [password, setPassword] = useState("");
	const [sso, setSso] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [organization, setOrganization] = useState<string | null>(null);
	const [done, setDone] = useState(false);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		if (!organization) {
			const response = await getJSONResult<{ organization: { name: string }; role: string }>(
				"/api/auth/invites/lookup",
				{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) },
			);
			setBusy(false);
			if (response.error || !response.data) setError(response.error ?? "Invitation unavailable.");
			else setOrganization(response.data.organization.name);
			return;
		}
		const response = await getJSONResult<{ ssoStartPath?: string }>("/api/auth/invites/accept", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token, username, displayName, ...(!sso ? { password } : {}) }),
		});
		setBusy(false);
		if (response.error) {
			setError(response.error);
			return;
		}
		if (response.data?.ssoStartPath) {
			const path = invitationContinuationHref(response.data.ssoStartPath, location.origin);
			if (!path) {
				setError("The instance returned an unsafe SSO continuation. Request a new invitation.");
				return;
			}
			setToken("");
			setPassword("");
			location.assign(path);
			return;
		}
		setToken("");
		setPassword("");
		setDone(true);
		await refreshSession();
	};
	return (
		<AuthPage
			title={organization ? `Join ${organization}` : "Accept invitation"}
			description="Paste your invitation token. It is sent in a request body, never saved in your browser."
		>
			{done ? (
				<>
					<p role="status">Invitation accepted.</p>
					<Button asChild>
						<a href="/">Open dashboard</a>
					</Button>
				</>
			) : (
				<form className="flex flex-col gap-4" onSubmit={submit}>
					<AuthField name="inviteToken" label="Invitation token" type="password" value={token} onChange={setToken} />
					{organization && (
						<>
							<AuthField name="username" label="Username" value={username} onChange={setUsername} />
							<AuthField name="displayName" label="Your name" value={displayName} onChange={setDisplayName} />
							<label className="flex items-center gap-2 text-small">
								<input type="checkbox" checked={sso} onChange={(event) => setSso(event.target.checked)} />
								Continue with SSO
							</label>
							{!sso && (
								<AuthField
									name="password"
									label="Choose a password"
									type="password"
									value={password}
									onChange={setPassword}
								/>
							)}
						</>
					)}
					{error && (
						<p role="alert" className="text-small text-destructive">
							{error}
						</p>
					)}
					<Button type="submit" disabled={busy}>
						{busy
							? "Checking…"
							: organization
								? sso
									? "Continue with SSO"
									: "Accept invitation"
								: "Review invitation"}
					</Button>
				</form>
			)}
		</AuthPage>
	);
}
