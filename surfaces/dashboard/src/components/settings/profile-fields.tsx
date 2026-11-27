import type { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";

export function ProfileFields({
	name,
	email,
	editableFields,
	ssoManaged,
	busy,
	onNameChange,
	onSubmit,
}: {
	readonly name: string;
	readonly email: string;
	readonly editableFields: readonly string[];
	readonly ssoManaged: boolean;
	readonly busy: boolean;
	readonly onNameChange: (value: string) => void;
	readonly onSubmit: (event: FormEvent) => void;
}) {
	return (
		<form aria-label="Edit profile" className="flex flex-col gap-4" onSubmit={onSubmit}>
			<label htmlFor="profile-name" className="flex flex-col gap-1.5 text-small">
				Name
				<Input
					id="profile-name"
					name="displayName"
					value={name}
					required
					maxLength={128}
					readOnly={ssoManaged || !editableFields.includes("displayName")}
					onChange={(event) => onNameChange(event.target.value)}
				/>
			</label>
			<label htmlFor="profile-email" className="flex flex-col gap-1.5 text-small">
				Email
				<Input id="profile-email" name="email" type="email" value={email} maxLength={320} readOnly />
			</label>
			<p className="m-0 text-small text-muted-foreground">Ask an administrator to change your email</p>
			{ssoManaged && <p className="m-0 text-small text-muted-foreground">Managed by your identity provider</p>}
			{!ssoManaged && editableFields.length > 0 && (
				<Button type="submit" disabled={busy} className="self-start">
					{busy ? "Saving…" : "Save profile"}
				</Button>
			)}
		</form>
	);
}
