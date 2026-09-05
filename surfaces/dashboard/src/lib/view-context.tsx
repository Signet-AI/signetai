import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from "react";

export type ViewId = "home" | "memory" | "graph" | "dreaming" | "skills";

const VIEW_LABELS: Record<ViewId, string> = {
	home: "Home",
	memory: "Memory",
	graph: "Graph",
	dreaming: "Dreams",
	skills: "Skills",
};

/** Parse a deep link into a view id; `#memory` remains a legacy alias for Graph. */
function viewFromHash(): ViewId | null {
	if (typeof window === "undefined") return null;
	const raw = window.location.hash.replace(/^#\/?/, "").trim();
	if (raw === "memory") return "graph";
	return (raw in VIEW_LABELS ? raw : null) as ViewId | null;
}

interface ViewCtx {
	view: ViewId;
	setView: (v: ViewId) => void;
	label: (v: ViewId) => string;
	/** Cross-view handoff: return home and land in the connect flow. */
	connectSourceRequested: boolean;
	requestConnectSource: () => void;
	clearConnectSource: () => void;
}

const Ctx = createContext<ViewCtx | null>(null);

export function ViewProvider({ children }: { children: ReactNode }) {
	const [view, setViewState] = useState<ViewId>(() => viewFromHash() ?? "home");
	const [connectSourceRequested, setConnectSourceRequested] = useState(false);

	// Views are deep-linkable via location.hash (the marketing-site demo iframe
	// drives the embedded dashboard by setting its hash). Keep the hash in sync
	// on every navigation so the URL always reflects the visible view.
	const setView = useCallback((next: ViewId) => {
		const canonical = next === "memory" ? "graph" : next;
		setViewState(canonical);
		if (typeof window !== "undefined" && window.location.hash !== `#${canonical}`) {
			history.replaceState(null, "", `#${canonical}`);
		}
	}, []);

	useEffect(() => {
		const onHashChange = () => {
			const next = viewFromHash();
			if (next) setViewState(next);
			if (window.location.hash === "#memory") history.replaceState(null, "", "#graph");
		};
		if (window.location.hash === "#memory") history.replaceState(null, "", "#graph");
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	return (
		<Ctx.Provider
			value={{
				view,
				setView,
				label: (v) => VIEW_LABELS[v],
				connectSourceRequested,
				requestConnectSource: () => {
					setConnectSourceRequested(true);
					setView("home");
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
