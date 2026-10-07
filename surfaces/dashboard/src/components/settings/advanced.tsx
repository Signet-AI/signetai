import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { Switch } from "@/components/ui/switch";
import {
	type AgentConfigStore,
	dreamingBlockedBy,
	pv2MaintenanceMode,
	pv2ToggleValue,
	pv2ToggleWriteForm,
	setPipelinePaused,
	useAgentConfig,
} from "@/lib/agent-config";
import { useState } from "react";

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
		blockedBy === "paused"
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

function readTelemetryEnabled(agent: Record<string, unknown>): boolean {
	const memory = agent.memory;
	if (memory == null || typeof memory !== "object" || Array.isArray(memory)) return true;
	const pipeline = (memory as Record<string, unknown>).pipelineV2;
	if (pipeline == null || typeof pipeline !== "object" || Array.isArray(pipeline)) return true;
	const value = (pipeline as Record<string, unknown>).telemetryEnabled;
	return typeof value === "boolean" ? value : true;
}

function TelemetrySettings({ store }: { store: AgentConfigStore }) {
	const [confirmOptOut, setConfirmOptOut] = useState(false);
	const path = ["memory", "pipelineV2", "telemetryEnabled"] as const;
	const enabled = readTelemetryEnabled(store.agent);

	return (
		<>
			<SettingRow
				title="Anonymous telemetry"
				desc="Share anonymous usage and performance data to help improve Signet. No memory content or personal identity is sent."
			>
				<Switch
					checked={enabled}
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
						normally. You can turn telemetry back on here later; it will resume after the daemon restarts.
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
							path: srch("alpha"),
							title: "Alpha",
							desc: "Vector weight (0–1). 0.9 is heavily semantic; 0.3 skews toward keyword matching. Default 0.7.",
							min: 0,
							max: 1,
							step: 0.05,
						},
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
							kind: "toggle",
							path: drm("backfillOnFirstRun"),
							title: "Backfill on first run",
							desc: "Process existing transcripts the first time dreaming is enabled.",
						},
					]}
				/>
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
