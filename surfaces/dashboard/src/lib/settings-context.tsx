import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/** Settings modal open/close + active section, driven from the account row. */
type SettingsSection = "network" | "inference" | "logs" | "advanced";
export type { SettingsSection };

interface SettingsCtx {
	open: boolean;
	section: SettingsSection;
	setOpen: (o: boolean) => void;
	setSection: (s: SettingsSection) => void;
	toggle: () => void;
}

const Ctx = createContext<SettingsCtx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const [section, setSection] = useState<SettingsSection>("network");
	const toggle = useCallback(() => setOpen((o) => !o), []);
	// Drive the body class that powers the settings "stage-drop" shell scale.
	useEffect(() => {
		document.body.classList.toggle("settings-open", open);
		return () => document.body.classList.remove("settings-open");
	}, [open]);
	return (
		<Ctx.Provider value={{ open, section, setOpen, setSection, toggle }}>{children}</Ctx.Provider>
	);
}

export function useSettings(): SettingsCtx {
	const ctx = useContext(Ctx);
	if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
	return ctx;
}
