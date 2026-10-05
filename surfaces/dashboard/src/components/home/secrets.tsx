import { SetupRow } from "@/components/home/setup-row";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { useView } from "@/lib/view-context";

export function HomeSecretsPanel() {
	const secrets = useAsync(() => api.getSecrets(), { key: "secrets", intervalMs: 30_000 });
	const { openSettings } = useView();
	const provider = secrets.data?.provider ?? "local";

	return (
		<section className="home-setup-group" aria-labelledby="home-secrets-title">
			<SetupRow
				id="home-secrets-title"
				label="Secrets"
				summary={
					secrets.data === null
						? secrets.loading
							? "Loading…"
							: "Unavailable"
						: provider === "local"
							? "Stored on this device"
							: `Stored in ${provider}`
				}
				count={secrets.data?.secrets?.length}
				onOpen={() => openSettings("secrets")}
			/>
		</section>
	);
}
