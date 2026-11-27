import { useId, useState } from "react";
import { Panel } from "@/components/shell/panel";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/field";
import { api } from "@/lib/api";
import { parsePersonalMemories, personalMemoryCopy, type PersonalMemory } from "@/lib/personal-memory-copy";
import { usePanelQuery } from "@/lib/use-panel-query";

export function PersonalMemoryCopy({ agentId }: { readonly agentId: string }) {
	const sourceAgentId = useId();
	const classificationId = useId();
	const { result, refresh } = usePanelQuery<readonly { id: string; name: string }[]>("/api/classifications");
	const [rows, setRows] = useState<readonly PersonalMemory[]>([]);
	const [sourceAgent, setSourceAgent] = useState("");
	const [selected, setSelected] = useState<readonly string[]>([]);
	const [classification, setClassification] = useState("");
	const [preview, setPreview] = useState<File | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);
	const load = async (file: File | undefined) => {
		setRows([]);
		setSelected([]);
		setPreview(null);
		setCopied(false);
		setError(null);
		if (!file) return;
		try {
			if (file.size > 4 * 1024 * 1024) throw new Error("Export exceeds 4 MiB");
			const memories = parsePersonalMemories(await file.text());
			setRows(memories);
			setSourceAgent(memories[0]?.agent_id ?? "");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Invalid export");
		}
	};
	const copy = async () => {
		if (!preview || busy) return;
		setBusy(true);
		setError(null);
		const response = await api.importSources([preview], "skip", [], {
			agentId,
			classificationId: classification || undefined,
		});
		setBusy(false);
		if (!response.ok || !response.data || response.data.failed)
			setError(response.error ?? "The import did not finish. Review the destination and retry.");
		else {
			setCopied(true);
			setPreview(null);
			setSelected([]);
		}
	};
	return (
		<section aria-label="Copy personal memories" className="flex flex-col gap-4 text-small">
			<p>
				Copying is optional. Nothing is selected or sent automatically. Your local workspace and original memories stay
				unchanged.
			</p>
			<p>
				On your personal machine, use <code>signet --local export</code> and choose its memories.jsonl file below. Only
				the selected records are uploaded as evidence. Original IDs, authors, source fields and timestamps remain
				provenance, never organization identity or restored semantic claims.
			</p>
			<label className="flex flex-col gap-2">
				Personal memory export (up to 4 MiB, 1,000 memories)
				<input
					type="file"
					accept=".jsonl,.ndjson"
					disabled={busy}
					onChange={(event) => void load(event.target.files?.[0])}
				/>
			</label>
			{rows.length > 0 && (
				<>
					<label className="flex flex-col gap-2" htmlFor={sourceAgentId}>
						Original agent
						<NativeSelect
							id={sourceAgentId}
							value={sourceAgent}
							disabled={busy}
							onChange={(event) => {
								setSourceAgent(event.target.value);
								setSelected([]);
								setPreview(null);
							}}
						>
							{[...new Set(rows.map((row) => row.agent_id))].map((id) => (
								<option key={id} value={id}>
									{id}
								</option>
							))}
						</NativeSelect>
					</label>
					<div className="max-h-64 overflow-auto divide-y rounded-lg border">
						{rows
							.filter((row) => row.agent_id === sourceAgent)
							.map((row) => (
								<label key={row.id} className="flex items-start gap-3 p-3">
									<input
										type="checkbox"
										disabled={busy}
										checked={selected.includes(row.id)}
										onChange={(event) => {
											setSelected(
												event.target.checked ? [...selected, row.id] : selected.filter((id) => id !== row.id),
											);
											setPreview(null);
										}}
									/>
									<span className="min-w-0 break-words">{row.content}</span>
								</label>
							))}
					</div>
					<Panel result={result} onRetry={refresh}>
						{(classifications) => (
							<label className="flex flex-col gap-2" htmlFor={classificationId}>
								Destination classification
								<NativeSelect
									id={classificationId}
									value={classification}
									disabled={busy}
									onChange={(event) => {
										setClassification(event.target.value);
										setPreview(null);
									}}
								>
									<option value="">Unclassified — organization visibility rules apply</option>
									{classifications.map((item) => (
										<option key={item.id} value={item.id}>
											{item.name}
										</option>
									))}
								</NativeSelect>
							</label>
						)}
					</Panel>
					<Button
						className="self-start"
						disabled={!selected.length || busy || !result?.data}
						onClick={() => {
							setError(null);
							try {
								setPreview(personalMemoryCopy(rows, selected, sourceAgent));
							} catch (cause) {
								setError(cause instanceof Error ? cause.message : "Invalid selection");
							}
						}}
					>
						Preview selected copy
					</Button>
				</>
			)}
			{preview && (
				<div className="flex flex-col gap-3 rounded-lg border p-4">
					<p role="status">
						Dry run: {selected.length} selected memories, {preview.size} bytes of evidence to {agentId}. No data has
						been uploaded. The destination rechecks access and classification admission when you confirm.
					</p>
					<ul className="list-disc pl-4">
						{rows
							.filter((row) => row.agent_id === sourceAgent && selected.includes(row.id))
							.map((row) => (
								<li key={row.id} className="break-words">
									{row.content}
								</li>
							))}
					</ul>
					<Button className="self-start" disabled={busy} onClick={() => void copy()}>
						{busy ? "Copying evidence…" : "Copy selected memories"}
					</Button>
				</div>
			)}
			{copied && (
				<p role="status">
					Evidence copied. Originals are unchanged. Dreaming derives organization memory from the imported evidence.
				</p>
			)}
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
		</section>
	);
}
