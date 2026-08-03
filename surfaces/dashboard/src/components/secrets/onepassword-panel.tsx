/**
 * 1Password integration panel — ported from the Svelte SecretsTab. Expandable
 * row under the vault hero: status, service-account connect/disconnect, vault
 * picker, and import with prefix/overwrite options. Backed by
 * /api/secrets/1password/* (secrets-routes.ts).
 */
import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, Import, Link2, Loader2, RefreshCw, Unlink } from "lucide-react";
import { toast } from "sonner";
import { api, type OnePasswordStatus, type OnePasswordVault } from "@/lib/api";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export function OnePasswordPanel({ onImported }: { onImported: () => void }) {
	const [expanded, setExpanded] = useState(false);
	const [loading, setLoading] = useState(false);
	const [status, setStatus] = useState<OnePasswordStatus>({ configured: false, connected: false, vaults: [] });
	const [vaults, setVaults] = useState<OnePasswordVault[]>([]);
	const [selected, setSelected] = useState<string[]>([]);
	const [token, setToken] = useState("");
	const [prefix, setPrefix] = useState("OP");
	const [overwrite, setOverwrite] = useState(false);
	const [connecting, setConnecting] = useState(false);
	const [disconnecting, setDisconnecting] = useState(false);
	const [importing, setImporting] = useState(false);

	const refresh = useCallback(async () => {
		setLoading(true);
		const next = await api.getOnePasswordStatus();
		if (next.connected) {
			const fetched = await api.listOnePasswordVaults();
			setVaults(fetched.length > 0 ? fetched : next.vaults);
		} else {
			setVaults([]);
		}
		setStatus(next);
		setLoading(false);
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Drop selections for vaults that disappeared after a refresh.
	useEffect(() => {
		const known = new Set(vaults.map((v) => v.id));
		setSelected((prev) => {
			const kept = prev.filter((id) => known.has(id));
			return kept.length === prev.length ? prev : kept;
		});
	}, [vaults]);

	const connect = async () => {
		if (!token.trim()) return;
		setConnecting(true);
		const result = await api.connectOnePassword(token.trim());
		setConnecting(false);
		if (!result.success) {
			toast.error(result.error ?? "Failed to connect 1Password");
			return;
		}
		setToken("");
		toast("Connected to 1Password");
		await refresh();
	};

	const disconnect = async () => {
		setDisconnecting(true);
		const result = await api.disconnectOnePassword();
		setDisconnecting(false);
		if (!result.success) {
			toast.error(result.error ?? "Failed to disconnect 1Password");
			return;
		}
		toast("Disconnected 1Password");
		await refresh();
	};

	const importSecrets = async () => {
		if (!status.connected) return;
		setImporting(true);
		const result = await api.importOnePasswordSecrets({
			vaults: selected.length > 0 ? selected : undefined,
			prefix: prefix.trim() || "OP",
			overwrite,
		});
		setImporting(false);
		if (!result.success) {
			toast.error(result.error ?? "Failed to import from 1Password");
			return;
		}
		toast(
			`Imported ${result.importedCount ?? 0} secrets (skipped ${result.skippedCount ?? 0}, errors ${result.errorCount ?? 0})`,
		);
		onImported();
		await refresh();
	};

	const statusLabel = status.connected ? "connected" : status.configured ? "unreachable" : "not configured";
	const statusColor = status.connected
		? "text-[oklch(0.72_0.15_150)]"
		: status.configured
			? "text-[oklch(0.75_0.14_75)]"
			: "text-muted-foreground";

	return (
		<div className="shrink-0 rounded-[var(--radius)] border border-[oklch(1_0_0/0.05)] bg-card [:root:not(.dark)_&]:border-[oklch(0_0_0/0.06)]">
			<div className="flex items-center gap-1 px-3 py-2">
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
					className="flex flex-1 items-center gap-2 text-left"
				>
					{expanded ? (
						<ChevronDown className="size-3.5 text-muted-foreground" />
					) : (
						<ChevronRight className="size-3.5 text-muted-foreground" />
					)}
					<span className="text-[12px] font-medium">1Password</span>
					<span className={cn("font-mono text-[10px]", statusColor)}>{statusLabel}</span>
				</button>
				<button
					type="button"
					onClick={() => void refresh()}
					disabled={loading}
					aria-label="Refresh 1Password status"
					className="grid size-6 place-items-center rounded-[5px] text-muted-foreground transition-colors hover:bg-[oklch(1_0_0/0.08)] hover:text-foreground disabled:opacity-40"
				>
					<RefreshCw className={cn("size-3", loading && "animate-spin")} />
				</button>
			</div>

			{expanded && (
				<div className="flex flex-col gap-3 border-t border-[oklch(1_0_0/0.06)] px-3 py-3 [:root:not(.dark)_&]:border-[oklch(0_0_0/0.06)]">
					{status.connected ? (
						<div className="font-mono text-[10.5px] text-[oklch(0.72_0.15_150)]">
							Connected{typeof status.vaultCount === "number" ? ` · ${status.vaultCount} vaults` : ""}
						</div>
					) : status.configured ? (
						<div className="font-mono text-[10.5px] text-[oklch(0.75_0.14_75)]">
							Token saved but unreachable{status.error ? ` · ${status.error}` : ""}
						</div>
					) : (
						<div className="font-mono text-[10.5px] text-muted-foreground">
							Connect a 1Password service account to import secrets
						</div>
					)}

					<div className="flex gap-2">
						<input
							type="password"
							className="cs-field__input flex-1"
							value={token}
							onChange={(e) => setToken(e.target.value)}
							placeholder={status.connected ? "Replace service account token" : "Service account token"}
							aria-label="1Password service account token"
						/>
						<button
							type="button"
							onClick={() => void connect()}
							disabled={connecting || !token.trim()}
							className="cs-btn-ghost inline-flex items-center gap-1.5 border border-[oklch(1_0_0/0.1)] [:root:not(.dark)_&]:border-[oklch(0_0_0/0.1)]"
						>
							{connecting ? <Loader2 className="size-3 animate-spin" /> : <Link2 className="size-3" />}
							{status.connected ? "Update" : "Connect"}
						</button>
					</div>

					<div className="flex items-center gap-4">
						<label className="flex items-center gap-2">
							<span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">Prefix</span>
							<input
								type="text"
								className="cs-field__input w-20"
								value={prefix}
								onChange={(e) => setPrefix(e.target.value)}
								placeholder="OP"
								aria-label="Import name prefix"
							/>
						</label>
						<label className="flex items-center gap-2">
							<Switch checked={overwrite} onCheckedChange={setOverwrite} />
							<span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
								Overwrite
							</span>
						</label>
					</div>

					{status.connected &&
						(vaults.length > 0 ? (
							<div className="flex flex-col gap-1">
								<span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
									Vaults
								</span>
								<div className="flex flex-wrap gap-1">
									{vaults.map((vault) => {
										const on = selected.includes(vault.id);
										return (
											<button
												key={vault.id}
												type="button"
												aria-pressed={on}
												onClick={() =>
													setSelected((prev) =>
														on ? prev.filter((id) => id !== vault.id) : [...prev, vault.id],
													)
												}
												className={cn(
													"inline-flex h-6 items-center gap-1.5 rounded-[var(--radius)] border px-2 font-mono text-[10.5px] transition-colors",
													on
														? "border-[color-mix(in_oklch,var(--foreground)_30%,transparent)] bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)] text-foreground"
														: "border-[oklch(1_0_0/0.08)] text-muted-foreground hover:text-foreground [:root:not(.dark)_&]:border-[oklch(0_0_0/0.08)]",
												)}
											>
												{on && <Check className="size-3" />}
												{vault.name}
											</button>
										);
									})}
								</div>
								<span className="font-mono text-[9px] text-muted-foreground">
									{selected.length === 0 ? "All vaults will be scanned" : `${selected.length} selected`}
								</span>
							</div>
						) : (
							<div className="font-mono text-[10px] text-muted-foreground">No accessible vaults</div>
						))}

					<div className="flex gap-2">
						<button
							type="button"
							onClick={() => void importSecrets()}
							disabled={importing || !status.connected}
							className="cs-btn-primary inline-flex items-center gap-1.5 disabled:opacity-40"
						>
							{importing ? <Loader2 className="size-3 animate-spin" /> : <Import className="size-3" />}
							{importing ? "Importing…" : "Import"}
						</button>
						<button
							type="button"
							onClick={() => void disconnect()}
							disabled={disconnecting || !status.configured}
							className="cs-btn-ghost inline-flex items-center gap-1.5 disabled:opacity-40"
						>
							{disconnecting ? <Loader2 className="size-3 animate-spin" /> : <Unlink className="size-3" />}
							Disconnect
						</button>
					</div>

					<div className="font-mono text-[9px] text-muted-foreground">
						Tip: map direct refs as <code className="text-foreground">op://vault/item/field</code>
					</div>
				</div>
			)}
		</div>
	);
}
