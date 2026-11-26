import { useWhoami } from "@/lib/session";
import { useState } from "react";
import { Panel } from "@/components/shell/panel";
import { usePanelQuery } from "@/lib/use-panel-query";
import { getJSONResult } from "@/lib/api";
import type { ClassificationPrincipal, ClassificationTarget, OrganizationClassification } from "@/lib/organization";
import {
	Action,
	Choice,
	Message,
	OrganizationBlock,
	OrganizationTable,
	TextField,
	cellClass,
	rowClass,
} from "./controls";
import { TrackedJob } from "./job";

export function ClassifyAction({ target }: { target: ClassificationTarget }) {
	const [open, setOpen] = useState(false);
	const whoami = useWhoami();
	if (!whoami) return null;
	return open ? (
		<ClassifyForm
			key={`${target.kind}:${target.agentId}:${target.id}`}
			target={target}
			onClose={() => setOpen(false)}
		/>
	) : (
		<Action secondary onClick={() => setOpen(true)}>
			Classify…
		</Action>
	);
}
function ClassifyForm({ target, onClose }: { target: ClassificationTarget; onClose: () => void }) {
	const classifications = usePanelQuery<readonly OrganizationClassification[]>("/api/classifications");
	const [classificationId, setClassificationId] = useState("");
	const [preview, setPreview] = useState<{ evidence: number; derived: number } | null>(null);
	const [jobId, setJobId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const execute = async (apply: boolean) => {
		setBusy(true);
		setError(null);
		const path = `/api/classifications/${encodeURIComponent(classificationId)}/${apply ? "apply" : "preview"}`;
		if (apply) {
			const result = await getJSONResult<{ jobId: string }>(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ target }),
			});
			setError(result.error);
			setJobId(result.data?.jobId ?? null);
		} else {
			const result = await getJSONResult<{ evidence: number; derived: number }>(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ target }),
			});
			setError(result.error);
			setPreview(result.data);
		}
		setBusy(false);
	};
	return (
		<OrganizationBlock
			title={`Classify ${target.kind}`}
			description="Classification changes include evidence and the derived state that cites it. Only the audience can read classified material."
		>
			{jobId ? (
				<TrackedJob id={jobId} />
			) : (
				<>
					<Panel
						result={classifications.result}
						empty={classifications.result?.data?.length === 0}
						emptyMessage="No classifications available."
						onRetry={classifications.refresh}
					>
						{(definitions) => (
							<Choice
								label="Classification"
								value={classificationId}
								onChange={(value) => {
									setClassificationId(value);
									setPreview(null);
								}}
								options={[
									{ value: "", label: "Select a classification" },
									...definitions
										.filter((item) => !item.archived_at)
										.map((item) => ({ value: item.id, label: item.name })),
								]}
							/>
						)}
					</Panel>
					<Action disabled={busy || !classificationId} onClick={() => void execute(false)}>
						Preview impact
					</Action>
					{preview && (
						<>
							<p role="status" className="text-small">
								This will reclassify {preview.evidence} readable evidence rows and {preview.derived} derived claims and
								supporting rows.
							</p>
							<Action disabled={busy} onClick={() => void execute(true)}>
								Apply classification
							</Action>
						</>
					)}
				</>
			)}
			<Message error={error} />
			<Action secondary onClick={onClose}>
				Close classification
			</Action>
		</OrganizationBlock>
	);
}

export function PrincipalEditor({
	title,
	values,
	onChange,
}: {
	title: string;
	values: readonly ClassificationPrincipal[];
	onChange: (values: readonly ClassificationPrincipal[]) => void;
}) {
	const [kind, setKind] = useState("user");
	const [id, setId] = useState("");
	return (
		<OrganizationBlock title={title}>
			<div className="grid gap-3 sm:grid-cols-2">
				<Choice
					label={`${title} principal kind`}
					value={kind}
					onChange={setKind}
					options={[
						{ value: "user", label: "User" },
						{ value: "group", label: "Team" },
					]}
				/>
				<TextField label={`${title} principal ID`} value={id} onChange={setId} />
			</div>
			<Action
				secondary
				disabled={!id.trim()}
				onClick={() => {
					const value: ClassificationPrincipal = { kind: kind === "group" ? "group" : "user", id: id.trim() };
					if (!values.some((item) => item.kind === value.kind && item.id === value.id)) onChange([...values, value]);
					setId("");
				}}
			>
				Add {title.toLowerCase()} principal
			</Action>
			{values.map((value) => (
				<div className="settings-row" key={`${value.kind}:${value.id}`}>
					<span className="text-small">
						{value.kind}: {value.id}
					</span>
					<Action secondary onClick={() => onChange(values.filter((item) => item !== value))}>
						Remove {value.id}
					</Action>
				</div>
			))}
		</OrganizationBlock>
	);
}
export function ClassificationsContent({
	classifications,
	canManage,
	refresh,
}: {
	classifications: readonly OrganizationClassification[];
	canManage: boolean;
	refresh: () => void;
}) {
	const [selected, setSelected] = useState<OrganizationClassification | null>(null);
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState("");
	const [color, setColor] = useState("");
	const [description, setDescription] = useState("");
	const [audience, setAudience] = useState<readonly ClassificationPrincipal[]>([]);
	const [appliers, setAppliers] = useState<readonly ClassificationPrincipal[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [items, setItems] = useState<unknown>(null);
	const select = (item: OrganizationClassification | null) => {
		setSelected(item);
		setName(item?.name ?? "");
		setColor(item?.color ?? "");
		setDescription(item?.description ?? "");
		setAudience(item?.audience ?? []);
		setAppliers(item?.appliers ?? []);
		setItems(null);
		setEditing(true);
	};
	const save = async (archive = false) => {
		setBusy(true);
		setError(null);
		const path = selected ? `/api/classifications/${encodeURIComponent(selected.id)}` : "/api/classifications";
		const result = await getJSONResult(path, {
			method: selected ? "PATCH" : "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(
				selected
					? { name, color: color || null, description, ...(archive ? { archived: true } : {}) }
					: { name, color: color || undefined, description, audience, appliers },
			),
		});
		if (result.data && selected && !archive && selected.audience !== undefined && selected.appliers !== undefined) {
			for (const [suffix, values] of [
				["audience", audience],
				["appliers", appliers],
			] as const) {
				const saved = await getJSONResult(`${path}/${suffix}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(values),
				});
				if (saved.error) {
					setError(`${suffix} was not saved: ${saved.error}`);
					setBusy(false);
					refresh();
					return;
				}
			}
		}
		setBusy(false);
		setError(result.error);
		if (result.data) {
			setEditing(false);
			refresh();
		}
	};
	const listItems = async (item: OrganizationClassification) => {
		setSelected(item);
		setEditing(false);
		const result = await getJSONResult(`/api/classifications/${encodeURIComponent(item.id)}/items`);
		setError(result.error);
		setItems(result.data);
	};
	return (
		<div className="flex flex-col gap-6">
			<OrganizationBlock
				title="Classifications"
				description="A classification audience is the security boundary. Administrative roles do not bypass it."
			>
				<OrganizationTable columns={["Name", "Description", "State", "Actions"]}>
					{classifications.map((item) => (
						<tr key={item.id} className={rowClass}>
							<td className={cellClass}>{item.name}</td>
							<td className={cellClass}>{item.description}</td>
							<td className={cellClass}>{item.archived_at ? "Archived" : "Active"}</td>
							<td className={cellClass}>
								<div className="flex gap-2">
									<Action secondary onClick={() => void listItems(item)}>
										Items
									</Action>
									{canManage && (
										<Action secondary onClick={() => select(item)}>
											Edit
										</Action>
									)}
								</div>
							</td>
						</tr>
					))}
				</OrganizationTable>
				{canManage && <Action onClick={() => select(null)}>Create classification</Action>}
			</OrganizationBlock>
			{editing && canManage && (
				<OrganizationBlock title={selected ? `Edit ${selected.name}` : "New classification"}>
					<TextField label="Classification name" value={name} onChange={setName} />
					<TextField label="Classification color" value={color} onChange={setColor} />
					<TextField label="Classification description" value={description} onChange={setDescription} />
					{!selected || (selected.audience !== undefined && selected.appliers !== undefined) ? (
						<>
							<PrincipalEditor title="Audience" values={audience} onChange={setAudience} />
							<PrincipalEditor title="Appliers" values={appliers} onChange={setAppliers} />
							<p className="settings-row-description">
								An empty appliers list allows material owners to apply this classification.
							</p>
						</>
					) : (
						<p role="status" className="settings-row-description">
							Audience editing is unavailable: the daemon did not return its current principals. Existing membership
							will not be overwritten.
						</p>
					)}
					<Action disabled={busy || !name.trim()} onClick={() => void save()}>
						Save classification
					</Action>
					{selected && (
						<Action
							secondary
							disabled={busy}
							onClick={() => {
								if (window.confirm(`Archive ${selected.name}? Existing assignments remain in force.`)) void save(true);
							}}
						>
							Archive classification
						</Action>
					)}
					<Action secondary onClick={() => setEditing(false)}>
						Cancel edit
					</Action>
				</OrganizationBlock>
			)}
			{items !== null && (
				<OrganizationBlock title={`${selected?.name ?? "Classification"} items`}>
					<pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-small">
						{JSON.stringify(items, null, 2)}
					</pre>
				</OrganizationBlock>
			)}
			<Message error={error} />
		</div>
	);
}
