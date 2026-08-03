/**
 * Add-secret dialog — mockup .sec-modal, reusing the cs-* modal chrome from
 * connect-source-dialog (same visual spec). Name is normalized + validated
 * client-side (secret-names.ts mirrors the daemon's SECRET_NAME_RE); the value
 * is posted once and never read back.
 */
import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { normalizeSecretNameInput, validateSecretName } from "@/lib/secret-names";

export function AddSecretDialog({
	open,
	onClose,
	onAdded,
}: {
	open: boolean;
	onClose: () => void;
	onAdded: () => void;
}) {
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		setName("");
		setValue("");
		setBusy(false);
		setError(null);
	}, [open]);

	if (!open) return null;

	const nameError = name.trim() ? validateSecretName(name) : null;

	const submit = async () => {
		const problem = validateSecretName(name.trim());
		if (problem) {
			setError(problem);
			return;
		}
		if (!value.trim()) {
			setError("Value is required");
			return;
		}
		setBusy(true);
		setError(null);
		const result = await api.putSecret(name.trim(), value);
		setBusy(false);
		if (!result.ok) {
			setError(result.error ?? "Failed to store secret");
			return;
		}
		toast(`Secret ${name.trim()} added`);
		onAdded();
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
			<div className="cs-panel" role="dialog" aria-modal="true" aria-label="Add secret" style={{ width: 440 }}>
				<header className="cs-head">
					<span className="cs-title">Add secret</span>
					<button type="button" className="cs-close" onClick={onClose} disabled={busy} aria-label="Close">
						<X className="size-4" />
					</button>
				</header>
				<div className="cs-body">
					<div className="cs-field">
						<span className="cs-field__label">Name</span>
						<input
							className="cs-field__input"
							value={name}
							onChange={(e) => {
								setName(normalizeSecretNameInput(e.target.value));
								setError(null);
							}}
							placeholder="OPENAI_API_KEY"
							aria-label="Secret name"
							aria-invalid={nameError ? "true" : "false"}
							autoFocus
						/>
						<span className="cs-field__hint">Uppercase SNAKE_CASE · referenced as $secret:NAME</span>
					</div>
					<div className="cs-field">
						<span className="cs-field__label">Value</span>
						<input
							className="cs-field__input"
							type="password"
							value={value}
							onChange={(e) => {
								setValue(e.target.value);
								setError(null);
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") void submit();
							}}
							placeholder="••••••••••••"
							aria-label="Secret value"
						/>
						<span className="cs-field__hint">Encrypted at rest · never displayed again</span>
					</div>
					{(error ?? nameError) && <div className="cs-error">{error ?? nameError}</div>}
				</div>
				<footer className="cs-foot">
					<button type="button" className="cs-btn-ghost" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button
						type="button"
						className="cs-btn-primary"
						onClick={() => void submit()}
						disabled={busy || !name.trim() || !value.trim() || Boolean(nameError)}
					>
						{busy && <Loader2 className="size-3.5 animate-spin" />}
						Encrypt &amp; save
					</button>
				</footer>
			</div>
		</div>
	);
}
