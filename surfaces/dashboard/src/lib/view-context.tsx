import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { Button } from "@/components/ui/button";
import { SETTINGS_SECTIONS, type SettingsSection } from "./settings-sections";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export type ViewId = "home" | "memory" | "graph" | "dreaming" | "skills" | "settings" | "setup";

const VIEW_LABELS: Record<ViewId, string> = {
	home: "Home",
	memory: "Memory",
	graph: "Memory",
	dreaming: "Dreams",
	skills: "Skills",
	settings: "Settings",
	setup: "Setup",
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
	setSetupComplete: (complete: boolean) => void;
	label: (v: ViewId) => string;
	settingsSection: SettingsSection;
	openSettings: (section?: SettingsSection) => void;
	connectSourceRequested: boolean;
	requestConnectSource: () => void;
	clearConnectSource: () => void;
	chatOpen: boolean;
	setChatOpen: (open: boolean) => void;
}

const Ctx = createContext<ViewCtx | null>(null);

export function ViewProvider({ children }: { children: ReactNode }) {
	const [route, setRoute] = useState(() => routeFromHash() ?? { view: "home" as ViewId });
	const view = route.view;
	const settingsSection = route.settingsSection ?? "network";
	const [connectSourceRequested, setConnectSourceRequested] = useState(false);
	const [chatOpen, setChatOpen] = useState(false);
	const setupComplete = useRef(false);
	const [pendingRoute, setPendingRoute] = useState<{ view: ViewId; settingsSection?: SettingsSection } | null>(null);
	const commitRoute = useCallback((next: ViewId, section?: SettingsSection) => {
		const canonical = next === "memory" ? "graph" : next;
		setRoute({ view: canonical, settingsSection: section });
		const hash = canonical === "settings" ? `#settings/${section ?? "network"}` : `#${canonical}`;
		if (typeof window !== "undefined" && window.location.hash !== hash) history.replaceState(null, "", hash);
	}, []);
	const navigate = useCallback(
		(next: ViewId, section?: SettingsSection) => {
			if (view === "setup" && next !== "setup" && !setupComplete.current) {
				setPendingRoute({ view: next, settingsSection: section });
				return;
			}
			if (next === "setup" && view !== "setup") setupComplete.current = false;
			commitRoute(next, section);
		},
		[view, commitRoute],
	);
	const setView = useCallback((next: ViewId) => navigate(next, settingsSection), [navigate, settingsSection]);
	const openSettings = useCallback(
		(section?: SettingsSection) => navigate("settings", section ?? settingsSection),
		[navigate, settingsSection],
	);

	useEffect(() => {
		const onHashChange = () => {
			const next = routeFromHash() ?? (window.location.hash === "" ? { view: "home" as ViewId } : null);
			if (next) {
				if (view === "setup" && next.view !== "setup" && !setupComplete.current) {
					history.replaceState(null, "", "#setup");
					setPendingRoute(next);
				} else navigate(next.view, next.settingsSection);
			}
			if (window.location.hash === "#memory") history.replaceState(null, "", "#graph");
		};
		if (window.location.hash === "#memory") history.replaceState(null, "", "#graph");
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, [view, navigate]);

	const setSetupComplete = useCallback((complete: boolean) => {
		setupComplete.current = complete;
	}, []);
	return (
		<Ctx.Provider
			value={{
				view,
				setView,
				setSetupComplete,
				label: (v) => VIEW_LABELS[v],
				settingsSection,
				openSettings,
				connectSourceRequested,
				requestConnectSource: () => {
					setConnectSourceRequested(true);
					setView("home");
				},
				clearConnectSource: () => setConnectSourceRequested(false),
				chatOpen,
				setChatOpen,
			}}
		>
			{children}
			<ConfirmationDialog
				open={pendingRoute !== null}
				onOpenChange={(open) => {
					if (!open) setPendingRoute(null);
				}}
				contentProps={{ showCloseButton: false }}
				title="Leave setup?"
				description="You haven’t finished setting up Signet. Are you sure you want to leave? Settings you’ve already saved will be kept."
				actions={
					<>
						<Button variant="outline" onClick={() => setPendingRoute(null)}>
							Continue setup
						</Button>
						<Button
							onClick={() => {
								if (pendingRoute) commitRoute(pendingRoute.view, pendingRoute.settingsSection);
								setPendingRoute(null);
							}}
						>
							Leave setup
						</Button>
					</>
				}
			/>
		</Ctx.Provider>
	);
}

export function useView(): ViewCtx {
	const ctx = useContext(Ctx);
	if (!ctx) throw new Error("useView must be used within ViewProvider");
	return ctx;
}
