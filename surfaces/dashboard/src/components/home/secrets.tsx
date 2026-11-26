import { SetupRow } from "@/components/home/setup-row";
import { api } from "@/lib/api";
import { useCan, useWhoami } from "@/lib/session";
import { useAsync } from "@/lib/use-async";
import { useView } from "@/lib/view-context";

export function HomeSecretsPanel() {
	const { openSettings } = useView();
	const whoami = useWhoami();
	const admin = useCan("admin");
	if (whoami && !admin) return null;
	if (admin) return <HomeSecretsSummary />;
	return (
		<section className="home-setup-group" aria-labelledby="home-secrets-title">
			<SetupRow id="home-secrets-title" label="Secrets" summary="Admin only" onOpen={() => openSettings("secrets")} />
		</section>
	);
}

function HomeSecretsSummary() {
	const secrets = useAsync(() => api.getSecrets(), { key: "secrets", intervalMs: 30_000 });
	const { openSettings } = useView();
	const provider = secrets.data?.provider ?? "local";
	const whoami = useWhoami();

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
							? whoami
								? "Stored on this instance"
								: "Stored on this device"
							: `Stored in ${provider}`
				}
				count={secrets.data?.secrets?.length}
				onOpen={() => openSettings("secrets")}
			/>
		</section>
	);
}
