import { useEffect, useState } from "react";
import { Popover } from "radix-ui";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type AssistantModelOption } from "@/lib/api";

export function ChatModelPicker({
	selection,
	onSelect,
	disabled,
}: {
	readonly selection?: AssistantModelOption;
	readonly onSelect: (model: AssistantModelOption | undefined) => void;
	readonly disabled: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [models, setModels] = useState<readonly AssistantModelOption[]>([]);
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	useEffect(() => {
		if (!open) return;
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		void api.getAssistantModels(controller.signal).then((result) => {
			if (controller.signal.aborted) return;
			setModels(result.data?.models ?? []);
			setError(result.error);
			setLoading(false);
		});
		return () => controller.abort();
	}, [open]);
	const filtered = models.filter((model) =>
		`${model.name} ${model.model} ${model.provider} ${model.account}`.toLowerCase().includes(query.toLowerCase()),
	);
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="chat-model-trigger"
					disabled={disabled}
					aria-label={`Chat model: ${selection?.name ?? "Signet default"}`}
				>
					<span>{selection?.name ?? "Signet default"}</span>
					<ChevronDownIcon className="size-3" />
				</Button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content side="top" align="start" sideOffset={8} className="chat-model-picker">
					<div className="chat-model-search">
						<SearchIcon size={14} aria-hidden="true" />
						<input
							aria-label="Search chat models"
							placeholder="Search connected models…"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</div>
					<fieldset className="chat-model-options" aria-label="Available chat models">
						<button
							type="button"
							aria-pressed={!selection}
							onClick={() => {
								onSelect(undefined);
								setOpen(false);
							}}
						>
							<div>
								<strong>Signet default</strong>
								<small>Use your backend inference assignment</small>
							</div>
							{!selection && <CheckIcon size={14} />}
						</button>
						{loading ? (
							<p role="status">Loading connected models…</p>
						) : error ? (
							<p role="alert">{error}</p>
						) : (
							<>
								{filtered.map((model) => {
									const selected = selection?.targetRef === model.targetRef && selection.model === model.model;
									return (
										<button
											key={`${model.targetRef}:${model.model}`}
											type="button"
											aria-pressed={selected}
											onClick={() => {
												onSelect(model);
												setOpen(false);
											}}
										>
											<div>
												<strong>{model.name}</strong>
												<small>
													{model.provider} · {model.account}
												</small>
											</div>
											{selected && <CheckIcon size={14} />}
										</button>
									);
								})}
								{!filtered.length && (
									<p>
										{models.length
											? "No matching models."
											: "Connect a provider in Settings → Inference to choose a model."}
									</p>
								)}
							</>
						)}
					</fieldset>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
