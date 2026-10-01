import { OnePasswordPanel } from "@/components/secrets/onepassword-panel";
import { AddSecretDialog } from "@/components/secrets/add-secret-dialog";
import { SecretCard } from "@/components/secrets/secret-card";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { useState } from "react";
export function SecretsSection() {
	const secrets = useAsync(() => api.getSecrets(), { key: "secrets" });
	const [adding, setAdding] = useState(false);
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between">
				<h3 className="text-sm font-semibold">Secrets</h3>
				<Button variant="outline" size="sm" onClick={() => setAdding(true)}>
					Add secret
				</Button>
			</div>
			{secrets.loading ? (
				<p className="text-xs text-muted-foreground">Loading secrets…</p>
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
				<p className="text-xs text-muted-foreground">Secrets unavailable.</p>
			)}
			<AddSecretDialog open={adding} onClose={() => setAdding(false)} onAdded={secrets.refresh} />
			<div className="px-1.5">
				<div className="text-[13px] font-medium">Secret backend</div>
				<p className="mt-0.5 max-w-[560px] text-[11.5px] leading-relaxed text-muted-foreground">
					Manage external secret providers here. Secret values are never displayed after saving.
				</p>
			</div>
			<OnePasswordPanel onImported={secrets.refresh} />
		</div>
	);
}
