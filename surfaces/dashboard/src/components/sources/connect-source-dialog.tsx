/**
 * Unified source dialog — file imports and connector-backed sources share one
 * centered picker and modal shell. The daemon contracts stay in the api client;
 * this component only chooses the existing transport and submit path.
 */
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { sourceLogo } from "@/components/icons";
import { type ImportSourcesResponse, api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { FolderOpen, Globe, Loader2, MessageCircle, RotateCcw, Upload, X } from "@/components/mingcute-icons";
import { useEffect, useRef, useState } from "react";

export type SourceKind = "files" | "web" | "transcripts" | "obsidian" | "github" | "discord";

const IMPORT_KINDS: readonly { id: "files" | "web" | "transcripts"; label: string; description: string }[] = [
	{ id: "files", label: "Files", description: "Import documents and notes" },
	{ id: "web", label: "Web page", description: "Extract a readable page from a public URL" },
	{ id: "transcripts", label: "Agent transcripts", description: "Import lossless JSONL transcript exports" },
];

const CONNECT_KINDS: readonly { id: "obsidian" | "github" | "discord"; label: string; namePlaceholder: string }[] = [
	{ id: "obsidian", label: "Obsidian", namePlaceholder: "Research Vault" },
	{ id: "github", label: "GitHub", namePlaceholder: "Signet GitHub" },
	{ id: "discord", label: "Discord", namePlaceholder: "Team Discord" },
];

const FIELD: Record<Exclude<SourceKind, "files">, { label: string; placeholder: string; hint: string }> = {
	web: {
		label: "Public URL",
		placeholder: "https://example.com/article",
		hint: "Only public http(s) pages are fetched. Signet stores the extracted Markdown with the original URL.",
	},
	transcripts: {
		label: "Target agent",
		placeholder: "Select an agent",
		hint: "Choose which agent should own these conversations.",
	},
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
		hint: "Requires a bot token stored in Secrets. Enter the token secret below.",
	},
};

function validate(kind: Exclude<SourceKind, "files">, target: string, tokenRef: string): string | null {
	const value = target.trim();
	if (kind === "transcripts") return value ? null : "Select a target agent";
	if (kind === "web") {
		try {
			const url = new URL(value);
			if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
				return "Enter a public http(s) URL";
			if (["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase())) return "Enter a public http(s) URL";
			return null;
		} catch {
			return "Enter a valid public http(s) URL";
		}
	}
	if (kind === "obsidian") {
		if (!value) return "Enter a vault path";
		if (!/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value)) return "Enter an absolute vault path";
		return null;
	}
	if (kind === "github") {
		if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_*.-]+$/.test(value)) return "Use owner/repo or owner/*";
		return null;
	}
	if (!/^\d{17,20}$/.test(value)) return "Enter a 17–20 digit Guild ID";
	if (!tokenRef.trim()) return "Enter the Discord token secret name";
	return null;
}

function KindIcon({ kind, className = "size-5" }: { readonly kind: SourceKind; readonly className?: string }) {
	if (kind === "files") return <Upload className={className} />;
	if (kind === "web") return <Globe className={className} />;
	if (kind === "transcripts") return <MessageCircle className={className} />;
	return sourceLogo(kind, { className });
}

function sourceLabel(kind: SourceKind): string {
	return [...IMPORT_KINDS, ...CONNECT_KINDS].find((item) => item.id === kind)?.label ?? kind;
}

function sourceDescription(kind: SourceKind): string {
	if (kind === "files") return "Import documents and notes";
	if (kind === "web") return "Extract a readable page from a public URL";
	if (kind === "transcripts") return "Import lossless JSONL transcript exports";
	if (kind === "obsidian") return "Index a local vault";
	if (kind === "github") return "Index repositories and issues";
	return "Index messages from a Discord server";
}

export function ConnectSourceDialog({
	open,
	onClose,
	onConnected,
	embedded = false,
	initialKind,
	onBusyChange,
}: {
	open: boolean;
	onClose: () => void;
	onConnected: () => void;
	embedded?: boolean;
	initialKind?: SourceKind;
	onBusyChange?: (busy: boolean) => void;
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
	const [transcriptJobId, setTranscriptJobId] = useState<string | null>(null);
	const [agents, setAgents] = useState<readonly { id: string; name: string }[]>([]);

	useEffect(() => {
		if (!open) return;
		void api.getAgents().then((response) => {
			if (response.data) setAgents(response.data.agents.map((agent) => ({ id: agent.id, name: agent.name })));
		});
	}, [open]);

	useEffect(() => {
		if (!open) return;
		setKind(initialKind ?? "files");
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
		setTranscriptJobId(null);
		if (inputRef.current) inputRef.current.value = "";
	}, [open, initialKind]);

	useEffect(() => {
		onBusyChange?.(busy || browsing);
		return () => onBusyChange?.(false);
	}, [busy, browsing, onBusyChange]);

	useEffect(() => {
		if (!open || embedded) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !busy) {
				event.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [busy, onClose, open, embedded]);

	if (!open) return null;

	const choose = (selected: FileList | null) => {
		if (!selected) return;
		setFiles(Array.from(selected));
		setDesktopPaths([]);
		setResult(null);
		setError(null);
	};

	const selectKind = (selected: SourceKind) => {
		setKind(selected);
		setError(null);
		setResult(null);
	};

	const importFiles = async (targetFiles: readonly File[], targetPaths: readonly string[] = []) => {
		if (kind === "transcripts") {
			if (!targetFiles.length) {
				setError("Choose one or more JSONL transcript files");
				return;
			}
			const selectedAgent = target.trim();
			const problem = validate(kind, selectedAgent, "");
			if (problem) {
				setError(problem);
				return;
			}
			setBusy(true);
			setError(null);
			const created = await api.createSourceImport(selectedAgent, targetFiles, duplicateMode);
			if (!created.data) {
				setBusy(false);
				setError(created.error ?? "Could not create import job");
				return;
			}
			const jobId = created.data.jobId ?? created.data.id;
			if (!jobId) {
				setBusy(false);
				setError("Daemon returned no job ID");
				return;
			}
			setTranscriptJobId(jobId);
			for (const [index, file] of targetFiles.entries()) {
				const fileId = created.data.files?.[index]?.id;
				if (!fileId) {
					setBusy(false);
					setError(`Job ${jobId}: daemon returned no file id for ${file.name}`);
					return;
				}
				const uploaded = await api.uploadSourceImportFile(selectedAgent, jobId, fileId, file);
				if (uploaded.error) {
					setBusy(false);
					setError(`Job ${jobId}: ${uploaded.error}`);
					return;
				}
			}
			const started = await api.controlSourceImport(jobId, "start");
			setBusy(false);
			if (!started) {
				setError(`Job ${jobId}: could not start import`);
				return;
			}
			onConnected();
			return;
		}
		if (targetFiles.length === 0 && targetPaths.length === 0) return;
		if (busy) return;
		setBusy(true);
		setError(null);
		setResult(null);
		const response = await api.importSources(targetFiles, duplicateMode, targetPaths);
		setBusy(false);
		if (!response.ok || !response.data) {
			setError(response.error ?? "Unable to import files. Try again.");
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
			setError(response.error ?? "Choose files from the browser or desktop app.");
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
		else if (response.unavailable) setError("Choose a folder from the desktop app.");
		else setError("Select a folder to continue.");
	};

	const connect = async () => {
		if (kind === "files" || kind === "transcripts") return;
		const problem = validate(kind, target, tokenRef);
		if (problem) {
			setError(problem);
			return;
		}
		setBusy(true);
		setError(null);
		const displayName = name.trim() || undefined;
		const body =
			kind === "web"
				? { url: target.trim() }
				: kind === "obsidian"
					? { root: target.trim(), name: displayName }
					: kind === "github"
						? { repo: target.trim(), name: displayName, tokenRef: tokenRef.trim() || undefined }
						: { guildId: target.trim(), name: displayName, tokenRef: tokenRef.trim() };
		const response = await api.addSource(kind, body);
		setBusy(false);
		if (!response.ok) {
			setError(response.error ?? "Unable to connect the source. Try again.");
			return;
		}
		onConnected();
		onClose();
	};

	const submit = () => {
		if (kind === "files" || kind === "transcripts") void importFiles(files, desktopPaths);
		else void connect();
	};

	const selectedCount = files.length + desktopPaths.length;
	const submitDisabled =
		busy ||
		(kind === "files" && selectedCount === 0) ||
		(kind === "transcripts" && (selectedCount === 0 || !target.trim())) ||
		(kind === "web" && !target.trim());

	const Panel = embedded ? "div" : "dialog";
	return (
		<div
			className={embedded ? "onboarding-source" : "cs-backdrop"}
			role="presentation"
			onClick={(event) => {
				if (event.target === event.currentTarget && !busy) onClose();
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape" && !busy) {
					event.stopPropagation();
					onClose();
				}
			}}
		>
			<Panel
				open={embedded ? undefined : true}
				className="cs-panel cs-panel--source"
				role={embedded ? undefined : "dialog"}
				aria-modal={embedded ? undefined : true}
				aria-label="Connect a source"
			>
				<header className="cs-head">
					<span className="cs-title">Add a source</span>
					<button type="button" className="cs-close" onClick={onClose} disabled={busy} aria-label="Close">
						<X className="size-4" />
					</button>
				</header>
				<div className="cs-body cs-body--source">
					<div className="cs-layout">
						{!embedded && (
							<aside className="cs-source-list" aria-label="Source types">
								<div className="cs-source-list__title">Sources</div>
								<div className="cs-source-list__group">Import</div>
								{IMPORT_KINDS.map((item) => (
									<button
										key={item.id}
										type="button"
										className={cn("cs-source-item", kind === item.id && "is-on")}
										onClick={() => selectKind(item.id)}
										aria-pressed={kind === item.id}
									>
										<span className="cs-source-item__icon">
											<KindIcon kind={item.id} className="size-4" />
										</span>
										<span className="cs-source-item__copy">
											<span className="cs-source-item__label">{item.label}</span>
											<span className="cs-source-item__description">{item.description}</span>
										</span>
									</button>
								))}
								<div className="cs-source-list__group">Connect</div>
								{CONNECT_KINDS.map((item) => (
									<button
										key={item.id}
										type="button"
										className={cn("cs-source-item", kind === item.id && "is-on")}
										onClick={() => selectKind(item.id)}
										aria-pressed={kind === item.id}
									>
										<span className="cs-source-item__icon">
											<KindIcon kind={item.id} className="size-4" />
										</span>
										<span className="cs-source-item__copy">
											<span className="cs-source-item__label">{item.label}</span>
											<span className="cs-source-item__description">{sourceDescription(item.id)}</span>
										</span>
									</button>
								))}
							</aside>
						)}
						<section className="cs-options" aria-label={`${sourceLabel(kind)} options`}>
							<div className="cs-options__head">
								<div className="cs-options__title">
									{kind === "files" ? "Import files" : `Connect ${sourceLabel(kind)}`}
								</div>
							</div>
							{kind === "files" || kind === "transcripts" ? (
								<>
									<button
										type="button"
										className="flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[oklch(1_0_0/0.14)] bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] text-muted-foreground hover:border-success hover:text-foreground"
										onClick={() => inputRef.current?.click()}
										disabled={busy}
									>
										<Upload className="size-5" />
										<span className="text-xs font-medium">
											{kind === "transcripts" ? "Choose JSONL transcript files" : "Choose one or more files"}
										</span>
										<span className="font-mono text-[9px]">
											{kind === "transcripts" ? "Signet export JSONL" : "JSON · Markdown · CSV · HTML · documents"}
										</span>
									</button>
									{kind === "files" && (
										<button type="button" className="cs-btn-ghost self-center" onClick={chooseDesktop} disabled={busy}>
											Choose from desktop
										</button>
									)}
									<input
										ref={inputRef}
										type="file"
										multiple
										className="hidden"
										accept={
											kind === "transcripts"
												? ".jsonl"
												: ".txt,.md,.markdown,.json,.html,.htm,.csv,.doc,.docx,.docm,.odt,.rtf,.pdf,.ppt,.pptx,.ppsx,.odp,.epub,.xls,.xlsx,.xlsm,.ods"
										}
										onChange={(event) => choose(event.target.files)}
									/>
									{kind === "transcripts" && (
										<label className="cs-field">
											<span id="source-target-label" className="cs-field__label">
												Target agent
											</span>
											<Select value={target} onValueChange={setTarget} disabled={busy}>
												<SelectTrigger
													aria-label="Target agent"
													aria-labelledby="source-target-label"
													className="w-full"
												>
													<SelectValue placeholder="Choose an agent" />
												</SelectTrigger>
												<SelectContent
													position="popper"
													className="z-[60] max-h-64 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
												>
													{agents.map((agent) => (
														<SelectItem key={agent.id} value={agent.id}>
															{agent.name} ({agent.id})
														</SelectItem>
													))}
												</SelectContent>
											</Select>
											<span className="cs-field__hint">{FIELD.transcripts.hint}</span>
										</label>
									)}
									{embedded && selectedCount > 2 && (
										<span className="cs-field__hint">{selectedCount} files selected</span>
									)}
									{selectedCount > 0 && (
										<div className="flex flex-col gap-1 rounded-md bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] p-2 font-mono text-[10px]">
											{files.slice(0, embedded ? 2 : files.length).map((file) => (
												<span key={`${file.name}:${file.size}`} className="truncate">
													{file.name} · {(file.size / 1024).toFixed(0)} KB
												</span>
											))}
											{desktopPaths.slice(0, embedded ? 2 : desktopPaths.length).map((path) => (
												<span key={path} className="truncate">
													{path.split(/[\\/]/).pop() ?? path} · desktop path
												</span>
											))}
										</div>
									)}
									{!embedded && (
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
									)}
									{transcriptJobId && (
										<div className="cs-field__hint" aria-live="polite">
											Import job created: <code>{transcriptJobId}</code>
										</div>
									)}
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
													<div
														key={`${file.fileName}:${file.status}`}
														className="flex items-start justify-between gap-2"
													>
														<span className="min-w-0 truncate font-mono">{file.fileName}</span>
														<span className={file.status === "failed" ? "text-destructive" : "text-success"}>
															{file.status === "failed"
																? file.error
																: file.status === "duplicate"
																	? extractionLabel(file.extraction, "duplicate, existing result")
																	: extractionLabel(file.extraction, "indexed")}
														</span>
													</div>
												))}
											</div>
											{result.failed > 0 && (
												<button type="button" className="cs-btn-ghost self-start" onClick={retryFailed} disabled={busy}>
													<RotateCcw className="size-3" />
													Retry failed imports
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
													{browsing ? (
														<Loader2 className="size-3.5 animate-spin" />
													) : (
														<FolderOpen className="size-3.5" />
													)}
												</button>
											)}
										</div>
										<span className="cs-field__hint">{FIELD[kind].hint}</span>
									</div>
									{kind !== "web" && (
										<div className="cs-field">
											<span className="cs-field__label">Name</span>
											<input
												className="cs-field__input"
												value={name}
												onChange={(event) => setName(event.target.value)}
												placeholder={CONNECT_KINDS.find((item) => item.id === kind)?.namePlaceholder}
												aria-label="Display name (optional)"
											/>
										</div>
									)}
									{kind !== "obsidian" && kind !== "web" && (
										<div className="cs-field">
											<span className="cs-field__label">Token secret{kind === "github" ? " (optional)" : ""}</span>
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
						</section>
					</div>
				</div>
				<footer className="cs-foot">
					{!embedded && (
						<button type="button" className="cs-btn-ghost" onClick={onClose} disabled={busy}>
							Close
						</button>
					)}
					<button type="button" className="cs-btn-primary" onClick={submit} disabled={submitDisabled}>
						{busy && <Loader2 className="size-3.5 animate-spin" />}
						{kind === "files" || kind === "transcripts"
							? "Import & index"
							: kind === "web"
								? "Add & index"
								: "Connect & index"}
					</button>
				</footer>
			</Panel>
		</div>
	);
}

function extractionLabel(
	extraction:
		| {
				readonly documentEntityId: string | null;
				readonly aspectsCreated: number;
				readonly attributesCreated: number;
		  }
		| undefined,
	base: string,
): string {
	if (!extraction) return `${base}; extraction result unavailable`;
	const entity = extraction.documentEntityId ? "entity linked" : "no entity linked";
	return `${base}; ${extraction.aspectsCreated} aspects · ${extraction.attributesCreated} attributes · ${entity}`;
}
