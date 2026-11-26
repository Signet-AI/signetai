import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, NativeSelect } from "@/components/ui/field";
import { GroupLabel } from "@/components/settings/controls";

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
	const id = `org-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
	return (
		<Field label={label} htmlFor={id}>
			<Input id={id} type={type} value={value} required={required} onChange={(event) => onChange(event.target.value)} />
		</Field>
	);
}
export function Choice({
	label,
	value,
	onChange,
	options,
	required = false,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	options: readonly { value: string; label: string }[];
	required?: boolean;
}) {
	const id = `org-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
	return (
		<Field label={label} htmlFor={id}>
			<NativeSelect
				id={id}
				aria-label={label}
				value={value}
				required={required}
				onChange={(event) => onChange(event.target.value)}
			>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</NativeSelect>
		</Field>
	);
}
export function Action({
	children,
	onClick,
	disabled = false,
	secondary = false,
}: {
	children: ReactNode;
	onClick: () => void;
	disabled?: boolean;
	secondary?: boolean;
}) {
	return (
		<Button
			type="button"
			size="compact"
			variant={secondary ? "outline" : "default"}
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
						{columns.map((column) => (
							<th key={column} scope="col" className="px-2 py-2 font-medium text-muted-foreground">
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
export const cellClass = "px-2 py-2 align-top";
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
