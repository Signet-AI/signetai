import { parse, stringify } from "yaml";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiReadResult, api, getJSONResult } from "@/lib/api";

type YamlObject = Record<string, unknown>;

function getPath(obj: YamlObject, path: readonly string[]): unknown {
	let cur: unknown = obj;
	for (const key of path) {
		if (cur == null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
		cur = (cur as YamlObject)[key];
	}
	return cur;
}

export function pv2MaintenanceMode(agent: Record<string, unknown>): string | undefined {
	const value = getPath(agent, ["memory", "pipelineV2", "autonomous", "maintenanceMode"]);
	return typeof value === "string" ? value : undefined;
}

export function pv2ToggleValue(
	agent: Record<string, unknown>,
	nested: readonly string[],
	flat: readonly string[],
	fallback: boolean,
): boolean {
	const nestedValue = getPath(agent, nested);
	if (typeof nestedValue === "boolean") return nestedValue;
	const flatValue = getPath(agent, flat);
	if (typeof flatValue === "boolean") return flatValue;
	return fallback;
}
export function pv2ToggleWriteForm(
	agent: Record<string, unknown>,
	nested: readonly string[],
	flat: readonly string[],
): "nested" | "flat" {
	if (typeof getPath(agent, nested) === "boolean") return "nested";
	if (typeof getPath(agent, flat) === "boolean") return "flat";
	return "nested";
}

function setPath(obj: YamlObject, path: readonly string[], value: unknown): void {
	let cur = obj;
	for (let i = 0; i < path.length - 1; i++) {
		const key = path[i];
		const next = cur[key];
		if (next == null || typeof next !== "object" || Array.isArray(next)) {
			cur[key] = {};
		}
		cur = cur[key] as YamlObject;
	}
	cur[path[path.length - 1]] = value;
}

function delPath(obj: YamlObject, path: readonly string[]): void {
	const del = (node: YamlObject, idx: number): void => {
		if (idx === path.length - 1) {
			delete node[path[idx]];
			return;
		}
		const next = node[path[idx]];
		if (next == null || typeof next !== "object" || Array.isArray(next)) return;
		del(next as YamlObject, idx + 1);
		if (Object.keys(next as YamlObject).length === 0) delete node[path[idx]];
	};
	if (path.length > 0) del(obj, 0);
}

export function dreamingBlockedBy(agent: Record<string, unknown>): "paused" | "frozen" | null {
	if (getPath(agent, ["memory", "pipelineV2", "paused"]) === true) return "paused";
	if (getPath(agent, ["memory", "pipelineV2", "mutationsFrozen"]) === true) return "frozen";
	return null;
}

export interface PipelinePauseResult {
	readonly success: boolean;
	readonly paused: boolean;
	readonly mode: string;
}

export async function setPipelinePaused(
	store: Pick<AgentConfigStore, "aSetBool">,
	paused: boolean,
	signal?: AbortSignal,
): Promise<ApiReadResult<PipelinePauseResult>> {
	const result = await getJSONResult<PipelinePauseResult>(`/api/pipeline/${paused ? "pause" : "resume"}`, {
		method: "POST",
		signal,
	});
	if (result.data?.success) store.aSetBool(["memory", "pipelineV2", "paused"], result.data.paused);
	return result;
}

export interface AgentConfigStore {
	ready: boolean;
	dirty: boolean;
	agent: YamlObject;
	aStr: (path: readonly string[], fallback?: string) => string;
	aBool: (path: readonly string[], fallback?: boolean) => boolean;
	aSetStr: (path: readonly string[], value: string) => void;
	aSetBool: (path: readonly string[], value: boolean) => void;
	aSetNum: (path: readonly string[], value: number) => void;
	aDel: (path: readonly string[]) => void;
	aUpdate: (fn: (draft: Record<string, unknown>) => void) => void;
	save: () => Promise<boolean>;
	reload: () => Promise<void>;
	saving: boolean;
	error: string | null;
}

const AGENT_FILE_NAMES = new Set(["agent.yaml", "AGENT.yaml"]);

export function useAgentConfig(): AgentConfigStore {
	const [agent, setAgent] = useState<YamlObject>({});
	const [fileName, setFileName] = useState<string | null>(null);
	const [ready, setReady] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const saveRef = useRef<Promise<boolean> | null>(null);
	const revision = useRef(0);
	const agentRef = useRef<YamlObject>({});
	agentRef.current = agent;

	const reload = useCallback(async () => {
		setError(null);
		try {
			const files = await api.getConfigFiles();
			const file = files.find((f) => AGENT_FILE_NAMES.has(f.name));
			if (!file) throw new Error("Could not load agent.yaml. Check the daemon connection and retry.");
			const parsed: unknown = parse(file.content);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				throw new Error("agent.yaml must contain a configuration object.");
			const obj = Object.fromEntries(Object.entries(parsed));
			agentRef.current = obj;
			setAgent(obj);
			setFileName(file.name);
			setDirty(false);
			setReady(true);
		} catch (error) {
			setError(error instanceof Error ? error.message : "Could not load settings.");
			setReady(false);
		}
	}, []);

	useEffect(() => {
		void reload();
	}, [reload]);

	const mutate = useCallback((fn: (draft: YamlObject) => void) => {
		const draft: YamlObject = structuredClone(agentRef.current);
		fn(draft);
		revision.current++;
		agentRef.current = draft;
		setAgent(draft);
		setDirty(true);
	}, []);

	const aStr = useCallback(
		(path: readonly string[], fallback = "") => {
			const v = getPath(agent, path);
			return v == null ? fallback : String(v);
		},
		[agent],
	);

	const aBool = useCallback(
		(path: readonly string[], fallback = false) => {
			const v = getPath(agent, path);
			if (typeof v === "boolean") return v;
			if (typeof v === "string") {
				const s = v.trim().toLocaleLowerCase();
				if (s === "true") return true;
				if (s === "false") return false;
			}
			return fallback;
		},
		[agent],
	);

	const aSetStr = useCallback(
		(path: readonly string[], value: string) => mutate((draft) => setPath(draft, path, value)),
		[mutate],
	);
	const aSetBool = useCallback(
		(path: readonly string[], value: boolean) => mutate((draft) => setPath(draft, path, value)),
		[mutate],
	);
	const aSetNum = useCallback(
		(path: readonly string[], value: number) =>
			mutate((draft) => {
				if (Number.isFinite(value)) setPath(draft, path, value);
				else delPath(draft, path);
			}),
		[mutate],
	);
	const aDel = useCallback((path: readonly string[]) => mutate((draft) => delPath(draft, path)), [mutate]);
	const aUpdate = useCallback((fn: (draft: YamlObject) => void) => mutate(fn), [mutate]);

	const save = useCallback((): Promise<boolean> => {
		if (saveRef.current) return saveRef.current;
		if (!fileName) return Promise.resolve(false);
		setSaving(true);
		saveRef.current = (async () => {
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				const savedRevision = revision.current;
				const result = await api.saveConfigFile(fileName, stringify(agentRef.current));
				if (!result.ok) {
					setError(result.error ?? "Could not save settings.");
					return false;
				}
				if (savedRevision === revision.current) {
					setDirty(false);
					setError(null);
					return true;
				}
			}
			setError("Settings are still changing. Finish editing and retry saving.");
			return false;
		})().finally(() => {
			saveRef.current = null;
			setSaving(false);
		});
		return saveRef.current;
	}, [fileName]);

	return { ready, dirty, agent, aStr, aBool, aSetStr, aSetBool, aSetNum, aDel, aUpdate, save, reload, saving, error };
}
