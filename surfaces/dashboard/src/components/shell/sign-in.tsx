import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog as DialogPrimitive, Popover } from "radix-ui";
import { SignetMark } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import {
	type Session,
	type SignInResult,
	cancelRenewal,
	requestRenewal,
	signInWithKey,
	signInWithPassword,
	signOut,
} from "@/lib/session";
import heroBackground from "@/assets/hero-bg.avif";

type SignedOut = Extract<Session, { kind: "signed-out" }>;

export function describeTarget(mode: string): string {
	const label = mode.charAt(0).toUpperCase() + mode.slice(1);
	return typeof location === "undefined" ? label : `${label} · ${location.host}`;
}

function SignInForm({ session }: { session: SignedOut }) {
	const password = session.providers.find((provider) => provider.type === "password" && provider.enabled);
	const [useKey, setUseKey] = useState(!password);
	const [username, setUsername] = useState(password?.username ?? "");
	const [secret, setSecret] = useState("");
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [retryUntil, setRetryUntil] = useState(0);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (retryUntil <= Date.now()) return;
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, [retryUntil]);

	const waiting = Math.ceil((retryUntil - now) / 1_000);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		const result: SignInResult = useKey ? await signInWithKey(key) : await signInWithPassword(username, secret);
		setBusy(false);
		if (result.ok) return;
		setError(result.error);
		if (result.retryAfter) {
			setNow(Date.now());
			setRetryUntil(Date.now() + result.retryAfter * 1_000);
		}
	};

	const message = waiting > 0 ? `Too many attempts. Try again in ${waiting}s.` : (error ?? session.reason);
	return (
		<form className="flex flex-col gap-5" onSubmit={submit} aria-label="Sign in to Signet">
			<div className="flex flex-col items-center gap-3 text-center">
				<h1 className="m-0 text-[28px] leading-[1.1] font-medium tracking-[-0.035em]">
					{session.expired ? "Sign in again" : "Sign in to Signet"}
				</h1>
				<p className="m-0 rounded-full border px-2.5 py-0.5 font-mono text-[11px] text-muted-foreground">
					{describeTarget(session.mode)}
				</p>
			</div>
			{message && (
				<p role="alert" className="m-0 text-center text-[13px] text-destructive">
					{message}
				</p>
			)}
			{useKey ? (
				<FormField
					id="signet-sign-in-key"
					label="API key"
					hint="Signet trades the key for a browser session and doesn't store the key."
				>
					<Input
						id="signet-sign-in-key"
						type="password"
						className="h-9 text-[13px]"
						autoComplete="off"
						spellCheck={false}
						value={key}
						onChange={(event) => setKey(event.target.value)}
						required
						autoFocus
					/>
				</FormField>
			) : (
				<>
					<FormField id="signet-sign-in-username" label="Username">
						<Input
							id="signet-sign-in-username"
							className="h-9 text-[13px]"
							autoComplete="username"
							value={username}
							onChange={(event) => setUsername(event.target.value)}
							required
							autoFocus={!username}
						/>
					</FormField>
					<FormField id="signet-sign-in-password" label="Password">
						<Input
							id="signet-sign-in-password"
							type="password"
							className="h-9 text-[13px]"
							autoComplete="current-password"
							value={secret}
							onChange={(event) => setSecret(event.target.value)}
							required
							autoFocus={Boolean(username)}
						/>
					</FormField>
				</>
			)}
			<Button type="submit" disabled={busy || waiting > 0} className="mt-1 h-9 w-full rounded-full">
				{busy ? "Signing in…" : "Sign in"}
			</Button>
			{password ? (
				<>
					<div className="flex items-center gap-3 text-xs text-muted-foreground">
						<span className="h-px flex-1 bg-border" />
						or
						<span className="h-px flex-1 bg-border" />
					</div>
					<Button
						type="button"
						variant="outline"
						className="h-9 w-full rounded-full"
						onClick={() => {
							setUseKey(!useKey);
							setError(null);
						}}
					>
						{useKey ? "Use username and password" : "Use an API key instead"}
					</Button>
				</>
			) : (
				<p className="m-0 text-center text-[13px] text-muted-foreground">
					Password sign-in is not configured on this daemon.
				</p>
			)}
			{session.renewal && (
				<Button type="button" variant="ghost" size="sm" className="self-center" onClick={() => void cancelRenewal()}>
					Not now
				</Button>
			)}
		</form>
	);
}

function FormField({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<label htmlFor={id} className="text-[13px] font-medium">
				{label}
			</label>
			{children}
			{hint && <p className="m-0 text-xs text-muted-foreground">{hint}</p>}
		</div>
	);
}

const HERO_SHADE = [
	"linear-gradient(180deg, rgba(4, 15, 26, 0) 55%, rgba(4, 15, 26, 0.82) 100%)",
	"linear-gradient(90deg, rgba(4, 15, 26, 0.25) 0%, rgba(4, 15, 26, 0) 40%)",
].join(", ");

export function SignInScreen({ session }: { session: SignedOut }) {
	return (
		<div className="grid h-full min-h-0 overflow-auto bg-background text-foreground lg:grid-cols-2">
			<div className="flex flex-col p-6 md:p-10">
				<div className="flex items-center justify-center gap-2.5 md:justify-start">
					<SignetMark className="h-6 w-5 shrink-0" aria-hidden="true" />
					<span className="text-[15px] font-medium tracking-tight">Signet</span>
				</div>
				<div className="flex flex-1 items-center justify-center py-10">
					<div className="w-full max-w-[340px]">
						<SignInForm session={session} />
					</div>
				</div>
			</div>
			<div className="hidden p-3 lg:block">
				<div
					className="relative h-full overflow-hidden rounded-[20px] bg-[#040f1a]"
					style={{
						backgroundImage: `${HERO_SHADE}, url(${heroBackground})`,
						backgroundSize: "cover",
						backgroundPosition: "84% 50%",
					}}
				>
					<p className="absolute inset-x-10 bottom-10 m-0 text-[clamp(28px,2.7vw,44px)] leading-[1] font-medium tracking-[-0.055em] text-white">
						The memory layer
						<br />
						<span className="text-[#a9b8f4]">for every agent you use.</span>
					</p>
				</div>
			</div>
		</div>
	);
}

export function SignInDialog({ session }: { session: SignedOut }) {
	return (
		<DialogPrimitive.Root open>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
				<DialogPrimitive.Content
					className="fixed top-1/2 left-1/2 z-50 w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-6 shadow-lg outline-none sm:max-w-[360px]"
					onEscapeKeyDown={(event) => event.preventDefault()}
					onPointerDownOutside={(event) => event.preventDefault()}
					aria-describedby={undefined}
				>
					<DialogPrimitive.Title className="sr-only">Session ended</DialogPrimitive.Title>
					<SignInForm session={session} />
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

function formatExpiry(expiresAt: number): string {
	return new Date(expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function SessionChip({ session }: { session: Session }) {
	if (session.kind === "open" && session.mode !== "local") {
		return (
			<span className="font-mono text-[10px] text-muted-foreground" title="Trusted loopback request">
				{describeTarget(session.mode)}
			</span>
		);
	}
	if (session.kind !== "signed-in") return null;
	const { identity } = session;
	return (
		<Popover.Root>
			<Popover.Trigger asChild>
				<Button variant="ghost" size="xs" className="sig-no-drag font-mono text-[10px] text-muted-foreground">
					{describeTarget(session.mode)}
				</Button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					sideOffset={6}
					align="end"
					className="z-50 flex w-[260px] flex-col gap-3 rounded-lg border bg-popover p-3 text-popover-foreground shadow-md"
				>
					<dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
						<dt className="text-muted-foreground">Signed in as</dt>
						<dd className="m-0 truncate font-mono" title={identity.sub}>
							{identity.name ?? identity.sub}
						</dd>
						<dt className="text-muted-foreground">Role</dt>
						<dd className="m-0 font-mono">{identity.role}</dd>
						<dt className="text-muted-foreground">Expires</dt>
						<dd className="m-0">{formatExpiry(identity.expiresAt)}</dd>
					</dl>
					<Button variant="secondary" size="sm" onClick={() => void signOut()}>
						Sign out of this browser
					</Button>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

export function SessionExpiryToast({ session }: { session: Session }) {
	const expiresAt = session.kind === "signed-in" && session.expiresSoon ? session.identity.expiresAt : null;
	useEffect(() => {
		if (expiresAt === null) {
			toast.dismiss("session-expiry");
			return;
		}
		const time = new Date(expiresAt).toLocaleTimeString(undefined, { timeStyle: "short" });
		toast(`Your session ends at ${time}.`, {
			id: "session-expiry",
			duration: Number.POSITIVE_INFINITY,
			action: { label: "Sign in again", onClick: requestRenewal },
		});
	}, [expiresAt]);
	return null;
}
