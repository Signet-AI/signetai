import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GroupLabel } from "@/components/settings/controls";

export function displayLabel(value: string): string {
	const labels: Readonly<Record<string, string>> = {
		admin: "Administrator",
		readonly: "Read only",
		apiKeys: "API keys",
		sessions: "Active sessions",
		memories: "Memories",
		transcripts: "Transcripts",
		agents: "Agents",
		keep: "Keep",
		transfer: "Transfer",
		purge: "Purge",
	};
	return labels[value] ?? value.replaceAll(/[_-]/g, " ").replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}
export function agentDisplayName(
	agent: { readonly id: string; readonly name: string; readonly kind?: string } | undefined,
): string {
	if (!agent) return "Agent";
	if (agent.id === "default") return "Organization memory";
	return agent.name !== agent.id ? agent.name : `${displayLabel(agent.kind ?? "assistant")} agent`;
}
export function OrganizationBlock({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: ReactNode;
}) {
	return (
		<section aria-label={title} className="flex min-w-0 flex-col gap-3">
			<GroupLabel>{title}</GroupLabel>
			{description && <p className="settings-row-description">{description}</p>}
			{children}
		</section>
	);
}
export function TextField({
	label,
	value,
	onChange,
	type = "text",
	required = false,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	type?: string;
	required?: boolean;
}) {
	const id = useId();
	return (
		<div className="settings-row">
			<label className="settings-row-title" htmlFor={id}>
				{label}
			</label>
			<div className="settings-control">
				<Input
					id={id}
					type={type}
					value={value}
					required={required}
					onChange={(event) => onChange(event.target.value)}
				/>
			</div>
		</div>
	);
}
const NONE = "__none__";
export function Choice({
	label,
	value,
	onChange,
	options,
	inline = false,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	options: readonly { value: string; label: string }[];
	required?: boolean;
	inline?: boolean;
}) {
	const id = useId();
	return (
		<div className={inline ? "min-w-0" : "settings-row"}>
			<label className={inline ? "sr-only" : "settings-row-title"} htmlFor={id}>
				{label}
			</label>
			<Select value={value || NONE} onValueChange={(next) => onChange(next === NONE ? "" : next)}>
				<SelectTrigger
					id={id}
					size="compact"
					aria-label={label}
					className={inline ? "home-source-filter w-full" : "settings-control"}
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent position="popper" align="start" className="ui-select-menu max-h-80">
					{options.map((option) => (
						<SelectItem key={option.value || NONE} value={option.value || NONE}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
export function Action({
	children,
	onClick,
	disabled = false,
	secondary = false,
	destructive = false,
}: {
	children: ReactNode;
	onClick: () => void;
	disabled?: boolean;
	secondary?: boolean;
	destructive?: boolean;
}) {
	return (
		<Button
			className="self-start"
			type="button"
			size="compact"
			variant={destructive ? "destructive" : secondary ? "outline" : "default"}
			disabled={disabled}
			onClick={onClick}
		>
			{children}
		</Button>
	);
}
export function OrganizationTable({ columns, children }: { columns: readonly string[]; children: ReactNode }) {
	return (
		<div className="min-w-0 overflow-x-auto">
			<table className="w-full min-w-xl text-left text-small">
				<thead>
					<tr className="border-b">
						{columns.map((column, index) => (
							<th
								key={column || `actions-${index}`}
								scope="col"
								className="px-2 py-2 font-medium text-muted-foreground"
							>
								{column}
							</th>
						))}
					</tr>
				</thead>
				<tbody>{children}</tbody>
			</table>
		</div>
	);
}
export const cellClass = "px-2 py-3 align-top";
export const rowClass = "border-b hover:bg-muted/50";
export function Message({ error }: { error: string | null }) {
	return error ? (
		<p role="alert" className="text-small text-destructive">
			{error}
		</p>
	) : null;
}
export function DateValue({ value }: { value: string | null | undefined }) {
	return <>{value ? new Date(value).toLocaleString() : "Never"}</>;
}
