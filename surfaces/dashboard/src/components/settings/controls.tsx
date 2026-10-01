import type { ReactNode, ComponentProps } from "react";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const NONE = "__none__";

export function GroupLabel({ children, suffix }: { children: ReactNode; suffix?: ReactNode }) {
	return (
		<div className="settings-group-label">
			{children}
			{suffix && <span className="font-normal normal-case tracking-normal text-muted-foreground"> {suffix}</span>}
		</div>
	);
}

export function SettingRow({ title, desc, children }: { title: ReactNode; desc?: string; children: ReactNode }) {
	return (
		<div className="settings-row">
			<div className="min-w-0">
				<div className="settings-row-title">{title}</div>
				{desc && <div className="settings-row-description">{desc}</div>}
			</div>
			<div className="flex shrink-0 items-center">{children}</div>
		</div>
	);
}

export function SettingSelect({
	value,
	options,
	onChange,
	placeholder = "— select —",
}: {
	value: string;
	options: { value: string; label: string }[];
	onChange: (value: string) => void;
	placeholder?: string;
}) {
	return (
		<Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
			<SelectTrigger
				size="compact"
				className="settings-control"
				title={options.find((option) => option.value === value)?.label}
			>
				<SelectValue placeholder={placeholder} />
			</SelectTrigger>
			<SelectContent position="popper" align="start" className="ui-select-menu max-h-[320px]">
				<SelectItem value={NONE}>— none —</SelectItem>
				{options.map((o) => (
					<SelectItem key={o.value} value={o.value}>
						{o.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

export function SettingInput({
	value,
	placeholder,
	onChange,
	type = "text",
}: {
	value: string;
	placeholder?: string;
	onChange: (value: string) => void;
	type?: string;
}) {
	return (
		<div className="settings-control">
			<Input
				type={type}
				value={value}
				placeholder={placeholder}
				autoComplete="off"
				spellCheck={false}
				onChange={(e) => onChange(e.target.value)}
			/>
		</div>
	);
}

export function SettingValue({ value, sub }: { value: string; sub?: string }) {
	return (
		<span className="ui-value settings-control">
			<span>{value}</span>
			{sub && <span className="ui-value-sub">{sub}</span>}
		</span>
	);
}

export function SettingNumber({
	value,
	min,
	max,
	step,
	onCommit,
}: {
	value: string;
	min: number;
	max: number;
	step?: number;
	onCommit: (n: number) => void;
}) {
	const [text, setText] = useState(value);
	useEffect(() => setText(value), [value]);
	const commit = () => {
		const n = Number.parseFloat(text);
		if (!Number.isFinite(n)) {
			setText(value);
			return;
		}
		const clamped = Math.min(max, Math.max(min, n));
		if (String(clamped) !== value) onCommit(clamped);
		setText(String(clamped));
	};
	return (
		<div className="settings-control">
			<Input
				type="number"
				value={text}
				min={min}
				max={max}
				step={step ?? 1}
				onChange={(e) => setText(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") commit();
				}}
			/>
		</div>
	);
}

export function SettingsGroup({
	title,
	suffix,
	className,
	children,
	...props
}: ComponentProps<"section"> & { suffix?: ReactNode }) {
	return (
		<section className={cn("settings-group", className)} {...props}>
			{title && <GroupLabel suffix={suffix}>{title}</GroupLabel>}
			{children}
		</section>
	);
}
