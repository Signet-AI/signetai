import { useEffect, useRef, useState } from "react";
import {
	TELEMETRY_CONSENT_BODY,
	TELEMETRY_CONSENT_PATH,
	TELEMETRY_CONSENT_TITLE,
	readTelemetryConsent,
} from "@signet/core/telemetry-consent";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { useAgentConfig } from "@/lib/agent-config";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { ONBOARDING_STEPS, restoreOnboardingStep } from "./onboarding/progress";

export function renderTelemetryParagraph(text: string) {
	return text
		.split(/(`[^`]+`)/)
		.map((part) => (part.startsWith("`") ? <code key={part}>{part.slice(1, -1)}</code> : part));
}

export function TelemetryConsentDialog() {
	const store = useAgentConfig();
	const status = useAsync(() => api.getStatus(), { key: "status" });
	const [open, setOpen] = useState(false);
	const dialog = useRef<HTMLDivElement>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (
			!store.ready ||
			!status.data ||
			status.data.telemetryDisabledByEnv ||
			readTelemetryConsent(store.agent) !== undefined
		)
			return;
		const key = `signet:onboarding:${status.data.agentsDir}:${status.data.agentId}`;
		try {
			const saved = JSON.parse(localStorage.getItem(key) ?? "null");
			const restored = restoreOnboardingStep(saved?.step);
			if (restored >= 0 && restored < ONBOARDING_STEPS.length - 1) return;
		} catch {}
		setOpen(true);
	}, [store.ready, store.agent, status.data]);
	const choose = async (enabled: boolean) => {
		setBusy(true);
		setError(null);
		store.aSetBool(TELEMETRY_CONSENT_PATH, enabled);
		if (await store.save()) setOpen(false);
		else setError("Could not save your choice. Retry.");
		setBusy(false);
	};
	return (
		<ConfirmationDialog
			open={open && store.ready && Boolean(status.data) && !status.data?.telemetryDisabledByEnv}
			contentProps={{
				ref: dialog,
				showCloseButton: false,
				onOpenAutoFocus: (event) => {
					event.preventDefault();
					dialog.current?.focus();
				},
				onEscapeKeyDown: (event) => event.preventDefault(),
				onInteractOutside: (event) => event.preventDefault(),
				className: "max-h-[calc(100dvh-32px)] overflow-y-auto",
			}}
			title={TELEMETRY_CONSENT_TITLE}
			description={
				<span className="flex flex-col gap-3 text-left">
					{TELEMETRY_CONSENT_BODY.map((paragraph) => (
						<span key={paragraph}>{renderTelemetryParagraph(paragraph)}</span>
					))}
				</span>
			}
			actions={
				<>
					<Button variant="outline" className="flex-1" disabled={busy} onClick={() => void choose(true)}>
						Share usage data
					</Button>
					<Button variant="outline" className="flex-1" disabled={busy} onClick={() => void choose(false)}>
						Don't share
					</Button>
				</>
			}
		>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
		</ConfirmationDialog>
	);
}
