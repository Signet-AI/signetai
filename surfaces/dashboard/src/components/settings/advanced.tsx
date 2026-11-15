import { TELEMETRY_CONSENT_PATH, readTelemetryConsent } from "@signet/core/telemetry-consent";
import { Button } from "@/components/ui/button";
import { type DreamPassType, type DreamPolicies, api } from "@/lib/api";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { Switch } from "@/components/ui/switch";
import {
	type AgentConfigStore,
	dreamingBlockedBy,
	getPath,
	pv2MaintenanceMode,
	pv2ToggleValue,
	pv2ToggleWriteForm,
	setPipelinePaused,
	useAgentConfig,
} from "@/lib/agent-config";
import { useCallback, useEffect, useState } from "react";

import { ConfigFields } from "./config-fields";
import { SettingRow, SettingSelect, SettingsGroup } from "./controls";
function PipelinePauseToggle({ store }: { store: AgentConfigStore }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	return (
		<SettingRow
			title="Paused"
			desc={error ?? "Stops Dreaming and the rest of the memory pipeline until resumed. Applies immediately."}
		>
			<Switch
				checked={dreamingBlockedBy(store.agent) === "paused"}
				disabled={!store.ready || busy}
				onCheckedChange={async (paused: boolean) => {
					setBusy(true);
					setError(null);
					const result = await setPipelinePaused(store, paused);
					if (!result.data?.success) setError(result.error ?? "Could not change the pipeline state. Retry.");
					setBusy(false);
				}}
				aria-label="Pause memory pipeline"
			/>
		</SettingRow>
	);
}

function DreamingToggle({ store }: { store: AgentConfigStore }) {
	const path = ["memory", "dreaming", "enabled"] as const;
	const blockedBy = dreamingBlockedBy(store.agent);
	const desc =
		blockedBy === "disabled"
			? "The memory pipeline is turned off. Turn on Pipeline enabled to run Dreaming."
			: blockedBy === "paused"
				? "The memory pipeline is paused. Turn off Paused under Pipeline to run Dreaming."
				: blockedBy === "frozen"
					? "Mutations are frozen. Turn off Freeze mutations under Pipeline to run Dreaming."
					: "Runs dreaming passes automatically as transcripts build up.";

	return (
		<SettingRow title="Dreaming" desc={desc}>
			<Switch
				checked={blockedBy === null && store.aBool(path, false)}
				disabled={!store.ready || blockedBy !== null}
				onCheckedChange={(value: boolean) => {
					store.aSetBool(path, value);
					void store.save();
				}}
				aria-label="Dreaming"
			/>
		</SettingRow>
	);
}

function TelemetrySettings({ store }: { store: AgentConfigStore }) {
	const [confirmOptOut, setConfirmOptOut] = useState(false);
	const path = TELEMETRY_CONSENT_PATH;
	const consent = readTelemetryConsent(store.agent);
	const enabled = consent === true;

	return (
		<>
			<SettingRow
				title="Anonymous telemetry"
				desc={`${consent === undefined ? "Not yet answered. Usage data is off." : enabled ? "Usage data is on." : "Usage data is off."} Share anonymous usage and performance data to help improve Signet. No memory content or personal identity is sent. Changes apply immediately.`}
			>
				<Switch
					checked={enabled}
					disabled={!store.ready || store.saving}
					onCheckedChange={(next: boolean) => {
						if (!next) {
							setConfirmOptOut(true);
							return;
						}
						store.aSetBool(path, true);
						void store.save();
					}}
					aria-label="Anonymous telemetry"
				/>
			</SettingRow>
			<ConfirmationDialog
				open={confirmOptOut}
				onOpenChange={setConfirmOptOut}
				contentProps={{
					className:
						"w-[420px] max-w-[calc(100vw-32px)] rounded-[12px] border border-[oklch(1_0_0/0.12)] bg-card [html:not(.dark)_&]:border-[oklch(0_0_0/0.12)]",
				}}
				title={<>Are you sure?</>}
				description={
					<>
						Turning off anonymous telemetry stops future usage and performance reports. Signet will continue working
						normally. You can turn telemetry back on here later; changes apply immediately.
					</>
				}
				actions={
					<>
						<Button type="button" variant="outline" onClick={() => setConfirmOptOut(false)}>
							Keep telemetry on
						</Button>
						<Button
							type="button"
							variant="destructive"
							onClick={() => {
								store.aSetBool(path, false);
								void store.save();
								setConfirmOptOut(false);
							}}
						>
							Turn off telemetry
						</Button>
					</>
				}
			>
				<div className="rounded-[var(--radius)] border border-[oklch(0.78_0.15_85/0.32)] bg-[oklch(0.78_0.15_85/0.08)] px-3 py-2.5 text-[11.5px] leading-relaxed text-[oklch(0.82_0.15_85)]">
					This only changes anonymous telemetry. Your memories, configuration, and local Signet data are not deleted.
				</div>
			</ConfirmationDialog>
		</>
	);
}

const DREAMING_POLICY_FIELDS: ReadonlyArray<{ type: DreamPassType; title: string; desc: string }> = [
	{
		type: "hygiene",
		title: "Hygiene pass policy",
		desc: "Instructions for passes that work the attention queue: archives, merges, and kept records.",
	},
	{
		type: "content",
		title: "Content pass policy",
		desc: "Instructions for passes that read new evidence and file claims.",
	},
	{
		type: "combined",
		title: "Combined pass policy",
		desc: "Instructions for manual, backfill, and compact passes, which do both.",
	},
];

function DreamingPolicyEditor({
	store,
	type,
	title,
	desc,
	fallback,
	problem,
	onSaved,
}: {
	store: AgentConfigStore;
	type: DreamPassType;
	title: string;
	desc: string;
	fallback: string;
	problem: string | undefined;
	onSaved: () => void;
}) {
	const path = ["memory", "dreaming", "policies", type];
	const raw = getPath(store.agent, path);
	const configured = typeof raw === "string" && raw.trim() ? raw : null;
	const saved = configured ?? fallback;
	const [text, setText] = useState(saved);
	useEffect(() => setText(saved), [saved]);
	const commit = (value: string) => {
		if (!value.trim() || value === fallback) {
			store.aDel(path);
			setText(fallback);
		} else store.aSetStr(path, value);
		void store.save().then((saved) => {
			if (saved) onSaved();
		});
	};

	return (
		<div className="flex flex-col gap-2 py-2">
			<div className="min-w-0">
				<div className="settings-row-title">{title}</div>
				<div className="settings-row-description">
					{problem ? `${desc} This policy ${problem}.` : configured === null ? `${desc} Using the default.` : desc}
				</div>
			</div>
			<textarea
				aria-label={title}
				value={text}
				disabled={!store.ready}
				maxLength={64_000}
				spellCheck={false}
				onChange={(e) => setText(e.target.value)}
				className="min-h-[220px] w-full resize-y rounded-[var(--control-radius)] border border-[var(--border)] bg-[var(--card)] p-3 font-mono text-[12px] leading-relaxed text-[var(--foreground)]"
			/>
			<div className="flex items-center gap-2">
				<Button size="compact" disabled={!store.ready || (text === saved && !store.dirty)} onClick={() => commit(text)}>
					Save
				</Button>
				<Button
					size="compact"
					variant="ghost"
					disabled={!store.ready || (raw === undefined && !store.dirty)}
					onClick={() => commit("")}
				>
					Reset to default
				</Button>
			</div>
		</div>
	);
}

function DreamingPolicies({ store }: { store: AgentConfigStore }) {
	const [defaults, setDefaults] = useState<DreamPolicies | null>(null);
	const [problems, setProblems] = useState<Readonly<Record<string, string>>>({});
	const [failed, setFailed] = useState(false);
	const refresh = useCallback(() => {
		void api.getDreamStatus().then((status) => {
			if (!status?.config.defaultPolicies) {
				setFailed(true);
				return;
			}
			setFailed(false);
			setDefaults(status.config.defaultPolicies);
			setProblems(status.config.policyProblems);
		});
	}, []);
	useEffect(() => refresh(), [refresh]);

	if (!defaults) {
		return (
			<p className="settings-row-description">
				{failed
					? "Could not load the default pass policies from the daemon. Reload to retry."
					: "Loading pass policies…"}
			</p>
		);
	}
	const fieldKeys = DREAMING_POLICY_FIELDS.map((field) => `dreaming.policies.${field.type}`);
	const other = Object.entries(problems).filter(([key]) => !fieldKeys.includes(key));
	return (
		<>
			{failed && (
				<p className="settings-row-description">
					Could not refresh policy status from the daemon. The notes below may be out of date.
				</p>
			)}
			{other.map(([key, problem]) => (
				<p key={key} className="settings-row-description">{`${key} ${problem}.`}</p>
			))}
			{DREAMING_POLICY_FIELDS.map((field) => (
				<DreamingPolicyEditor
					key={field.type}
					store={store}
					{...field}
					fallback={defaults[field.type]}
					problem={problems[`dreaming.policies.${field.type}`]}
					onSaved={refresh}
				/>
			))}
		</>
	);
}

export function AdvancedSection() {
	const store = useAgentConfig();
	const pv2 = (key: string): readonly string[] => ["memory", "pipelineV2", key];
	const pv2Nested = (group: string, key: string): readonly string[] => ["memory", "pipelineV2", group, key];
	const srch = (key: string): readonly string[] => ["search", key];
	const drm = (key: string): readonly string[] => ["memory", "dreaming", key];
	const embPath = ["embedding"] as const;
	const writeForm = (nested: readonly string[], flat: readonly string[]): "nested" | "flat" =>
		pv2ToggleWriteForm(store.agent, nested, flat);
	const maintenanceModeNestedValue = pv2MaintenanceMode(store.agent);
	const maintenanceModeValue = maintenanceModeNestedValue ?? "";
	const maintenanceMode =
		maintenanceModeValue === "observe" || maintenanceModeValue === "execute" ? maintenanceModeValue : "execute";
	const maintenanceModeWriteForm: "nested" | "flat" = maintenanceModeNestedValue !== undefined ? "nested" : "flat";
	const graphEnabled = pv2ToggleValue(store.agent, pv2Nested("graph", "enabled"), pv2("graphEnabled"), true);
	const autonomousEnabled = pv2ToggleValue(
		store.agent,
		pv2Nested("autonomous", "enabled"),
		pv2("autonomousEnabled"),
		true,
	);
	const autonomousFrozen = pv2ToggleValue(
		store.agent,
		pv2Nested("autonomous", "frozen"),
		pv2("autonomousFrozen"),
		false,
	);
	const allowUpdateDelete = pv2ToggleValue(
		store.agent,
		pv2Nested("autonomous", "allowUpdateDelete"),
		pv2("allowUpdateDelete"),
		true,
	);
	const graphWriteForm = writeForm(pv2Nested("graph", "enabled"), pv2("graphEnabled"));
	const autonomousEnabledWriteForm = writeForm(pv2Nested("autonomous", "enabled"), pv2("autonomousEnabled"));
	const autonomousFrozenWriteForm = writeForm(pv2Nested("autonomous", "frozen"), pv2("autonomousFrozen"));
	const allowUpdateDeleteWriteForm = writeForm(pv2Nested("autonomous", "allowUpdateDelete"), pv2("allowUpdateDelete"));

	return (
		<div className="flex flex-col gap-3">
			{store.error && (
				<p role="alert" className="text-sm text-destructive">
					{store.error}
				</p>
			)}
			<SettingsGroup title="Privacy">
				<TelemetrySettings store={store} />
			</SettingsGroup>

			<SettingsGroup title="Pipeline">
				<PipelinePauseToggle store={store} />
				<ConfigFields
					store={store}
					fields={[
						{
							kind: "toggle",
							path: pv2("enabled"),
							title: "Pipeline enabled",
							desc: "Master switch. The memory pipeline does nothing when disabled.",
							fallback: true,
						},
						{
							kind: "toggle",
							path: pv2("shadowMode"),
							title: "Shadow mode",
							desc: "Run extraction and decisions without writing. Safe for evaluation.",
						},
						{
							kind: "toggle",
							path: pv2("mutationsFrozen"),
							title: "Freeze mutations",
							desc: "Emergency brake — blocks all writes even when shadow mode is off.",
						},
						{
							kind: "toggle",
							path: pv2Nested("graph", "enabled"),
							writeForm: graphWriteForm === "flat" ? pv2("graphEnabled") : undefined,
							title: "Knowledge graph",
							desc: "Build and query a graph from extracted entity relationships.",
							fallback: graphEnabled,
						},
					]}
				/>
			</SettingsGroup>

			<SettingsGroup title="Autonomy &amp; maintenance">
				<ConfigFields
					store={store}
					fields={[
						{
							kind: "toggle",
							path: pv2Nested("autonomous", "enabled"),
							writeForm: autonomousEnabledWriteForm === "flat" ? pv2("autonomousEnabled") : undefined,
							title: "Autonomous operations",
							desc: "Allow autonomous pipeline operations like maintenance and repair.",
							fallback: autonomousEnabled,
						},
						{
							kind: "toggle",
							path: pv2Nested("autonomous", "frozen"),
							writeForm: autonomousFrozenWriteForm === "flat" ? pv2("autonomousFrozen") : undefined,
							title: "Freeze autonomous writes",
							desc: "Block autonomous writes while still allowing autonomous reads.",
							fallback: autonomousFrozen,
						},
						{
							kind: "toggle",
							path: pv2Nested("autonomous", "allowUpdateDelete"),
							writeForm: allowUpdateDeleteWriteForm === "flat" ? pv2("allowUpdateDelete") : undefined,
							title: "Allow update/delete",
							desc: "Permit UPDATE/DELETE decisions on existing memories.",
							fallback: allowUpdateDelete,
						},
					]}
				/>
				<SettingRow
					title="Maintenance mode"
					desc="'observe' logs diagnostics without changes; 'execute' attempts repairs. Unset defaults to execute."
				>
					<SettingSelect
						value={maintenanceMode}
						options={[
							{ value: "observe", label: "observe" },
							{ value: "execute", label: "execute" },
						]}
						onChange={(v) => {
							store.aSetStr(
								maintenanceModeWriteForm === "flat"
									? pv2("maintenanceMode")
									: pv2Nested("autonomous", "maintenanceMode"),
								v,
							);
							void store.save();
						}}
					/>
				</SettingRow>
			</SettingsGroup>

			<SettingsGroup title="Extraction">
				<ConfigFields
					store={store}
					fields={[
						{
							kind: "number",
							path: pv2("extractionTimeout"),
							title: "Extraction timeout (ms)",
							desc: "Deadline for the extraction LLM call.",
							min: 5000,
							max: 300000,
							step: 1000,
						},
						{
							kind: "number",
							path: pv2("minFactConfidenceForWrite"),
							title: "Min fact confidence",
							desc: "Facts below this threshold are dropped. Lower captures more at the cost of noise.",
							min: 0,
							max: 1,
							step: 0.05,
						},
						{
							kind: "toggle",
							path: pv2("semanticContradictionEnabled"),
							title: "Semantic contradiction check",
							desc: "Use an LLM to detect contradictions on update proposals. Adds latency but catches subtle conflicts.",
						},
						{
							kind: "number",
							path: pv2("semanticContradictionTimeoutMs"),
							title: "Contradiction timeout (ms)",
							desc: "Falls back to 'no contradiction' on timeout.",
							min: 5000,
							max: 300000,
							step: 1000,
						},
						{
							kind: "number",
							path: pv2("workerPollMs"),
							title: "Worker poll (ms)",
							desc: "How often the pipeline worker polls for pending jobs.",
							min: 100,
							max: 60000,
							step: 100,
						},
					]}
				/>
			</SettingsGroup>

			<SettingsGroup title="Recall">
				<ConfigFields
					store={store}
					fields={[
						{
							kind: "number",
							path: srch("top_k"),
							title: "Top K",
							desc: "Candidates fetched from each source (BM25 and vector) before blending. Default 20.",
							min: 1,
							max: 100,
						},
						{
							kind: "number",
							path: srch("min_score"),
							title: "Min score",
							desc: "Results below this combined-score threshold are dropped. Default 0.3.",
							min: 0,
							max: 1,
							step: 0.05,
						},
						{
							kind: "toggle",
							path: srch("rehearsal_enabled"),
							title: "Rehearsal boost",
							desc: "Boost scores for frequently-recalled memories using access count and last-accessed time.",
						},
						{
							kind: "number",
							path: srch("rehearsal_weight"),
							title: "Rehearsal weight",
							desc: "Score multiplier for the rehearsal boost. Default 0.1.",
							min: 0,
							max: 1,
							step: 0.05,
						},
						{
							kind: "number",
							path: srch("rehearsal_half_life_days"),
							title: "Rehearsal half-life (days)",
							desc: "Days until the rehearsal boost decays to half. Default 30.",
							min: 1,
							max: 365,
						},
						{
							kind: "toggle",
							path: pv2("rerankerEnabled"),
							title: "Reranker",
							desc: "Re-score recall candidates by full-content embedding similarity. No LLM call needed.",
						},
						{
							kind: "number",
							path: pv2("rerankerTopN"),
							title: "Reranker top N",
							desc: "Number of top candidates re-scored by embedding similarity.",
							min: 1,
							max: 100,
						},
						{
							kind: "number",
							path: pv2("graphBoostWeight"),
							title: "Graph boost weight",
							desc: "Score boost applied to graph-linked memories during search.",
							min: 0,
							max: 1,
							step: 0.05,
						},
					]}
				/>
			</SettingsGroup>

			<SettingsGroup title="Dreaming">
				<DreamingToggle store={store} />
				<ConfigFields
					store={store}
					fields={[
						{
							kind: "number",
							path: drm("tokenThreshold"),
							title: "Token threshold",
							desc: "Accumulated transcript tokens that trigger a dreaming pass. Default 100,000.",
							min: 10000,
							max: 1000000,
							step: 10000,
						},
						{
							kind: "number",
							path: drm("maxConcurrentPasses"),
							title: "Concurrent passes",
							desc: "Passes that may run at once for different agents. Default 2. Never more than the shared LLM concurrency limit.",
							min: 1,
							max: 16,
							step: 1,
						},
						{
							kind: "number",
							path: drm("maxInputTokens"),
							title: "Input budget (tokens)",
							desc: "Sizes evidence reads: each page holds up to a sixteenth of this. Default 128,000. Lower it for small-context models.",
							min: 8000,
							max: 1000000,
							step: 1000,
						},
						{
							kind: "toggle",
							path: drm("backfillOnFirstRun"),
							title: "Backfill on first run",
							desc: "Process existing transcripts the first time dreaming is enabled.",
						},
					]}
				/>
				<DreamingPolicies store={store} />
			</SettingsGroup>

			<SettingsGroup title="Embeddings extras">
				<ConfigFields
					store={store}
					fields={[
						{
							kind: "number",
							path: [...embPath, "dimensions"],
							title: "Dimensions",
							desc: "Vector dimensions for the active embedding model. Changing this re-embeds everything.",
							min: 64,
							max: 4096,
						},
						{
							kind: "number",
							path: [...embPath, "promptSubmitTimeoutMs"],
							title: "Prompt-submit timeout (ms)",
							desc: "Deadline for the recall embedding before prompt injection. Raise for slow local models that cold-load.",
							min: 1000,
							max: 300000,
							step: 1000,
						},
					]}
				/>
			</SettingsGroup>
		</div>
	);
}
