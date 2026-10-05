import { SectionAction, SectionHeading } from "@/components/dashboard/heading";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { useView } from "@/lib/view-context";

export function HomeSecretsPanel() {
	const secrets = useAsync(() => api.getSecrets(), { key: "secrets", intervalMs: 30_000 });
	const { openSettings } = useView();
	const provider = secrets.data?.provider ?? "local";
	const meta =
		secrets.data === null ? (secrets.loading ? "loading…" : "unavailable") : String(secrets.data.secrets?.length ?? 0);

	return (
		<section aria-labelledby="home-secrets-title">
			<SectionHeading
				id="home-secrets-title"
				title="Secrets"
				meta={<span className="text-meta tabular-nums text-muted-foreground">{meta}</span>}
				actions={<SectionAction onClick={() => openSettings("secrets")}>Manage</SectionAction>}
			/>
			<p className="mt-2 text-small text-muted-foreground">
				API keys, passwords, and tokens, {provider === "local" ? "stored on this device" : `stored in ${provider}`}.
			</p>
		</section>
	);
}
