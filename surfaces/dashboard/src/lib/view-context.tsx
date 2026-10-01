import { SETTINGS_SECTIONS, type SettingsSection } from "./settings-sections";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from "react";

export type ViewId = "home" | "memory" | "graph" | "dreaming" | "skills" | "settings";

const VIEW_LABELS: Record<ViewId, string> = {
	home: "Home",
	memory: "Memory",
	graph: "Memory",
	dreaming: "Dreams",
	skills: "Skills",
	settings: "Settings",
};
function routeFromHash(): { view: ViewId; settingsSection?: SettingsSection } | null {
	if (typeof window === "undefined") return null;
	const raw = window.location.hash.replace(/^#\/?/, "").trim();
	if (raw === "memory") return { view: "graph" };
	if (raw === "settings" || raw.startsWith("settings/")) {
		const section = raw.split("/")[1];
		return { view: "settings", settingsSection: SETTINGS_SECTIONS.find((item) => item === section) ?? "network" };
	}
	return raw in VIEW_LABELS ? { view: raw as ViewId } : null;
}

interface ViewCtx {
	view: ViewId;
	setView: (v: ViewId) => void;
	label: (v: ViewId) => string;
	settingsSection: SettingsSection;
	openSettings: (section?: SettingsSection) => void;
	connectSourceRequested: boolean;
	requestConnectSource: () => void;
	clearConnectSource: () => void;
}

const Ctx = createContext<ViewCtx | null>(null);

export function ViewProvider({ children }: { children: ReactNode }) {
	const [route, setRoute] = useState(() => routeFromHash() ?? { view: "home" as ViewId });
	const view = route.view;
	const settingsSection = route.settingsSection ?? "network";
	const [connectSourceRequested, setConnectSourceRequested] = useState(false);
	const navigate = useCallback((next: ViewId, section?: SettingsSection) => {
		const canonical = next === "memory" ? "graph" : next;
		setRoute({ view: canonical, settingsSection: section });
		const hash = canonical === "settings" ? `#settings/${section ?? "network"}` : `#${canonical}`;
		if (typeof window !== "undefined" && window.location.hash !== hash) history.replaceState(null, "", hash);
	}, []);
	const setView = useCallback((next: ViewId) => navigate(next, settingsSection), [navigate, settingsSection]);
	const openSettings = useCallback(
		(section?: SettingsSection) => navigate("settings", section ?? settingsSection),
		[navigate, settingsSection],
	);

	useEffect(() => {
		const onHashChange = () => {
			const next = routeFromHash();
			if (next) setRoute(next);
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
				settingsSection,
				openSettings,
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
