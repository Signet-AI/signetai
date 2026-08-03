/**
 * Secret card — mockup .sec-card family. Shows the name, provider source dot,
 * a masked value row (values are never read back from the daemon), and a
 * `$secret:NAME` usage ref. Actions: copy ref (clipboard), delete with a
 * two-click inline confirm (ported from the Svelte SecretsTab).
 */
import { useState } from "react";
import { Bot, Cloud, Copy, KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Deterministic icon from the secret name (mockup SECRET_ICONS family). */
function secretIcon(name: string) {
	if (/BOT/.test(name)) return Bot;
	if (/TOKEN/.test(name)) return ShieldCheck;
	if (/URL|EMAIL|CLOUD|BRIDGE/.test(name)) return Cloud;
	return KeyRound;
}

export function SecretCard({
	name,
	provider,
	onDeleted,
}: {
	name: string;
	provider: string;
	onDeleted: () => void;
}) {
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
		<div
			className="group/sec relative flex flex-col gap-2 rounded-[var(--radius)] border border-[oklch(1_0_0/0.05)] bg-card p-3.5 shadow-[inset_0_1px_0_oklch(1_0_0/0.04),0_1px_2px_oklch(0_0_0/0.3)] transition-colors hover:border-[oklch(1_0_0/0.14)] [:root:not(.dark)_&]:border-[oklch(0_0_0/0.06)]"
			onMouseLeave={() => setConfirming(false)}
		>
			<div className="flex items-center gap-2.5">
				<span className="grid size-8 shrink-0 place-items-center rounded-lg border border-[oklch(1_0_0/0.06)] bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] text-muted-foreground">
					<Icon className="size-4" />
				</span>
				<div className="flex min-w-0 flex-1 flex-col">
					<span className="truncate font-mono text-[12.5px] font-semibold tracking-[-0.01em]" title={name}>
						{name}
					</span>
					<span className="mt-0.5 inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.06em] text-muted-foreground">
						<span className="size-[5px] rounded-full bg-muted-foreground" />
						{provider}
					</span>
				</div>
			</div>

			<div className="flex items-center justify-between rounded-md bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
				<span className="tracking-[1px]">••••••••••••</span>
				<button
					type="button"
					onClick={copyRef}
					title="Copy $secret ref"
					aria-label={`Copy secret reference for ${name}`}
					className="grid size-[22px] place-items-center rounded-[5px] text-muted-foreground opacity-0 transition-opacity hover:bg-[oklch(1_0_0/0.08)] hover:text-foreground group-hover/sec:opacity-70"
				>
					<Copy className="size-3" />
				</button>
			</div>

			<div className="mt-0.5 flex items-center justify-between border-t border-[oklch(1_0_0/0.06)] pt-2 [:root:not(.dark)_&]:border-[oklch(0_0_0/0.06)]">
				<span className="truncate font-mono text-[9.5px] text-muted-foreground" title={ref}>
					<b className="font-medium text-foreground">{ref}</b>
				</span>
				<div className="flex gap-0.5 opacity-40 transition-opacity group-hover/sec:opacity-100">
					<button
						type="button"
						onClick={copyRef}
						title="Copy ref"
						aria-label={`Copy secret reference for ${name}`}
						className="grid size-6 place-items-center rounded-[5px] text-muted-foreground transition-colors hover:bg-[oklch(1_0_0/0.08)] hover:text-foreground"
					>
						<Copy className="size-3" />
					</button>
					<button
						type="button"
						onClick={remove}
						disabled={deleting}
						title={confirming ? "Click again to confirm" : "Delete"}
						aria-label={`Delete secret ${name}`}
						className={cn(
							"grid h-6 min-w-6 place-items-center rounded-[5px] px-1 text-muted-foreground transition-colors hover:bg-[oklch(1_0_0/0.08)] hover:text-[oklch(0.7_0.18_25)]",
							confirming && "w-auto font-mono text-[9px] uppercase tracking-[0.06em] text-[oklch(0.7_0.18_25)]",
						)}
					>
						{deleting ? "…" : confirming ? "sure?" : <Trash2 className="size-3" />}
					</button>
				</div>
			</div>
		</div>
	);
}
