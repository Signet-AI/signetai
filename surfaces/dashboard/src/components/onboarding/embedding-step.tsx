import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AgentConfigStore } from "@/lib/agent-config";
import { readEmbeddingEndpoint } from "@/lib/embedding-config";

export interface EmbeddingDraft {
	provider: string;
	model: string;
	dimensions: number;
	endpoint: string;
	key: string;
}
const OPTIONS = [
	{
		value: "native",
		label: "Built-in · on this machine",
		model: "nomic-embed-text-v1.5",
		dimensions: 768,
		endpoint: "",
	},
	{
		value: "ollama",
		label: "Ollama · your local server",
		model: "nomic-embed-text",
		dimensions: 768,
		endpoint: "http://localhost:11434",
	},
	{
		value: "llama-cpp",
		label: "llama.cpp · your local server",
		model: "nomic-embed-text-v1.5",
		dimensions: 768,
		endpoint: "http://localhost:8080",
	},
	{
		value: "openai",
		label: "OpenAI · hosted",
		model: "text-embedding-3-small",
		dimensions: 1536,
		endpoint: "https://api.openai.com/v1",
	},
	{ value: "none", label: "Keyword search only", model: "", dimensions: 768, endpoint: "" },
];
export function embeddingDraft(store: AgentConfigStore): EmbeddingDraft {
	const provider = store.aStr(["embedding", "provider"], "native");
	const defaults = OPTIONS.find((item) => item.value === provider) ?? OPTIONS[0];
	const configured = store.agent.embedding as { dimensions?: number } | undefined;
	return {
		provider,
		model: store.aStr(["embedding", "model"], defaults.model),
		dimensions: configured?.dimensions ?? defaults.dimensions,
		endpoint: readEmbeddingEndpoint(store, ["embedding"]) || defaults.endpoint,
		key: "",
	};
}
export function EmbeddingStep({
	value,
	onChange,
	disabled,
	hasKey,
}: {
	value: EmbeddingDraft;
	onChange: (value: EmbeddingDraft) => void;
	disabled: boolean;
	hasKey: boolean;
}) {
	const local = value.provider === "native";
	const off = value.provider === "none";
	return (
		<div className="embedding-fields">
			<label htmlFor="embedding-provider">Where should search run?</label>
			<Select
				value={value.provider}
				disabled={disabled}
				onValueChange={(provider) => {
					const defaults = OPTIONS.find((item) => item.value === provider);
					if (!defaults) return;
					onChange({
						...value,
						provider,
						model: defaults.model,
						dimensions: defaults.dimensions,
						endpoint: defaults.endpoint,
						key: "",
					});
				}}
			>
				<SelectTrigger id="embedding-provider" aria-label="Embedding provider">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{OPTIONS.map((item) => (
						<SelectItem key={item.value} value={item.value}>
							{item.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<p className="embedding-explanation">
				{off
					? "You can still search by words and phrases. Enable search by meaning later in Settings → Inference."
					: local
						? "Recommended. Signet runs the embedding model on this machine; your text stays here. The first use may take longer while the model starts."
						: value.provider === "openai"
							? "Text sent for embedding is processed by OpenAI. This uses an API key and paid API usage, separate from your ChatGPT subscription."
							: "Use an embedding model already running on your server. Signet sends text to this endpoint to build the search index."}
			</p>
			{!off && !local && (
				<>
					<label htmlFor="embedding-model">Model</label>
					<input
						id="embedding-model"
						disabled={disabled}
						className="memory-input"
						value={value.model}
						onChange={(e) => onChange({ ...value, model: e.target.value })}
					/>
					<label htmlFor="embedding-endpoint">Server address</label>
					<input
						id="embedding-endpoint"
						disabled={disabled}
						className="memory-input"
						value={value.endpoint}
						onChange={(e) => onChange({ ...value, endpoint: e.target.value })}
					/>
					<label htmlFor="embedding-dimensions">
						Vector size <span className="optional">Use the size your model produces</span>
					</label>
					<input
						id="embedding-dimensions"
						disabled={disabled}
						className="memory-input"
						type="number"
						min={1}
						max={65536}
						value={value.dimensions}
						onChange={(e) => onChange({ ...value, dimensions: Number(e.target.value) })}
					/>
				</>
			)}
			{value.provider === "openai" && (
				<>
					<label htmlFor="embedding-key">
						API key{" "}
						<span className="optional">
							{hasKey ? "Leave blank to keep your existing key" : "Stored securely by Signet"}
						</span>
					</label>
					<input
						id="embedding-key"
						disabled={disabled}
						className="memory-input"
						type="password"
						autoComplete="off"
						value={value.key}
						onChange={(e) => onChange({ ...value, key: e.target.value })}
					/>
				</>
			)}
			<p className="fixture">
				Changing the embedding model rebuilds the search index from your memories. Your original memories stay intact.
			</p>
		</div>
	);
}
