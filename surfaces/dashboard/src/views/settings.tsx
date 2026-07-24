import { useEffect, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Search, X, Download } from "lucide-react";
import { useSettings, type SettingsSection } from "@/lib/settings-context";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";

const NAV: { id: SettingsSection; label: string }[] = [
	{ id: "network", label: "Network" },
	{ id: "inference", label: "Inference" },
	{ id: "logs", label: "Logs" },
];

const PROVIDERS = [
	"Anthropic",
	"OpenAI",
	"Voyage AI",
	"Google",
	"Cohere",
	"Mistral",
	"Groq",
	"Together AI",
	"DeepSeek",
	"Fireworks AI",
	"OpenRouter",
	"Ollama",
	"ACPX",
	"Perplexity",
	"LocalAI",
];

export function SettingsModal() {
	const { open, setOpen, section, setSection } = useSettings();
	// Esc closes (Dialog handles this); ⌘, opens (handled in layout).
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				className="sig-modal flex h-[560px] max-h-[calc(100vh-48px)] w-[840px] max-w-[calc(100vw-48px)] gap-0 overflow-hidden rounded-[12px] border border-[oklch(1_0_0/0.1)] bg-card p-0 [html:not(.dark)_&]:border-[oklch(0_0_0/0.1)]"
				showCloseButton={false}
			>
				{/* internal sidebar */}
				<aside className="flex w-[220px] shrink-0 flex-col gap-1 border-r border-[oklch(1_0_0/0.06)] bg-[color-mix(in_oklch,var(--background)_60%,var(--card))] p-3 pt-4.5 [html:not(.dark)_&]:border-[oklch(0_0_0/0.06)]">
					<div className="px-2.5 pb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
						Settings
					</div>
					{NAV.map((n) => (
						<button
							key={n.id}
							type="button"
							onClick={() => setSection(n.id)}
							className={cn(
								"rounded-[var(--radius)] px-2.5 py-2 text-left text-[13px] transition-colors",
								section === n.id
									? "bg-[color-mix(in_oklch,var(--foreground)_9%,transparent)] font-medium text-foreground shadow-[inset_0_1px_0_oklch(1_0_0/0.08)]"
									: "text-muted-foreground hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground",
							)}
						>
							{n.label}
						</button>
					))}
				</aside>

				<div className="flex min-w-0 flex-1 flex-col">
					<DialogHeader className="flex-row items-center justify-between border-b border-[oklch(1_0_0/0.06)] px-5 py-4 [html:not(.dark)_&]:border-[oklch(0_0_0/0.06)]">
						<DialogTitle className="text-[15px] font-semibold tracking-tight">
							{NAV.find((n) => n.id === section)?.label}
						</DialogTitle>
						<div className="flex items-center gap-2.5">
							<span className="sig-esc-pill hidden sm:inline-flex">Esc</span>
							<button
								type="button"
								onClick={() => setOpen(false)}
								className="grid size-7 place-items-center rounded-[var(--radius)] text-muted-foreground hover:bg-[var(--active-overlay)] hover:text-foreground"
								aria-label="Close"
							>
								<X className="size-4" />
							</button>
						</div>
					</DialogHeader>

					<div className="flex-1 min-h-0 overflow-y-auto p-5">
						{section === "network" && <NetworkSection />}
						{section === "inference" && <InferenceSection />}
						{section === "logs" && <LogsSection />}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function NetworkSection() {
	const status = useAsync(() => api.getStatus()).data;
	const [cloudSync, setCloudSync] = useState(false);
	const [autoCommit, setAutoCommit] = useState(true);
	return (
		<div className="flex flex-col gap-3">
			<div className="px-1.5 pb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[oklch(0.42_0_0)] dark:text-[oklch(0.62_0_0)]">
				Daemon
			</div>
			<div className="sig-mcard flex flex-col gap-px">
				<Field label="Listen port" hint="Daemon HTTP port">
					<ControlValue value={String(status?.port ?? "3850")} />
				</Field>
				<Field label="Bind address" hint="Network interface">
					<ControlValue value={status?.bindHost ?? "0.0.0.0"} />
				</Field>
				<Field label="Network mode" hint="local · tailscale · hybrid">
					<ControlValue value={status?.networkMode ?? "local"} />
				</Field>
			</div>
			<div className="mt-2 px-1.5 pb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[oklch(0.42_0_0)] dark:text-[oklch(0.62_0_0)]">
				Sync
			</div>
			<div className="sig-mcard flex flex-col gap-px">
				<ToggleRow
					label="Cloud sync"
					desc="Sync workspace state across devices"
					checked={cloudSync}
					onChange={setCloudSync}
				/>
				<ToggleRow
					label="Auto-commit changes"
					desc="Commit workspace changes to git automatically"
					checked={autoCommit}
					onChange={setAutoCommit}
				/>
			</div>
		</div>
	);
}

function InferenceSection() {
	const [filter, setFilter] = useState("");
	const [connected] = useState<Set<string>>(new Set(["Anthropic"]));
	return (
		<div className="flex flex-col gap-2">
			<div className="mb-2 flex h-7.5 items-center gap-2 rounded-[var(--radius)] border border-[oklch(1_0_0/0.16)] bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] px-2.5">
				<Search className="size-3.5 text-muted-foreground" />
				<input
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder="Search providers…"
					className="w-full border-0 bg-transparent text-[11.5px] outline-none placeholder:text-muted-foreground"
				/>
			</div>
			<div className="grid max-h-[280px] grid-cols-2 gap-1.5 overflow-y-auto pr-0.5 pb-4 [mask-image:linear-gradient(to_bottom,#000_calc(100%-24px),transparent_100%)]">
				{PROVIDERS.filter((p) => p.toLowerCase().includes(filter.toLowerCase())).map((p) => {
					const isOn = connected.has(p);
					return (
						<div
							key={p}
							className={cn(
								"flex items-center gap-2.25 rounded-[var(--radius)] border border-[oklch(1_0_0/0.06)] bg-[color-mix(in_oklch,var(--foreground)_2%,transparent)] px-2.5 py-2 transition-colors hover:border-[oklch(1_0_0/0.14)]",
							)}
						>
							<span
								className={cn(
									"size-1.75 shrink-0 rounded-full",
									isOn
										? "bg-success shadow-[0_0_0_3px_color-mix(in_oklch,var(--success)_16%,transparent),0_0_8px_color-mix(in_oklch,var(--success)_60%,transparent)] [animation:dot-pulse_2.6s_ease-in-out_infinite]"
										: "bg-[oklch(0.38_0_0)]",
								)}
							/>
							<span className="flex min-w-0 flex-1 flex-col gap-px">
								<span className="truncate text-[12px] font-medium leading-tight">{p}</span>
								<span className="truncate font-mono text-[9px] text-muted-foreground">
									{isOn ? "Connected · OAuth" : "API key required"}
								</span>
							</span>
							<button
								type="button"
								className="shrink-0 rounded-[var(--radius)] border border-[oklch(1_0_0/0.16)] px-2 py-1.25 font-mono text-[9.5px] font-medium text-muted-foreground transition-colors hover:border-[oklch(1_0_0/0.3)] hover:text-foreground"
							>
								{isOn ? "Disconnect" : "Connect"}
							</button>
						</div>
					);
				})}
			</div>
		</div>
	);
}

type LogLevel = "info" | "warn" | "error" | "debug";
interface LogLine {
	t: string;
	lvl: LogLevel;
	scope: string;
	msg: React.ReactNode;
	raw?: string;
}

function LogsSection() {
	const [level, setLevel] = useState<LogLevel | "all">("all");
	const [query, setQuery] = useState("");
	const [openRaw, setOpenRaw] = useState<number | null>(null);

	const filtered = LOGS.filter((l) => {
		if (level !== "all" && l.lvl !== level) return false;
		if (query) {
			const hay = `${typeof l.msg === "string" ? l.msg : ""} ${l.scope} ${l.lvl}`.toLowerCase();
			if (!hay.includes(query.toLowerCase())) return false;
		}
		return true;
	});

	function exportLogs() {
		const data = filtered.map((l) => ({
			timestamp: l.t,
			level: l.lvl,
			message: typeof l.msg === "string" ? l.msg : "",
			raw: l.raw ?? "",
		}));
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `signet-logs-${Date.now()}.json`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}

	return (
		<div className="-m-5 flex h-full flex-col">
			<div className="flex items-center gap-2.5 border-b border-[oklch(1_0_0/0.06)] px-6 py-3 [html:not(.dark)_&]:border-[oklch(0_0_0/0.06)]">
				<div className="flex gap-px rounded-[var(--radius)] border border-[oklch(1_0_0/0.08)] bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] p-0.75">
					{(["all", "info", "warn", "error", "debug"] as const).map((l) => (
						<button
							key={l}
							type="button"
							onClick={() => {
								setLevel(l);
								setOpenRaw(null);
							}}
							className={cn(
								"rounded-[calc(var(--radius)-2px)] px-2.25 py-1 font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em] transition-colors",
								level === l
									? "bg-[var(--active-overlay)] text-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{l}
						</button>
					))}
				</div>
				<div className="flex h-7 items-center gap-1.75 rounded-[var(--radius)] border border-[oklch(1_0_0/0.1)] bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] px-2.5">
					<Search className="size-3 text-muted-foreground" />
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Filter…"
						className="w-[130px] border-0 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
					/>
				</div>
				<div className="flex-1" />
				<button
					type="button"
					onClick={exportLogs}
					className="flex items-center gap-1.5 rounded-[var(--radius)] border border-[oklch(1_0_0/0.1)] px-2.5 py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:border-[oklch(1_0_0/0.22)] hover:text-foreground"
				>
					<Download className="size-3" /> Export
				</button>
			</div>
			<div className="flex-1 min-h-0 overflow-y-auto font-mono text-[11px] leading-[1.7] [mask-image:linear-gradient(180deg,#000_0,#000_calc(100%-20px),transparent_100%)]">
				{filtered.map((l, i) => (
					<div key={i}>
						<button
							type="button"
							onClick={() => setOpenRaw(openRaw === i ? null : i)}
							className={cn(
								"grid w-full cursor-pointer items-baseline gap-0 border-b border-[oklch(1_0_0/0.03)] px-6 py-0.75 text-left transition-colors [html:not(.dark)_&]:border-[oklch(0_0_0/0.03)] hover:bg-[var(--accent-subtle)]",
								l.lvl === "error" && "hover:bg-[oklch(0.4_0.15_25/0.08)]",
								l.lvl === "warn" && "hover:bg-[oklch(0.5_0.15_85/0.06)]",
							)}
							style={{ gridTemplateColumns: "88px 52px 84px 1fr" }}
						>
							<span className="pr-3 text-[oklch(0.5_0_0)] [html:not(.dark)_&]:text-[oklch(0.55_0_0)]">{l.t}</span>
							<span
								className={cn(
									"pr-3 text-[10px] font-semibold",
									l.lvl === "info" && "text-[oklch(0.7_0.1_220)]",
									l.lvl === "warn" && "rounded bg-[oklch(0.7_0.15_85/0.12)] px-1.5 text-[oklch(0.82_0.15_85)]",
									l.lvl === "error" && "rounded bg-[oklch(0.6_0.2_25/0.14)] px-1.5 text-[oklch(0.78_0.19_25)]",
									l.lvl === "debug" && "text-[oklch(0.55_0_0)] [html:not(.dark)_&]:text-[oklch(0.5_0_0)]",
								)}
							>
								{l.lvl.toUpperCase()}
							</span>
							<span className="overflow-hidden pr-3 text-ellipsis text-[10.5px] text-[oklch(0.62_0_0)] [html:not(.dark)_&]:text-[oklch(0.42_0_0)]">
								{l.scope}
							</span>
							<span className="overflow-hidden text-ellipsis whitespace-nowrap text-[oklch(0.82_0_0)] [html:not(.dark)_&]:text-[oklch(0.25_0_0)] [&_.path]:text-[oklch(0.6_0_0)]">
								{l.msg}
							</span>
						</button>
						{openRaw === i && l.raw && (
							<pre className="mx-6 my-1 max-h-40 overflow-auto rounded-[var(--radius)] border border-[oklch(1_0_0/0.08)] bg-[oklch(0.14_0_0)] p-3.5 font-mono text-[10px] leading-[1.6] [html:not(.dark)_&]:border-[oklch(0_0_0/0.08)] [html:not(.dark)_&]:bg-[oklch(0.96_0_0)]">
								{l.raw}
							</pre>
						)}
					</div>
				))}
			</div>
		</div>
	);
}

/* ── helpers ── */

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-4 rounded-[var(--radius)] px-2.5 py-2.25 hover:bg-[var(--accent-subtle)]">
			<div className="min-w-0">
				<div className="text-[13px] font-medium">{label}</div>
				{hint && <div className="mt-0.5 text-[11.5px] leading-tight text-muted-foreground">{hint}</div>}
			</div>
			{children}
		</div>
	);
}

function ControlValue({ value }: { value: string }) {
	return (
		<div className="flex h-7.5 w-[220px] shrink-0 items-center justify-between rounded-[var(--radius)] border border-[oklch(1_0_0/0.16)] bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] px-2.5 font-mono text-[11.5px] [html:not(.dark)_&]:border-[oklch(0_0_0/0.14)]">
			<span className="font-medium">{value}</span>
		</div>
	);
}

function ToggleRow({
	label,
	desc,
	checked,
	onChange,
}: {
	label: string;
	desc: string;
	checked: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		<div className="flex items-center justify-between gap-4 rounded-[var(--radius)] px-2.5 py-2.25 hover:bg-[var(--accent-subtle)]">
			<div className="min-w-0">
				<div className="text-[13px] font-medium">{label}</div>
				<div className="mt-0.5 text-[11.5px] leading-tight text-muted-foreground">{desc}</div>
			</div>
			<Switch checked={checked} onCheckedChange={onChange} />
		</div>
	);
}

// Keyboard: ⌘, opens settings (wired in the layout).
export function useSettingsHotkey() {
	const { open, setOpen } = useSettings();
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "," && (e.metaKey || e.ctrlKey) && !open) {
				e.preventDefault();
				setOpen(true);
			}
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open, setOpen]);
}

// Log sample (mockup's telemetry; the daemon log stream endpoint is §4-gap).
const LOGS: LogLine[] = [
	{ t: "09:14:32.104", lvl: "info", scope: "daemon", msg: <span>pipeline cycle complete · <span className="path">extraction → decision → graph → retention</span> in 412ms</span> },
	{ t: "09:14:30.891", lvl: "info", scope: "ontology", msg: <span>applied claim <span className="path">entity_dependencies[signet:dashboard]</span></span> },
	{ t: "09:14:28.340", lvl: "debug", scope: "embedding", msg: "cosine fallback · 14 chunks · sqlite-vec not available" },
	{ t: "09:14:25.002", lvl: "warn", scope: "source", msg: "discord:team partial fetch · 3 channels returned 403" },
	{ t: "09:14:22.718", lvl: "info", scope: "source", msg: "obsidian:nicholai-vault resync complete · 4,291 artifacts, 0 changed" },
	{ t: "09:14:18.503", lvl: "info", scope: "source", msg: <span>github:Signet-AI/signetai index job · <span className="path">847/1204</span></span> },
	{ t: "09:14:10.994", lvl: "info", scope: "session", msg: "claude-code session summarized · 142 turns → 8 memories extracted" },
	{ t: "09:14:08.331", lvl: "error", scope: "connector", msg: "pi-extension health check failed · x-signet-runtime-path header missing on 2 hooks" },
	{ t: "09:14:05.107", lvl: "warn", scope: "source", msg: "discord:team checkpoint stale · last successful backfill cursor 2h ago" },
	{ t: "09:14:02.844", lvl: "info", scope: "graph", msg: "community detection complete · 8 communities, modularity 0.74" },
	{ t: "09:13:58.612", lvl: "debug", scope: "retention", msg: "decay pass · 142 memories evaluated, 3 downweighted, 0 purged" },
	{ t: "09:13:48.774", lvl: "warn", scope: "auth", msg: "rate limit approaching · agent:hermes · 84/100 requests in window" },
	{ t: "09:13:40.118", lvl: "info", scope: "ontology", msg: "proposal created · merge-plan[entity:signet ↔ entity:dashboard] · pending review" },
	{ t: "09:13:35.890", lvl: "error", scope: "source", msg: "discord:team gateway reconnect failed · code 4004 authentication failed" },
];
