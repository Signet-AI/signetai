import { createContext, useContext, useState, type ReactNode } from "react";

export type ViewId =
	| "home"
	| "agents"
	| "memory"
	| "sources"
	| "graph"
	| "dreaming"
	| "skills"
	| "secrets";

const VIEW_LABELS: Record<ViewId, string> = {
	home: "Home",
	agents: "Agents",
	memory: "Memory",
	sources: "Sources",
	graph: "Graph",
	dreaming: "Dreams",
	skills: "Skills",
	secrets: "Secrets",
};

interface ViewCtx {
	view: ViewId;
	setView: (v: ViewId) => void;
	label: (v: ViewId) => string;
	/** Cross-view handoff: navigate to sources and land in the connect flow. */
	connectSourceRequested: boolean;
	requestConnectSource: () => void;
	clearConnectSource: () => void;
}

const Ctx = createContext<ViewCtx | null>(null);

export function ViewProvider({ children }: { children: ReactNode }) {
	const [view, setView] = useState<ViewId>("home");
	const [connectSourceRequested, setConnectSourceRequested] = useState(false);
	return (
		<Ctx.Provider
			value={{
				view,
				setView,
				label: (v) => VIEW_LABELS[v],
				connectSourceRequested,
				requestConnectSource: () => {
					setConnectSourceRequested(true);
					setView("sources");
				},
				clearConnectSource: () => setConnectSourceRequested(false),
			}}
		>
			{children}
		</Ctx.Provider>
	);
}

export function useView(): ViewCtx {
	const ctx = useContext(Ctx);
	if (!ctx) throw new Error("useView must be used within ViewProvider");
	return ctx;
}
