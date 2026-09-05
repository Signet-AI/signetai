import { Activity, useEffect, type ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Topbar } from "@/components/shell/topbar";
import { MemoryNav } from "@/components/shell/navigation";
import { useView } from "@/lib/view-context";
import { SettingsProvider } from "@/lib/settings-context";
import { SettingsModal, useSettingsHotkey } from "@/views/settings";
import { HomeView } from "@/views/home";
import { SkillsView } from "@/views/stubs";
import { DreamsView } from "@/views/dreaming";
import { GraphView } from "@/views/graph";

import { OnboardingModal } from "@/components/onboarding/modal";

export function App() {
	return (
		<SettingsProvider>
			<TooltipProvider delayDuration={200}>
				<Shell />
				<SettingsModal />
				<OnboardingModal />
				<Toaster />
			</TooltipProvider>
		</SettingsProvider>
	);
}

function Shell() {
	useSettingsHotkey();
	const { view } = useView();
	return (
		<div className="shell-stage flex h-full min-h-0 flex-col bg-background p-2.5 text-foreground">
			<main
				data-view={view}
				className="sig-app-frame flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-border/80 bg-background"
			>
				<Topbar />
				<div
					className={`sig-content flex min-h-0 flex-1 flex-col ${view === "home" ? "overflow-hidden" : "overflow-auto p-6"}`}
				>
					<Activity mode={view === "home" ? "visible" : "hidden"}>
						<HomeView />
					</Activity>
					{view !== "home" && <ViewSwitch />}
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

	if (view === "graph" || view === "dreaming") {
		return (
			<PageTransition view={view}>
				<div className="flex min-h-0 flex-1 flex-col gap-3">
					<MemoryNav />
					<div className="flex min-h-0 flex-1 flex-col">{view === "graph" ? <GraphView /> : <DreamsView />}</div>
				</div>
			</PageTransition>
		);
	}

	switch (view) {
		case "skills":
			return (
				<PageTransition view={view}>
					<SkillsView />
				</PageTransition>
			);
		default:
			return null;
	}
}

function PageTransition({ view, children }: { view: string; children: ReactNode }) {
	return (
		<div key={view} className="sig-page-transition flex min-h-0 flex-1 flex-col">
			{children}
		</div>
	);
}
