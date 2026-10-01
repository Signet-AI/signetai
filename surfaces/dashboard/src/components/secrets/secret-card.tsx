import { Button } from "@/components/ui/button";
import { useState } from "react";
import { Bot, ChevronRight, Cloud, Copy, KeyRound, ShieldCheck, Trash2 } from "@/components/mingcute-icons";
import { toast } from "sonner";
import { api } from "@/lib/api";
function secretIcon(name: string) {
	if (/BOT/.test(name)) return Bot;
	if (/TOKEN/.test(name)) return ShieldCheck;
	if (/URL|EMAIL|CLOUD|BRIDGE/.test(name)) return Cloud;
	return KeyRound;
}

export function SecretCard({ name, provider, onDeleted }: { name: string; provider: string; onDeleted: () => void }) {
	const Icon = secretIcon(name);
	const [confirming, setConfirming] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const ref = `$secret:${name}`;

	const copyRef = async () => {
		try {
			await navigator.clipboard.writeText(ref);
			toast(`Copied ${ref}`);
		} catch {
			toast.error("Clipboard unavailable");
		}
	};

	const remove = async () => {
		if (!confirming) {
			setConfirming(true);
			return;
		}
		setDeleting(true);
		const result = await api.deleteSecret(name);
		setDeleting(false);
		setConfirming(false);
		if (!result.ok) {
			toast.error(result.error ?? `Failed to delete ${name}`);
			return;
		}
		toast(`Deleted ${name}`);
		onDeleted();
	};

	return (
		<details className="group/secret" onToggle={(event) => !event.currentTarget.open && setConfirming(false)}>
			<summary className="flex cursor-pointer list-none items-center gap-2 py-1.5 text-left [&::-webkit-details-marker]:hidden">
				<Icon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="min-w-0 flex-1 truncate font-mono text-[11px] font-normal" title={name}>
					{name}
				</span>
				<span className="font-mono text-[9.5px] text-muted-foreground">{provider}</span>
				<ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-open/secret:rotate-90" />
			</summary>
			<div className="flex items-center justify-between gap-2 pb-2 pl-5 pt-0.5">
				<code className="min-w-0 truncate font-mono text-[9.5px] text-muted-foreground" title={ref}>
					{ref}
				</code>
				<div className="flex shrink-0 items-center gap-1">
					<Button
						variant="ghost"
						size="icon-xs"
						type="button"
						onClick={copyRef}
						title="Copy $secret ref"
						aria-label={`Copy secret reference for ${name}`}
					>
						<Copy className="size-3" />
					</Button>
					<Button
						variant="ghost"
						size="icon-xs"
						type="button"
						onClick={remove}
						disabled={deleting}
						title={confirming ? "Click again to confirm" : "Delete"}
						aria-label={`Delete secret ${name}`}
						className={confirming ? "w-auto px-1 font-mono text-[9px] text-destructive" : "hover:text-destructive"}
					>
						{deleting ? "…" : confirming ? "sure?" : <Trash2 className="size-3" />}
					</Button>
				</div>
			</div>
		</details>
	);
}
