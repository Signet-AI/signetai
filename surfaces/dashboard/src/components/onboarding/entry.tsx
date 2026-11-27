import { attempt } from "@signet/core/attempt";
import { type ReactNode, useState } from "react";
import { AuthField, AuthPage } from "@/components/shell/auth-entry";
import { Button } from "@/components/ui/button";

export function instanceOrigin(input: string): string | null {
	const url = attempt(() => new URL(input));
	if (
		!url ||
		!["https:", "http:"].includes(url.protocol) ||
		!/^[a-z\d.:[\]-]+$/i.test(url.hostname) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		return null;
	return url.origin;
}

export function OnboardingEntry({
	personal,
	onPersonal,
}: {
	readonly personal: ReactNode;
	readonly onPersonal?: () => void;
}) {
	const [choice, setChoice] = useState<"personal" | "join" | "host" | null>(null);
	const [url, setUrl] = useState("");
	const origin = instanceOrigin(url);
	if (choice === "personal") return personal;
	return (
		<AuthPage
			title={
				choice === "join"
					? "Join an organization"
					: choice === "host"
						? "Host an organization instance"
						: "Set up Signet"
			}
			description={
				choice
					? "Choose the instance explicitly. Signet never switches your existing workspace for you."
					: "Use Signet for yourself, join your team, or run an organization instance."
			}
		>
			{choice === null ? (
				<div className="flex flex-col gap-4">
					{(
						[
							["personal", "Personal workspace", "Set up memory for your own agents on this computer."],
							["join", "Join an organization", "Sign in to your organization's instance from your own computer."],
							[
								"host",
								"Host an organization instance",
								"Bootstrap a shared instance on a server. No server harnesses are installed.",
							],
						] as const
					).map(([value, label, description]) => (
						<div className="flex flex-col gap-3 rounded-lg border p-4" key={value}>
							<Button
								variant="outline"
								className="self-start"
								onClick={() => {
									if (value === "personal") onPersonal?.();
									setChoice(value);
								}}
							>
								{label}
							</Button>
							<p className="text-small text-muted-foreground">{description}</p>
						</div>
					))}
				</div>
			) : (
				<div className="flex flex-col gap-4 text-small">
					{choice === "join" ? (
						<>
							<p>
								Your local workspace is never replaced. Connect each harness to either personal or organization memory.
								No personal memories are copied unless you explicitly choose to export and import them.
							</p>
							<p>
								Use an invitation from your administrator, open the organization's dashboard below, or run this on your
								computer:
							</p>
							<pre className="overflow-x-auto rounded-lg border p-4">
								<code>signet setup --join {origin ?? "<organization-url>"}</code>
							</pre>
						</>
					) : (
						<>
							<p>
								Run this on the server. It creates a team-mode workspace, checks the public URL, and prints a setup URL
								and a one-time setup token.
							</p>
							<pre className="overflow-x-auto rounded-lg border p-4">
								<code>signet setup --host</code>
							</pre>
							<p>
								Do not expose a hybrid-mode daemon behind a reverse proxy. Use team mode and HTTPS for an organization
								instance. Keep the setup token private and enter it only on the claim screen.
							</p>
							<p>After the command finishes, open the server's setup URL from this computer.</p>
						</>
					)}
					<AuthField
						name="organization-url"
						label="Organization URL"
						type="url"
						value={url}
						onChange={setUrl}
						required={false}
					/>
					{url && !origin && (
						<p role="alert" className="text-destructive">
							Enter an HTTP or HTTPS instance origin without a path, query, fragment, or credentials.
						</p>
					)}
					{origin && (
						<Button className="self-start" asChild>
							<a href={choice === "host" ? `${origin}/auth/setup` : origin}>
								{choice === "host" ? "Open setup" : "Open organization"}
							</a>
						</Button>
					)}
					<Button variant="outline" className="self-start" onClick={() => setChoice(null)}>
						Back
					</Button>
				</div>
			)}
		</AuthPage>
	);
}
