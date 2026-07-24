import { Lock, AlertCircle } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Surface } from "@/components/ui/surface";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";

/**
 * Secrets vault. Mockup shows a locked-gate state with a password unlock and a
 * Bitwarden reference; the Svelte app shipped 1Password. Per DASHBOARD_API_MAP
 * §4 this backend choice is open — we render the locked gate (matches the
 * mockup) and list secret names from /api/secrets once "unlocked".
 */
export function SecretsView() {
	const [unlocked, setUnlocked] = useState(false);
	const [pw, setPw] = useState("");
	const [err, setErr] = useState(false);
	const secrets = useAsync(() => (unlocked ? api.getSecrets() : Promise.resolve(null)), {
		deps: [unlocked],
	}).data;

	function unlock(e: React.FormEvent) {
		e.preventDefault();
		// The unlock maps to dashboard auth; surface is local-only for now.
		if (pw.length === 0) {
			setErr(true);
			return;
		}
		setUnlocked(true);
		setErr(false);
	}

	if (!unlocked) {
		return (
			<div className="flex flex-1 items-center justify-center min-h-0">
				<div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
					<span className="grid size-16 place-items-center rounded-[18px] bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] text-foreground shadow-[0_8px_32px_oklch(0_0_0/0.4),inset_0_1px_0_oklch(1_0_0/0.1)]">
						<Lock className="size-7" />
					</span>
					<div className="flex flex-col gap-1.5">
						<h2 className="text-[15px] font-semibold tracking-tight">Secrets vault</h2>
						<p className="text-[12px] text-muted-foreground">Enter your vault password to continue.</p>
					</div>
					<form onSubmit={unlock} className="flex w-full flex-col gap-2">
						<Input
							type="password"
							value={pw}
							onChange={(e) => setPw(e.target.value)}
							placeholder="Vault password"
							className="h-9 text-center"
							autoFocus
						/>
						{err && (
							<span className="flex items-center justify-center gap-1.5 text-[11px] text-destructive">
								<AlertCircle className="size-3" /> Incorrect password. Try again.
							</span>
						)}
						<Button type="submit" className="h-9 w-full">
							Unlock
						</Button>
					</form>
					<div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
						<span className="size-1.5 rounded-full bg-success" /> Bitwarden · 1Password
					</div>
				</div>
			</div>
		);
	}

	const names = Array.isArray(secrets) ? secrets : secrets?.secrets ?? [];
	return (
		<div className="flex flex-1 flex-col gap-3 min-h-0">
			<div className="flex items-center justify-between">
				<h2 className="text-[15px] font-semibold tracking-tight">Secrets vault</h2>
				<Button variant="outline" size="sm" onClick={() => setUnlocked(false)}>
					Lock
				</Button>
			</div>
			<div className="flex flex-col gap-1.5 overflow-y-auto">
				{names.length === 0 && (
					<div className="p-8 text-center text-[12px] text-muted-foreground">No secrets stored.</div>
				)}
				{names.map((n) => (
					<Surface key={n} className="flex items-center gap-3 px-4 py-2.5">
						<Lock className="size-3.5 text-muted-foreground" />
						<span className="font-mono text-[12px]">{n}</span>
						<span className="ml-auto font-mono text-[10px] text-muted-foreground">••••••••</span>
					</Surface>
				))}
			</div>
		</div>
	);
}
