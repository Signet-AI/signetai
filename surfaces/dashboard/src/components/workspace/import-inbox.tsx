import { api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";

export function DurableImportStatus() {
	const imports = useAsync(() => api.getSourceImports(), { intervalMs: 5000 });
	const jobs = imports.data?.data?.imports;
	return (
		<section aria-label="Durable import status" className="border-y border-border py-2.5">
			<div className="flex items-center justify-between gap-3">
				<span className="text-[12px] font-medium">Durable imports</span>
				<span className="font-mono text-[10px] text-muted-foreground">
					{imports.loading && !jobs ? "Loading…" : jobs ? `${jobs.length} tracked` : "Unavailable"}
				</span>
			</div>
			{!imports.loading && !jobs && (
				<p className="mt-1 text-[10px] text-muted-foreground">Unable to load import status.</p>
			)}
		</section>
	);
}
