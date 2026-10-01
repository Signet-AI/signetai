import { TextPageControls, usePagination } from "@/components/dashboard/pagination";
import { GroupLabel, SettingsGroup } from "@/components/settings/controls";
import { Button } from "@/components/ui/button";
import { api, type SourceImportJob } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { useState } from "react";

const JOB_STATES: Record<string, string> = {
	created: "Waiting to upload",
	uploading: "Uploading",
	ready: "Ready to import",
	running: "Importing",
	pending: "Queued",
	queued: "Queued",
	paused: "Paused",
	completed: "Complete",
	completed_with_rejections: "Complete with rejections",
	failed: "Failed",
	cancelled: "Cancelled",
	canceled: "Cancelled",
};
const PAGE_SIZE = 5;

function ImportJob({ job }: { job: SourceImportJob }) {
	const [expanded, setExpanded] = useState(false);
	const detail = useAsync(() => (expanded ? api.getSourceImport(job.id, job.agent_id) : Promise.resolve(null)), {
		key: expanded ? `source-import:${job.agent_id}:${job.id}` : undefined,
		deps: [expanded, job.id, job.agent_id],
		intervalMs: expanded ? 5_000 : undefined,
	});
	const current = detail.data?.data?.job ?? job;
	const files = detail.data?.data?.files ?? job.files;
	const progress = [
		current.imported !== undefined ? `${current.imported.toLocaleString()} imported` : null,
		current.total !== undefined ? `${current.total.toLocaleString()} total` : null,
		current.duplicate ? `${current.duplicate.toLocaleString()} duplicates` : null,
		current.rejected ? `${current.rejected.toLocaleString()} rejected` : null,
		current.pending ? `${current.pending.toLocaleString()} pending` : null,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<details className="group border-t border-border/60" onToggle={(event) => setExpanded(event.currentTarget.open)}>
			<summary className="cursor-pointer list-none py-3 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
				<div className="flex items-center justify-between gap-3">
					<span className="settings-row-title">{job.files?.[0]?.name || "File import"}</span>
					<span className="inline-flex items-center gap-3 text-xs text-muted-foreground">
						{JOB_STATES[current.state] || current.state.replaceAll("_", " ")}
						<span className="group-open:rotate-90" aria-hidden="true">
							›
						</span>
					</span>
				</div>
				<p className="settings-row-description">{progress || "Open for file details."}</p>
			</summary>
			<div className="pb-3 text-xs">
				<p className="mb-2 break-all text-muted-foreground">Import ID: {job.id}</p>
				{detail.loading && !detail.data ? (
					<p>Loading files…</p>
				) : files?.length ? (
					<ul className="space-y-2">
						{files.map((file) => (
							<li key={file.id} className="flex flex-wrap justify-between gap-2">
								<span className="min-w-0 break-all">{file.name || file.id}</span>
								<span className="text-muted-foreground">
									{file.state?.replaceAll("_", " ") || "Status unavailable"}
								</span>
							</li>
						))}
					</ul>
				) : (
					<p className="text-muted-foreground">File details are unavailable.</p>
				)}
			</div>
		</details>
	);
}

export function DurableImportStatus() {
	const imports = useAsync(() => api.getSourceImports(), { key: "source-imports", intervalMs: 5000 });
	const jobs = imports.data?.data?.imports;
	const { page, pages, visible, setPage } = usePagination(jobs ?? [], PAGE_SIZE);
	return (
		<SettingsGroup aria-label="Durable import status">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<GroupLabel>File imports</GroupLabel>
				<Button variant="outline" size="compact" disabled={imports.loading} onClick={() => imports.refresh()}>
					Refresh
				</Button>
			</div>
			<p className="settings-row-description mb-2">
				Track uploads and imports into Signet. Expand an import to see its files. Add new files through Connect a source
				on Home.
			</p>
			{imports.loading && !jobs ? (
				<p className="settings-row-description">Loading imports…</p>
			) : !jobs ? (
				<p role="status" className="settings-row-description">
					Could not load imports. Refresh to try again.
				</p>
			) : !jobs.length ? (
				<p className="settings-row-description">No file imports recorded.</p>
			) : (
				<>
					<p className="settings-row-description mb-2">
						{jobs.length} {jobs.length === 1 ? "import" : "imports"} recorded
					</p>
					{visible.map((job) => (
						<ImportJob key={job.id} job={job} />
					))}
					<TextPageControls
						page={page}
						pages={pages}
						onPage={setPage}
						className="justify-end gap-3 text-xs text-muted-foreground"
					/>
				</>
			)}
		</SettingsGroup>
	);
}
