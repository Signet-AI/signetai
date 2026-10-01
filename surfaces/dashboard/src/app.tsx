import { Activity, useEffect, useRef } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarNav } from "@/components/shell/navigation";
import { Topbar } from "@/components/shell/topbar";
import { type ViewId, useView } from "@/lib/view-context";
import { SettingsView, useSettingsHotkey } from "@/views/settings";
import { HomeView } from "@/views/home";
import { SkillsView } from "@/views/stubs";
import { DreamsView } from "@/views/dreaming";
import { GraphView } from "@/views/graph";

import { OnboardingModal } from "@/components/onboarding/modal";

export function App() {
	return (
		<TooltipProvider delayDuration={200}>
			<Shell />
			<OnboardingModal />
			<Toaster />
		</TooltipProvider>
	);
}

function Shell() {
	useSettingsHotkey();
	const { view } = useView();
	const contentRef = useRef<HTMLDivElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Reset this owned scroll container when the route changes.
	useEffect(() => {
		contentRef.current?.scrollTo({ top: 0 });
	}, [view]);
	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			<main
				data-view={view}
				className="sig-app-frame flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
			>
				<Topbar />
				<div className="sig-work-area flex min-h-0 min-w-0 flex-1">
					<SidebarNav />
					<div
						ref={contentRef}
						className={`sig-content flex min-h-0 min-w-0 flex-1 flex-col ${view === "home" || view === "dreaming" || view === "settings" ? "overflow-hidden" : "overflow-auto p-6"}`}
					>
						<Activity mode={view === "home" ? "visible" : "hidden"}>
							<HomeView />
						</Activity>
						{view !== "home" && <ViewSwitch view={view} />}
					</div>
				</div>
			</main>
		</div>
	);
}

function ViewSwitch({ view }: { view: ViewId }) {
	const page =
		view === "graph" ? (
			<GraphView />
		) : view === "dreaming" ? (
			<DreamsView />
		) : view === "skills" ? (
			<SkillsView />
		) : view === "settings" ? (
			<SettingsView />
		) : null;
	return (
		page && (
			<div key={view} className="sig-page-transition flex min-h-0 min-w-0 flex-1 flex-col">
				{page}
			</div>
		)
	);
}
