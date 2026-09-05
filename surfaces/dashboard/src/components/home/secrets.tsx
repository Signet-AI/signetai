import { ChevronRight, KeyRound } from "@/components/mingcute-icons";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { useSettings } from "@/lib/settings-context";

export function HomeSecretsPanel() {
	const secrets = useAsync(() => api.getSecrets(), { intervalMs: 30_000 });
	const { setOpen, setSection } = useSettings();
	const count = secrets.data?.secrets?.length;

	const openSecrets = () => {
		setSection("secrets");
		setOpen(true);
	};

	return (
		<section aria-labelledby="home-secrets-title" className="py-5">
			<button type="button" onClick={openSecrets} className="group/secret flex w-full items-start gap-3 text-left">
				<span className="min-w-0 flex-1">
					<span className="flex items-center justify-between gap-3">
						<span id="home-secrets-title" className="text-[15px] font-semibold tracking-tight text-foreground">
							Secrets
						</span>
						<span className="flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
							{secrets.data === null
								? secrets.loading
									? "loading…"
									: "unavailable"
								: `${count ?? 0} ${secrets.data.provider ?? "local"}`}
							<ChevronRight className="size-3.5 transition-transform group-hover/secret:translate-x-0.5" />
						</span>
					</span>
					<span className="home-secret-description">
						<KeyRound className="size-6 shrink-0 text-muted-foreground" />
						<span>
							<span className="block text-[13px] leading-[1.45] text-muted-foreground">
								API keys, passwords, and tokens
							</span>
							<span className="mt-1 block text-[12px] text-muted-foreground/75">Stored locally on this device.</span>
						</span>
					</span>
				</span>
			</button>
		</section>
	);
}
