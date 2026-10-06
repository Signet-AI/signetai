import { OnePasswordPanel } from "@/components/secrets/onepassword-panel";
import { AddSecretDialog } from "@/components/secrets/add-secret-dialog";
import { SecretCard } from "@/components/secrets/secret-card";
import { Button } from "@/components/ui/button";
import { GroupLabel } from "@/components/settings/controls";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { useState } from "react";
export function SecretsSection() {
	const secrets = useAsync(() => api.getSecrets(), { key: "secrets" });
	const [adding, setAdding] = useState(false);
	const provider = secrets.data?.provider ?? "local";
	const storedWhere = provider === "local" ? "on this device" : `in ${provider}`;
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between">
				<GroupLabel suffix={secrets.data ? `· ${secrets.data.secrets?.length ?? 0} stored ${storedWhere}` : undefined}>
					Your secrets
				</GroupLabel>
				<Button variant="outline" size="compact" onClick={() => setAdding(true)}>
					Add secret
				</Button>
			</div>
			{secrets.loading ? (
				<p className="settings-row-description">Loading secrets…</p>
			) : secrets.data ? (
				<div>
					{(secrets.data.secrets ?? []).map((name) => (
						<SecretCard
							key={name}
							name={name}
							provider={secrets.data?.provider ?? "local"}
							onDeleted={secrets.refresh}
						/>
					))}
				</div>
			) : (
				<p className="settings-row-description">Secrets unavailable.</p>
			)}
			<AddSecretDialog open={adding} onClose={() => setAdding(false)} onAdded={secrets.refresh} />
			<div className="mt-4">
				<GroupLabel>Secret backend</GroupLabel>
				<p className="settings-row-description mb-2">
					Manage external secret providers here. Secret values are never displayed after saving.
				</p>
			</div>
			<OnePasswordPanel onImported={secrets.refresh} />
		</div>
	);
}
