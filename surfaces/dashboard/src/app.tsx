import { Activity, useEffect, useRef } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarNav, useSidebarOpen } from "@/components/shell/navigation";
import { SessionExpiryToast, SignInDialog, SignInScreen } from "@/components/shell/sign-in";
import { AccountView } from "@/views/account";
import { ClaimPage, InvitationPage, DeviceApprovalPage, authEntryKind } from "@/components/shell/auth-entry";
import { useAgentContext } from "@/lib/agent-context";
import { Topbar } from "@/components/shell/topbar";
import { useSession, useWhoami } from "@/lib/session";
import { type ViewId, useView } from "@/lib/view-context";
import { SettingsView, useSettingsHotkey } from "@/views/settings";
import { HomeView } from "@/views/home";
import { SkillsView } from "@/views/skills";
import { DreamsView } from "@/views/dreaming";
import { BoardView } from "@/views/board";
import { GraphView } from "@/views/graph";

import { TelemetryConsentDialog } from "@/components/telemetry-consent";
import { OnboardingPage } from "@/components/onboarding/page";
import { OnboardingEntry } from "@/components/onboarding/entry";
import { MemberSetup, OrganizationOnboardingGate } from "@/components/onboarding/member";

export function App() {
	const session = useSession();
	const whoami = useWhoami();
	const entry = authEntryKind(location.pathname, "mode" in session ? session.mode : whoami ? "team" : "");
	return (
		<TooltipProvider delayDuration={200}>
			{session.kind === "checking" ? null : entry === "claim" ? (
				<ClaimPage />
			) : entry === "invite" ? (
				<InvitationPage />
			) : session.kind === "signed-out" && !session.expired ? (
				<SignInScreen session={session} />
			) : (
				<>
					{entry === "device" ? (
						<DeviceApprovalPage />
					) : (
						<OrganizationOnboardingGate whoami={whoami}>
							<Shell key={whoami?.user.id} />
						</OrganizationOnboardingGate>
					)}
					{session.kind === "signed-out" && <SignInDialog session={session} />}
					<SessionExpiryToast session={session} />
				</>
			)}
			<Toaster />
		</TooltipProvider>
	);
}

function Shell() {
	const whoami = useWhoami();
	useSettingsHotkey();
	useAgentContext();
	const { view, setView, setSetupComplete } = useView();
	const contentRef = useRef<HTMLDivElement>(null);
	const [sidebarOpen, toggleSidebar] = useSidebarOpen();
	useEffect(() => {
		contentRef.current?.scrollTo({ top: 0 });
	}, [view]);
	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			<main
				data-view={view}
				data-sidebar={sidebarOpen ? "open" : "closed"}
				className="sig-app-frame flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
			>
				<Topbar sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
				<div className="sig-work-area flex min-h-0 min-w-0 flex-1">
					<SidebarNav open={sidebarOpen} />
					<div
						ref={contentRef}
						className={`sig-content flex min-h-0 min-w-0 flex-1 flex-col ${view === "home" || view === "dreaming" || view === "board" || view === "settings" || view === "account" || view === "setup" ? "overflow-hidden" : "overflow-auto p-6"}`}
					>
						{view === "setup" ? (
							whoami ? (
								<MemberSetup
									whoami={whoami}
									onComplete={() => {
										setSetupComplete(true);
										setView("home");
									}}
								/>
							) : (
								<OnboardingEntry
									personal={<OnboardingPage onClose={() => setView("home")} onCompleteChange={setSetupComplete} />}
								/>
							)
						) : (
							<>
								<Activity mode={view === "home" ? "visible" : "hidden"}>
									<HomeView />
								</Activity>
								{view !== "home" && <ViewSwitch view={view} />}
							</>
						)}
					</div>
				</div>
			</main>
			{view !== "setup" && <TelemetryConsentDialog />}
		</div>
	);
}

function ViewSwitch({ view }: { view: ViewId }) {
	const page =
		view === "account" ? (
			<AccountView />
		) : view === "graph" ? (
			<GraphView />
		) : view === "dreaming" ? (
			<DreamsView />
		) : view === "skills" ? (
			<SkillsView />
		) : view === "board" ? (
			<BoardView />
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
