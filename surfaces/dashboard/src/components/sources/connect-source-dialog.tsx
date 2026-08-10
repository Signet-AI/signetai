/**
 * Unified source dialog — file imports and connector-backed sources share one
 * centered picker and modal shell. The daemon contracts stay in the api client;
 * this component only chooses the existing transport and submit path.
 */
import { sourceLogo } from "@/components/icons";
import { type ImportSourcesResponse, api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { FolderOpen, Loader2, RotateCcw, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type SourceKind = "files" | "obsidian" | "github" | "discord";

const KINDS: readonly { id: SourceKind; label: string; namePlaceholder: string }[] = [
	{ id: "files", label: "Files", namePlaceholder: "" },
	{ id: "obsidian", label: "Obsidian", namePlaceholder: "Research Vault" },
	{ id: "github", label: "GitHub", namePlaceholder: "Signet GitHub" },
	{ id: "discord", label: "Discord", namePlaceholder: "Team Discord" },
];

const FIELD: Record<Exclude<SourceKind, "files">, { label: string; placeholder: string; hint: string }> = {
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

function validate(kind: Exclude<SourceKind, "files">, target: string, tokenRef: string): string | null {
	const value = target.trim();
	if (kind === "obsidian") {
		if (!value) return "Vault path is required";
		if (!/^(?:[A-Za-z]:[\\/]|[\/])/.test(value)) return "Vault path must be absolute";
		return null;
	}
	if (kind === "github") {
		if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_*.-]+$/.test(value)) return "Expected owner/repo or owner/*";
		return null;
	}
	if (!/^\d{17,20}$/.test(value)) return "Guild ID must be a 17–20 digit snowflake";
	if (!tokenRef.trim()) return "Token ref is required for Discord";
	return null;
}

function KindIcon({ kind }: { readonly kind: SourceKind }) {
	if (kind === "files") return <Upload className="size-6" />;
	return sourceLogo(kind, { className: "size-6" });
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
	const inputRef = useRef<HTMLInputElement>(null);
	const [kind, setKind] = useState<SourceKind>("files");
	const [target, setTarget] = useState("");
	const [name, setName] = useState("");
	const [tokenRef, setTokenRef] = useState("");
	const [files, setFiles] = useState<File[]>([]);
	const [desktopPaths, setDesktopPaths] = useState<string[]>([]);
	const [duplicateMode, setDuplicateMode] = useState<"skip" | "replace" | "reimport">("skip");
	const [busy, setBusy] = useState(false);
	const [browsing, setBrowsing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<ImportSourcesResponse | null>(null);

	useEffect(() => {
		if (!open) return;
		setKind("files");
		setTarget("");
		setName("");
		setTokenRef("");
		setFiles([]);
		setDesktopPaths([]);
		setDuplicateMode("skip");
		setBusy(false);
		setBrowsing(false);
		setError(null);
		setResult(null);
		if (inputRef.current) inputRef.current.value = "";
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !busy) onClose();
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [busy, onClose, open]);

	if (!open) return null;

	const choose = (selected: FileList | null) => {
		if (!selected) return;
		setFiles(Array.from(selected));
		setDesktopPaths([]);
		setResult(null);
		setError(null);
	};

	const importFiles = async (targetFiles: readonly File[], targetPaths: readonly string[] = []) => {
		if (targetFiles.length === 0 && targetPaths.length === 0) return;
		if (busy) return;
		setBusy(true);
		setError(null);
		setResult(null);
		const response = await api.importSources(targetFiles, duplicateMode, targetPaths);
		setBusy(false);
		if (!response.ok || !response.data) {
			setError(response.error ?? "Import failed");
			return;
		}
		setResult(response.data);
		onConnected();
	};

	const chooseDesktop = async () => {
		if (busy) return;
		setError(null);
		const response = await api.pickFiles();
		if (!response.ok || !response.paths) {
			setError(response.error ?? "Native file picker unavailable");
			return;
		}
		setFiles([]);
		setDesktopPaths(response.paths);
		setResult(null);
	};

	const retryFailed = () => {
		if (!result) return;
		const failedNames = new Set(result.files.filter((file) => file.status === "failed").map((file) => file.fileName));
		void importFiles(
			files.filter((file) => failedNames.has(file.name)),
			desktopPaths.filter((path) => failedNames.has(path.split(/[\\/]/).pop() ?? path)),
		);
	};

	const browse = async () => {
		setBrowsing(true);
		setError(null);
		const response = await api.pickDirectory();
		setBrowsing(false);
		if (response.ok && response.path) setTarget(response.path);
		else if (response.unavailable) setError("Native folder picker is only available in the desktop app");
		else setError("No folder selected");
	};

	const connect = async () => {
		if (kind === "files") return;
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
		const response = await api.addSource(kind, body);
		setBusy(false);
		if (!response.ok) {
			setError(response.error ?? "connect failed");
			return;
		}
		onConnected();
		onClose();
	};

	const submit = () => {
		if (kind === "files") void importFiles(files, desktopPaths);
		else void connect();
	};

	const selectedCount = files.length + desktopPaths.length;
	const submitDisabled = busy || (kind === "files" && selectedCount === 0);

	return (
		<div
			className="cs-backdrop"
			role="presentation"
			onClick={(event) => {
				if (event.target === event.currentTarget && !busy) onClose();
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape" && !busy) onClose();
			}}
		>
			<dialog open className="cs-panel" aria-modal="true" aria-label="Connect a source">
				<header className="cs-head">
					<span className="cs-title">Connect a source</span>
					<button type="button" className="cs-close" onClick={onClose} disabled={busy} aria-label="Close">
						<X className="size-4" />
					</button>
				</header>
				<div className="cs-body">
					<div className="cs-picker">
						{KINDS.map((item) => (
							<button
								key={item.id}
								type="button"
								aria-pressed={kind === item.id}
								className={cn("cs-pick", kind === item.id && "is-on")}
								onClick={() => {
									setKind(item.id);
									setError(null);
								}}
							>
								<span className="cs-pick__ic">
									<KindIcon kind={item.id} />
								</span>
								<span className="cs-pick__label">{item.label}</span>
							</button>
						))}
					</div>

					{kind === "files" ? (
						<>
							<button
								type="button"
								className="flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[oklch(1_0_0/0.14)] bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] text-muted-foreground hover:border-success hover:text-foreground"
								onClick={() => inputRef.current?.click()}
								disabled={busy}
							>
								<Upload className="size-5" />
								<span className="text-xs font-medium">Choose one or more files</span>
								<span className="font-mono text-[9px]">JSON · Markdown · CSV · HTML · documents</span>
							</button>
							<button type="button" className="cs-btn-ghost self-center" onClick={chooseDesktop} disabled={busy}>
								Choose from desktop
							</button>
							<input
								ref={inputRef}
								type="file"
								multiple
								className="hidden"
								accept=".txt,.md,.markdown,.json,.html,.htm,.csv,.doc,.docx,.docm,.odt,.rtf,.pdf,.ppt,.pptx,.ppsx,.odp,.epub,.xls,.xlsx,.xlsm,.ods"
								onChange={(event) => choose(event.target.files)}
							/>
							{selectedCount > 0 && (
								<div className="flex flex-col gap-1 rounded-md bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] p-2 font-mono text-[10px]">
									{files.map((file) => (
										<span key={`${file.name}:${file.size}`} className="truncate">
											{file.name} · {(file.size / 1024).toFixed(0)} KB
										</span>
									))}
									{desktopPaths.map((path) => (
										<span key={path} className="truncate">
											{path.split(/[\\/]/).pop() ?? path} · desktop path
										</span>
									))}
								</div>
							)}
							<label className="cs-field">
								<span className="cs-field__label">If a content hash already exists</span>
								<select
									className="cs-field__input"
									value={duplicateMode}
									onChange={(event) => setDuplicateMode(event.target.value as typeof duplicateMode)}
									disabled={busy}
								>
									<option value="skip">Skip duplicate</option>
									<option value="replace">Replace and re-index</option>
									<option value="reimport">Import as a new source</option>
								</select>
							</label>
							{busy && (
								<div className="cs-field__hint" aria-live="polite">
									Importing {selectedCount} {selectedCount === 1 ? "file" : "files"}…
								</div>
							)}
							{result && (
								<div className="flex flex-col gap-2" aria-live="polite">
									<div className="cs-field__hint">
										Imported {result.imported}; failed {result.failed}.
									</div>
									<div className="flex flex-col gap-1 rounded-md bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] p-2 text-[10px]">
										{result.files.map((file) => (
											<div key={`${file.fileName}:${file.status}`} className="flex items-start justify-between gap-2">
												<span className="min-w-0 truncate font-mono">{file.fileName}</span>
												<span className={file.status === "failed" ? "text-destructive" : "text-success"}>
													{file.status === "failed"
														? file.error
														: file.status === "duplicate"
															? "duplicate"
															: "indexed"}
												</span>
											</div>
										))}
									</div>
									{result.failed > 0 && (
										<button type="button" className="cs-btn-ghost self-start" onClick={retryFailed} disabled={busy}>
											<RotateCcw className="size-3" />
											Retry failed
										</button>
									)}
								</div>
							)}
						</>
					) : (
						<>
							<div className="cs-field">
								<span className="cs-field__label">{FIELD[kind].label}</span>
								<div className="flex gap-2">
									<input
										className="cs-field__input"
										value={target}
										onChange={(event) => setTarget(event.target.value)}
										placeholder={FIELD[kind].placeholder}
										aria-label={FIELD[kind].label}
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
									onChange={(event) => setName(event.target.value)}
									placeholder={KINDS.find((item) => item.id === kind)?.namePlaceholder}
									aria-label="Display name (optional)"
								/>
							</div>
							{kind !== "obsidian" && (
								<div className="cs-field">
									<span className="cs-field__label">Token ref{kind === "github" ? " (optional)" : ""}</span>
									<input
										className="cs-field__input"
										value={tokenRef}
										onChange={(event) => setTokenRef(event.target.value)}
										placeholder={kind === "github" ? "GITHUB_TOKEN" : "DISCORD_BOT_TOKEN"}
										aria-label="Token secret name"
									/>
									<span className="cs-field__hint">Name of the secret holding your token</span>
								</div>
							)}
						</>
					)}
					{error && <div className="cs-error">{error}</div>}
				</div>
				<footer className="cs-foot">
					<button type="button" className="cs-btn-ghost" onClick={onClose} disabled={busy}>
						{kind === "files" ? "Close" : "Cancel"}
					</button>
					<button type="button" className="cs-btn-primary" onClick={submit} disabled={submitDisabled}>
						{busy && <Loader2 className="size-3.5 animate-spin" />}
						{kind === "files" ? "Import & index" : "Connect & index"}
					</button>
				</footer>
			</dialog>
		</div>
	);
}
