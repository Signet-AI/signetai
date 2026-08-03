/**
 * Connect-source dialog — kind picker + per-kind fields, posts to
 * /api/sources/:kind (daemon upserts, responds 202 with a queued index job).
 * Visual spec: mockup .src-modal family (480px, picker tiles, foot buttons).
 */
import { useEffect, useState } from "react";
import { FolderOpen, Loader2, X } from "lucide-react";
import { api } from "@/lib/api";
import { sourceLogo } from "@/components/icons";
import { cn } from "@/lib/utils";

type SourceKind = "obsidian" | "github" | "discord";

const KINDS: readonly { id: SourceKind; label: string; namePlaceholder: string }[] = [
	{ id: "obsidian", label: "Obsidian", namePlaceholder: "Research Vault" },
	{ id: "github", label: "GitHub", namePlaceholder: "Signet GitHub" },
	{ id: "discord", label: "Discord", namePlaceholder: "Team Discord" },
];

/** Mockup FIELD_CONFIG — primary field per kind. */
const FIELD: Record<SourceKind, { label: string; placeholder: string; hint: string }> = {
	obsidian: {
		label: "Vault path",
		placeholder: "/home/nicholai/Notes/Research",
		hint: "Absolute path to your Obsidian vault root",
	},
	github: {
		label: "Repository",
		placeholder: "Signet-AI/signetai",
		hint: "owner/repo — use owner/* for org-wide glob",
	},
	discord: {
		label: "Guild ID",
		placeholder: "123456789012345678",
		hint: "Requires a bot token stored in Secrets (token ref below)",
	},
};

function validate(kind: SourceKind, target: string, tokenRef: string): string | null {
	const value = target.trim();
	if (kind === "obsidian") {
		if (!value) return "Vault path is required";
		// POSIX root or Windows drive path — the daemon resolves any existing dir.
		if (!/^(?:[A-Za-z]:[\\/]|[\/])/.test(value)) return "Vault path must be absolute";
		return null;
	}
	if (kind === "github") {
		if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_*.-]+$/.test(value)) return "Expected owner/repo or owner/*";
		return null;
	}
	// Daemon enforces a Discord snowflake (isDiscordSnowflake, sources-config.ts).
	if (!/^\d{17,20}$/.test(value)) return "Guild ID must be a 17–20 digit snowflake";
	if (!tokenRef.trim()) return "Token ref is required for Discord";
	return null;
}

export function ConnectSourceDialog({
	open,
	onClose,
	onConnected,
}: {
	open: boolean;
	onClose: () => void;
	onConnected: () => void;
}) {
	const [kind, setKind] = useState<SourceKind>("obsidian");
	const [target, setTarget] = useState("");
	const [name, setName] = useState("");
	const [tokenRef, setTokenRef] = useState("");
	const [busy, setBusy] = useState(false);
	const [browsing, setBrowsing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Reset to a clean form each time the dialog opens.
	useEffect(() => {
		if (!open) return;
		setKind("obsidian");
		setTarget("");
		setName("");
		setTokenRef("");
		setBusy(false);
		setBrowsing(false);
		setError(null);
	}, [open]);

	if (!open) return null;

	const browse = async () => {
		setBrowsing(true);
		setError(null);
		const result = await api.pickDirectory();
		setBrowsing(false);
		if (result.ok && result.path) setTarget(result.path);
		else if (result.unavailable) setError("Native folder picker is only available in the desktop app");
		else setError("No folder selected");
	};

	const submit = async () => {
		const problem = validate(kind, target, tokenRef);
		if (problem) {
			setError(problem);
			return;
		}
		setBusy(true);
		setError(null);
		const displayName = name.trim() || undefined;
		const body =
			kind === "obsidian"
				? { root: target.trim(), name: displayName }
				: kind === "github"
					? { repo: target.trim(), name: displayName, tokenRef: tokenRef.trim() || undefined }
					: { guildId: target.trim(), name: displayName, tokenRef: tokenRef.trim() };
		const result = await api.addSource(kind, body);
		setBusy(false);
		if (!result.ok) {
			setError(result.error ?? "connect failed");
			return;
		}
		onConnected();
		onClose();
	};

	return (
		<div
			className="cs-backdrop"
			role="presentation"
			onClick={(e) => {
				if (e.target === e.currentTarget && !busy) onClose();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape" && !busy) onClose();
			}}
		>
			<div className="cs-panel" role="dialog" aria-modal="true" aria-label="Connect a source">
				<header className="cs-head">
					<span className="cs-title">Connect a source</span>
					<button type="button" className="cs-close" onClick={onClose} disabled={busy} aria-label="Close">
						<X className="size-4" />
					</button>
				</header>
				<div className="cs-body">
					<div className="cs-picker">
						{KINDS.map((k) => (
							<button
								key={k.id}
								type="button"
								aria-pressed={kind === k.id}
								className={cn("cs-pick", kind === k.id && "is-on")}
								onClick={() => {
									setKind(k.id);
									setError(null);
								}}
							>
								<span className="cs-pick__ic">{sourceLogo(k.id, { className: "size-6" })}</span>
								<span className="cs-pick__label">{k.label}</span>
							</button>
						))}
					</div>

					<div className="cs-field">
						<span className="cs-field__label">{FIELD[kind].label}</span>
						<div className="flex gap-2">
							<input
								className="cs-field__input"
								value={target}
								onChange={(e) => setTarget(e.target.value)}
								placeholder={FIELD[kind].placeholder}
								aria-label={FIELD[kind].label}
								autoFocus
							/>
							{kind === "obsidian" && (
								<button
									type="button"
									className="cs-browse"
									onClick={browse}
									disabled={browsing}
									title="Browse folders"
									aria-label="Browse folders"
								>
									{browsing ? <Loader2 className="size-3.5 animate-spin" /> : <FolderOpen className="size-3.5" />}
								</button>
							)}
						</div>
						<span className="cs-field__hint">{FIELD[kind].hint}</span>
					</div>

					<div className="cs-field">
						<span className="cs-field__label">Name</span>
						<input
							className="cs-field__input"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder={KINDS.find((k) => k.id === kind)?.namePlaceholder}
							aria-label="Display name (optional)"
						/>
					</div>

					{kind !== "obsidian" && (
						<div className="cs-field">
							<span className="cs-field__label">Token ref{kind === "github" ? " (optional)" : ""}</span>
							<input
								className="cs-field__input"
								value={tokenRef}
								onChange={(e) => setTokenRef(e.target.value)}
								placeholder={kind === "github" ? "GITHUB_TOKEN" : "DISCORD_BOT_TOKEN"}
								aria-label="Token secret name"
							/>
							<span className="cs-field__hint">Name of the secret holding your token</span>
						</div>
					)}

					{error && <div className="cs-error">{error}</div>}
				</div>
				<footer className="cs-foot">
					<button type="button" className="cs-btn-ghost" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="button" className="cs-btn-primary" onClick={submit} disabled={busy}>
						{busy && <Loader2 className="size-3.5 animate-spin" />}
						Connect &amp; index
					</button>
				</footer>
			</div>
		</div>
	);
}
