import { ModalHeading } from "@/components/ui/modal-heading";
import { Field, Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { Loader2 } from "@/components/mingcute-icons";
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
				<ModalHeading className="cs-head" title="Add secret" onClose={onClose} disabled={busy} />
				<div className="cs-body">
					<Field label="Name" htmlFor="add-secret-name" hint="Uppercase SNAKE_CASE · referenced as $secret:NAME">
						<Input
							id="add-secret-name"
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
					</Field>
					<Field label="Value" htmlFor="add-secret-value" hint="Encrypted at rest · never displayed again">
						<Input
							id="add-secret-value"
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
					</Field>
					{(error ?? nameError) && <div className="cs-error">{error ?? nameError}</div>}
				</div>
				<footer className="cs-foot">
					<Button variant="ghost" size="compact" type="button" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					<Button
						variant="default"
						size="compact"
						type="button"
						onClick={() => void submit()}
						disabled={busy || !name.trim() || !value.trim() || Boolean(nameError)}
					>
						{busy && <Loader2 className="size-3.5 animate-spin" />}
						Encrypt &amp; save
					</Button>
				</footer>
			</div>
		</div>
	);
}
