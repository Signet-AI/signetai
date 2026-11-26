import { useState } from "react";
import { getJSONResult } from "@/lib/api";
import type { OrganizationGroup, OrganizationSettings } from "@/lib/organization";
import { useView } from "@/lib/view-context";
import { Action, Choice, Message, OrganizationBlock, TextField } from "./controls";

export function AuthenticationContent({
	settings,
	groups,
	refresh,
}: {
	settings: OrganizationSettings;
	groups: readonly OrganizationGroup[];
	refresh: () => void;
}) {
	const { openSettings } = useView();
	const [issuer, setIssuer] = useState(settings.oidc?.issuer ?? "");
	const [clientId, setClientId] = useState(settings.oidc?.clientId ?? "");
	const [secretRef, setSecretRef] = useState(settings.oidc?.clientSecretRef ?? "");
	const [groupClaim, setGroupClaim] = useState(settings.oidc?.groupClaim ?? "groups");
	const [domains, setDomains] = useState(settings.oidc?.allowedDomains.join(", ") ?? "");
	const [mapping, setMapping] = useState(settings.oidc?.groupMap ?? {});
	const [mappingName, setMappingName] = useState("");
	const [mappingGroup, setMappingGroup] = useState("");
	const [passwordLogin, setPasswordLogin] = useState(settings.passwordLogin);
	const [requireSso, setRequireSso] = useState(settings.requireSso);
	const [sessionTtl, setSessionTtl] = useState(String(settings.sessionTtlSeconds));
	const [connectorTtl, setConnectorTtl] = useState(String(settings.connectorKeyTtlSeconds));
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [saved, setSaved] = useState(false);
	const redirectUri = `${settings.publicUrl ?? window.location.origin}/api/auth/sso/callback`;
	const save = async () => {
		setBusy(true);
		setSaved(false);
		const result = await getJSONResult<OrganizationSettings>("/api/org/settings", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				passwordLogin,
				requireSso,
				sessionTtlSeconds: Number(sessionTtl),
				connectorKeyTtlSeconds: Number(connectorTtl),
				oidc: issuer
					? {
							issuer,
							clientId,
							clientSecretRef: secretRef || undefined,
							scopes: settings.oidc?.scopes ?? ["openid", "profile", "email"],
							groupClaim,
							groupMap: mapping,
							allowedDomains: domains
								.split(",")
								.map((value) => value.trim())
								.filter(Boolean),
						}
					: null,
			}),
		});
		setBusy(false);
		setError(result.error);
		if (result.data) {
			setSaved(true);
			refresh();
		}
	};
	return (
		<div className="flex flex-col gap-6">
			<OrganizationBlock
				title="Single sign-on"
				description="OIDC client secrets belong in Secrets. Only the secret name is stored in authentication settings."
			>
				<div className="flex flex-col gap-3">
					<TextField label="OIDC issuer" type="url" value={issuer} onChange={setIssuer} />
					<TextField label="OIDC client ID" value={clientId} onChange={setClientId} />
					<TextField label="Client secret name" value={secretRef} onChange={setSecretRef} />
					<TextField label="Group claim" value={groupClaim} onChange={setGroupClaim} />
					<TextField label="Allowed email domains" value={domains} onChange={setDomains} />
				</div>
				<Action secondary onClick={() => openSettings("secrets")}>
					Store client secret in Secrets
				</Action>
				<p className="break-all text-small">
					Redirect URI: <code className="select-all">{redirectUri}</code>
				</p>
				<Action
					secondary
					onClick={() => {
						void navigator.clipboard
							.writeText(redirectUri)
							.catch(() => setError("Copy failed. Select the redirect URI manually."));
					}}
				>
					Copy redirect URI
				</Action>
			</OrganizationBlock>
			<OrganizationBlock title="Identity-provider group mapping">
				<div className="flex flex-col gap-3">
					<TextField label="Identity-provider group" value={mappingName} onChange={setMappingName} />
					<Choice
						label="Signet team"
						value={mappingGroup}
						onChange={setMappingGroup}
						options={[
							{ value: "", label: "Select team" },
							...groups.map((group) => ({ value: group.id, label: group.name })),
						]}
					/>
				</div>
				<Action
					secondary
					disabled={!mappingName.trim() || !mappingGroup}
					onClick={() => {
						setMapping({ ...mapping, [mappingName.trim()]: mappingGroup });
						setMappingName("");
					}}
				>
					Add mapping
				</Action>
				{Object.entries(mapping).map(([name, groupId]) => (
					<div key={name} className="settings-row">
						<p className="text-small">
							{name} → {groups.find((group) => group.id === groupId)?.name ?? groupId}
						</p>
						<Action
							secondary
							onClick={() => setMapping(Object.fromEntries(Object.entries(mapping).filter(([key]) => key !== name)))}
						>
							Remove mapping
						</Action>
					</div>
				))}
			</OrganizationBlock>
			<OrganizationBlock title="Login policy">
				<label className="flex items-center gap-2 text-small">
					<input type="checkbox" checked={passwordLogin} onChange={(event) => setPasswordLogin(event.target.checked)} />
					Allow password login
				</label>
				<label className="flex items-center gap-2 text-small">
					<input type="checkbox" checked={requireSso} onChange={(event) => setRequireSso(event.target.checked)} />
					Require SSO
				</label>
				<div className="flex flex-col gap-3">
					<TextField label="Browser session TTL in seconds" type="number" value={sessionTtl} onChange={setSessionTtl} />
					<TextField
						label="Connector key TTL in seconds"
						type="number"
						value={connectorTtl}
						onChange={setConnectorTtl}
					/>
				</div>
			</OrganizationBlock>
			<Message error={error} />
			{saved && (
				<p role="status" className="text-small">
					Authentication settings saved.
				</p>
			)}
			<Action
				disabled={busy || (Boolean(issuer) && !clientId) || Number(sessionTtl) < 60 || Number(connectorTtl) < 60}
				onClick={() => void save()}
			>
				Save authentication settings
			</Action>
		</div>
	);
}
