/**
 * Secrets vault — mockup sec-view: a decorative lock gate (the daemon gates on
 * the dashboard admin token; there is no vault password endpoint, so any
 * non-empty entry unlocks, exactly like the mockup) over the real vault: hero
 * telemetry, 1Password integration panel, and the secret card grid backed by
 * /api/secrets (names only — values are never read back).
 */
import { useState } from "react";
import { Lock, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import { SecretCard } from "@/components/secrets/secret-card";
import { AddSecretDialog } from "@/components/secrets/add-secret-dialog";
import { OnePasswordPanel } from "@/components/secrets/onepassword-panel";

export function SecretsView() {
	const [unlocked, setUnlocked] = useState(false);
	const [addOpen, setAddOpen] = useState(false);
	const secrets = useAsync(() => api.getSecrets(), { deps: [] });

	const refresh = () => void secrets.refresh();
	const names = secrets.data?.secrets ?? [];
	const provider = secrets.data?.provider ?? "local";

	if (!unlocked) {
		return <LockGate count={secrets.data ? names.length : null} onUnlock={() => setUnlocked(true)} />;
	}

	return (
		<div className="sec-vault-enter flex h-full min-h-0 flex-1 flex-col gap-3">
			{/* telemetry hero */}
			<div className="flex shrink-0 items-center gap-2 px-0.5 pb-1 font-mono">
				<span className="inline-flex items-baseline gap-1.5">
					<span className="text-[12px] font-medium tracking-[-0.01em] text-foreground">{names.length}</span>
					<span className="text-[10.5px] text-muted-foreground">secrets</span>
				</span>
				<span className="text-[oklch(0.35_0_0)] [:root:not(.dark)_&]:text-[oklch(0.65_0_0)]">/</span>
				<span className="inline-flex items-baseline gap-1.5">
					<span className="text-[12px] font-medium tracking-[-0.01em] text-foreground">{provider}</span>
					<span className="text-[10.5px] text-muted-foreground">provider</span>
				</span>
				<span className="flex-1" />
				<button
					type="button"
					onClick={() => setUnlocked(false)}
					className="inline-flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
				>
					<Lock className="size-3" /> Lock
				</button>
			</div>

			<OnePasswordPanel onImported={refresh} />

			{/* secret grid */}
			<div className="sec-grid-mask grid min-h-0 flex-1 auto-rows-min grid-cols-1 content-start gap-2.5 overflow-y-auto pb-3 md:grid-cols-2">
				{secrets.data === null ? (
					<div className="col-span-full grid h-32 place-items-center font-mono text-[11px] text-muted-foreground">
						{/* loading or daemon unreachable — no spinner in the mockup family */}
						…
					</div>
				) : names.length === 0 ? (
					<div className="col-span-full grid h-32 place-items-center text-center">
						<span className="text-[12px] text-muted-foreground">No secrets stored yet.</span>
					</div>
				) : (
					names.map((name) => (
						<SecretCard key={name} name={name} provider={provider} onDeleted={refresh} />
					))
				)}

				{/* inline add tile */}
				<button
					type="button"
					onClick={() => setAddOpen(true)}
					className="flex min-h-[140px] flex-col items-center justify-center gap-2 rounded-[var(--radius)] border-[1.5px] border-dashed border-[oklch(1_0_0/0.12)] bg-[color-mix(in_oklch,var(--card)_86%,transparent)] transition-colors hover:border-[color-mix(in_oklch,var(--success)_45%,transparent)] hover:bg-[color-mix(in_oklch,var(--success)_4%,transparent)] [:root:not(.dark)_&]:border-[oklch(0_0_0/0.12)]"
				>
					<span className="grid size-8 place-items-center rounded-full border border-[oklch(1_0_0/0.08)] bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] text-muted-foreground">
						<Plus className="size-3.5" />
					</span>
					<span className="text-[11.5px] font-medium text-foreground">Add secret</span>
				</button>
			</div>

			<AddSecretDialog open={addOpen} onClose={() => setAddOpen(false)} onAdded={refresh} />
		</div>
	);
}

/** Mockup .sec-gate — centered lock card. Decorative: the daemon's real gate
 *  is the dashboard admin token, so any non-empty entry unlocks (mockup
 *  behavior); an empty entry shakes with an error. */
function LockGate({ count, onUnlock }: { count: number | null; onUnlock: () => void }) {
	const [pw, setPw] = useState("");
	const [error, setError] = useState(false);
	const [shaking, setShaking] = useState(false);
	const [unlocking, setUnlocking] = useState(false);

	const tryUnlock = (e: React.FormEvent) => {
		e.preventDefault();
		if (!pw.trim()) {
			setError(true);
			setShaking(true);
			setTimeout(() => setShaking(false), 400);
			return;
		}
		setError(false);
		setUnlocking(true);
		setTimeout(onUnlock, 600);
	};

	return (
		<div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center">
			<span
				className={cn(
					"mb-6 grid size-16 place-items-center rounded-[18px] border border-[oklch(1_0_0/0.08)] bg-[color-mix(in_oklch,var(--card)_80%,transparent)] text-muted-foreground shadow-[0_8px_32px_oklch(0_0_0/0.4),inset_0_1px_0_oklch(1_0_0/0.06)] transition-all duration-500 [:root:not(.dark)_&]:border-[oklch(0_0_0/0.08)]",
					unlocking &&
						"border-[color-mix(in_oklch,var(--success)_40%,transparent)] text-[oklch(0.72_0.15_150)] shadow-[0_0_24px_color-mix(in_oklch,var(--success)_24%,transparent),inset_0_1px_0_oklch(1_0_0/0.06)]",
				)}
			>
				<Lock className="size-7" />
			</span>
			<h2 className="text-[16px] font-semibold tracking-[-0.01em]">Secrets vault</h2>
			<p className="mt-1.5 font-mono text-[12px] text-muted-foreground">
				Enter password to decrypt{count !== null ? ` · ${count} secrets stored` : ""}
			</p>
			<form onSubmit={tryUnlock} className="mt-6 flex items-center gap-2">
				<input
					type="password"
					value={pw}
					onChange={(e) => {
						setPw(e.target.value);
						setError(false);
					}}
					placeholder="Password"
					autoComplete="off"
					aria-label="Vault password"
					autoFocus
					className={cn(
						"h-[38px] w-[280px] max-w-[calc(100vw-120px)] rounded-[var(--radius)] border border-[oklch(1_0_0/0.12)] bg-[color-mix(in_oklch,var(--card)_60%,transparent)] px-3.5 text-[13px] text-foreground outline-none backdrop-blur transition-colors placeholder:text-muted-foreground focus:border-[color-mix(in_oklch,var(--success)_45%,transparent)] [:root:not(.dark)_&]:border-[oklch(0_0_0/0.12)]",
						shaking && "sec-shake",
					)}
				/>
				<button
					type="submit"
					className="h-[38px] rounded-[var(--radius)] bg-foreground px-4 text-[12.5px] font-medium text-[oklch(0.15_0_0)] transition-opacity hover:opacity-88"
				>
					Unlock
				</button>
			</form>
			<div
				className={cn(
					"mt-2.5 h-4 font-mono text-[10.5px] text-[oklch(0.72_0.19_25)] opacity-0 transition-opacity",
					error && "opacity-100",
				)}
			>
				Incorrect password. Try again.
			</div>
		</div>
	);
}
