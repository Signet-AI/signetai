import { useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { WindowChrome } from "@/components/shell/window-chrome";
import { useView } from "@/lib/view-context";
import { SettingsProvider } from "@/lib/settings-context";
import { SettingsModal, useSettingsHotkey } from "@/views/settings";
import { HomeView } from "@/views/home";
import { MemoryView } from "@/views/memory";
import { SourcesView } from "@/views/sources";
import { SecretsView } from "@/views/secrets";
import { SkillsView, AgentsView } from "@/views/stubs";
import { DreamsView } from "@/views/dreaming";
import { GraphView } from "@/views/graph";
import { useMobileShell } from "@/lib/mobile-shell";
import { cn } from "@/lib/utils";

export function App() {
	return (
		<SettingsProvider>
			<TooltipProvider delayDuration={200}>
				<Shell />
				<SettingsModal />
				<Toaster />
			</TooltipProvider>
		</SettingsProvider>
	);
}

function Shell() {
	useSettingsHotkey();
	const [navOpen, setNavOpen] = useState(false);
	const mobileShell = useMobileShell();
	return (
		<div
			className={cn(
				"shell-stage grid h-full bg-background text-foreground",
				mobileShell ? "grid-cols-1" : "grid-cols-[248px_1fr]",
			)}
		>
			{/* Sidebar — desktop rail; opaque top-down navigation panel on true mobile. */}
			<div
				id="dashboard-navigation"
				className={cn(
					"flex flex-col",
					mobileShell && "fixed inset-x-0 top-[52px] z-50 max-h-[calc(100dvh-52px)]",
					mobileShell &&
						"overflow-x-hidden overflow-y-auto border-b border-sidebar-border bg-sidebar shadow-2xl transition-transform duration-200 ease-out",
					mobileShell &&
						(navOpen
							? "visible translate-y-0"
							: "pointer-events-none -translate-y-full invisible"),
				)}
			>
				{!mobileShell && <WindowChrome />}
				<Sidebar onNavigate={() => setNavOpen(false)} />
			</div>
			{mobileShell && navOpen && (
				<button
					type="button"
					aria-label="Close navigation"
					onClick={() => setNavOpen(false)}
					className="fixed inset-0 z-40 bg-black/50"
				/>
			)}

			<main className="flex min-h-0 min-w-0 flex-col">
				<Topbar mobileShell={mobileShell} menuOpen={navOpen} onMenuClick={() => setNavOpen((open) => !open)} />
				<div
					className={cn(
						"sig-content relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden rounded-[12px] border border-[oklch(1_0_0/0.05)] bg-sidebar px-5.5 pb-4 pt-4.5 shadow-[0_1px_0_0_oklch(0_0_0/0.25),inset_0_1px_0_oklch(1_0_0/0.04)] [html:not(.dark)_&]:border-[oklch(0_0_0/0.06)] [html:not(.dark)_&]:shadow-[0_1px_2px_oklch(0_0_0/0.05),inset_0_1px_0_oklch(1_0_0/0.8)]",
						mobileShell ? "m-0 mb-3.5" : "m-3.5 mt-0",
					)}
				>
					<ViewSwitch />
				</div>
			</main>
		</div>
	);
}

function ViewSwitch() {
	const { view } = useView();
	useEffect(() => {
		// scroll content to top on view change
		const el = document.querySelector(".sig-content");
		if (el) el.scrollTo({ top: 0 });
	}, [view]);

	switch (view) {
		case "home":
			return <HomeView />;
		case "memory":
			return <MemoryView />;
		case "sources":
			return <SourcesView />;
		case "secrets":
			return <SecretsView />;
		case "graph":
			return <GraphView />;
		case "skills":
			return <SkillsView />;
		case "dreaming":
			return <DreamsView />;
		case "agents":
			return <AgentsView />;
		default:
			return <HomeView />;
	}
}
