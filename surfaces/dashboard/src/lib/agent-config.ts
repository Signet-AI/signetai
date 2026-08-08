/**
 * Agent config store — React equivalent of the old Svelte dashboard's
 * settings store (`st`). Loads agent.yaml via GET /api/config, exposes path
 * accessors used by the settings screens (inference accounts/targets, git
 * sync toggles), tracks dirtiness, and persists via POST /api/config.
 *
 * Writes are explicit: mutate with the aSet/aDel helpers, then save(). Callers that
 * change provider wiring must save BEFORE reloading catalogs, because the
 * daemon re-reads agent.yaml from disk (mirrors the Svelte save→invalidate
 * ordering).
 */
import { parse, stringify } from "yaml";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

type YamlObject = Record<string, unknown>;

function getPath(obj: YamlObject, path: readonly string[]): unknown {
	let cur: unknown = obj;
	for (const key of path) {
		if (cur == null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
		cur = (cur as YamlObject)[key];
	}
	return cur;
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

export function isDreamingEnabled(agent: Record<string, unknown>): boolean {
	const memory = agent.memory;
	if (memory === null || typeof memory !== "object" || Array.isArray(memory)) return false;
	const pipeline = (memory as Record<string, unknown>).pipelineV2;
	if (pipeline === null || typeof pipeline !== "object" || Array.isArray(pipeline)) return true;
	const gates = pipeline as Record<string, unknown>;
	return gates.paused !== true && gates.mutationsFrozen !== true;
}

export interface AgentConfigStore {
	ready: boolean;
	dirty: boolean;
	/** Raw parsed agent.yaml (read-only for views). */
	agent: YamlObject;
	aStr: (path: readonly string[]) => string;
	aBool: (path: readonly string[]) => boolean;
	aSetStr: (path: readonly string[], value: string) => void;
	aSetBool: (path: readonly string[], value: boolean) => void;
	aSetNum: (path: readonly string[], value: number) => void;
	/** Delete a key and prune now-empty parents (keeps YAML canonical). */
	aDel: (path: readonly string[]) => void;
	/** Apply one synchronous mutation to the current draft. */
	aUpdate: (fn: (draft: Record<string, unknown>) => void) => void;
	save: () => Promise<boolean>;
	reload: () => Promise<void>;
	saving: boolean;
}

const AGENT_FILE_NAMES = new Set(["agent.yaml", "AGENT.yaml"]);

export function useAgentConfig(): AgentConfigStore {
	const [agent, setAgent] = useState<YamlObject>({});
	const [fileName, setFileName] = useState<string | null>(null);
	const [ready, setReady] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	// Mutations accumulate in a ref between renders; state mirrors for repaint.
	const agentRef = useRef<YamlObject>({});
	agentRef.current = agent;

	const reload = useCallback(async () => {
		const files = await api.getConfigFiles();
		const file = files.find((f) => AGENT_FILE_NAMES.has(f.name));
		if (file) {
			const parsed = parse(file.content);
			const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as YamlObject) : {};
			setAgent(obj);
			setFileName(file.name);
		}
		setDirty(false);
		setReady(true);
	}, []);

	useEffect(() => {
		void reload();
	}, [reload]);

	const mutate = useCallback((fn: (draft: YamlObject) => void) => {
		const draft: YamlObject = structuredClone(agentRef.current);
		fn(draft);
		// Write through to the ref synchronously: save() serializes
		// agentRef.current, and React state (agentRef.current = agent on
		// render) does not commit before the next paint. Without this, a
		// mutation followed by an immediate save in the same tick (disconnect,
		// target rewire) serializes the pre-mutation config and the change is
		// silently lost on disk — the provider stays connected forever.
		agentRef.current = draft;
		setAgent(draft);
		setDirty(true);
	}, []);

	const aStr = useCallback(
		(path: readonly string[]) => {
			const v = getPath(agent, path);
			return v == null ? "" : String(v);
		},
		[agent],
	);

	const aBool = useCallback(
		(path: readonly string[]) => {
			const v = getPath(agent, path);
			if (typeof v === "boolean") return v;
			if (typeof v === "string") {
				const s = v.trim().toLocaleLowerCase();
				if (s === "true") return true;
			}
			return false;
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

	const save = useCallback(async () => {
		if (!fileName) return false;
		setSaving(true);
		const result = await api.saveConfigFile(fileName, stringify(agentRef.current));
		setSaving(false);
		if (result.ok) setDirty(false);
		return result.ok;
	}, [fileName]);

	return { ready, dirty, agent, aStr, aBool, aSetStr, aSetBool, aSetNum, aDel, aUpdate, save, reload, saving };
}
