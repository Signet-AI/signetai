/**
 * Connect-provider controller — React port of the old Svelte dashboard's
 * ConnectProviderController state machine. Two flows share one reducer:
 *   1. OAuth login (Claude Max / ChatGPT Codex / GitHub Copilot) — driven by
 *      the daemon's SSE login stream; events advance the machine.
 *   2. API-key connect — paste a key, advisory-validate, save to the vault.
 * States are an exhaustive union so impossible states are unrepresentable.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type OAuthLoginEvent,
	type OAuthLoginHandle,
	completeOAuthInteraction,
	disconnectOAuthProvider,
	startOAuthLogin,
} from "@/lib/api";
import { type KeyValidationState, validateApiKey } from "@/lib/inference-keys";

export type ConnectPhase =
	| { kind: "method" }
	| {
			kind: "oauth-running";
			url?: string;
			deviceCode?: { userCode: string; verificationUri: string };
			prompt?: PendingPrompt;
			progress?: string;
	  }
	| { kind: "key-entry"; key: string; reveal: boolean; validation: KeyValidationState }
	| { kind: "saving" }
	| { kind: "connected" }
	| { kind: "error"; message: string };

export interface PendingPrompt {
	readonly responseId: string;
	readonly kind: "text" | "select" | "manual_code";
	readonly message: string;
	readonly placeholder?: string;
	readonly allowEmpty?: boolean;
	readonly options?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

export interface ConnectControllerOptions {
	readonly providerId: string;
	readonly supportsOAuth: boolean;
	readonly supportsApiKey: boolean;
	/** Fired when the daemon emits a URL the user must open. */
	readonly onNavigate?: (url: string) => void;
	/** Fired once when the login stores the credential daemon-side. */
	readonly onConnected?: () => void;
}

export interface ConnectController {
	phase: ConnectPhase;
	singlePath: "oauth" | "key" | "choice";
	startOAuth: () => void;
	answerPrompt: (value: string) => Promise<void>;
	cancelOAuth: () => void;
	disconnect: () => Promise<boolean>;
	enterKeyMode: () => void;
	setKey: (value: string) => void;
	toggleReveal: () => void;
	beginSaving: () => void;
	finishSaved: (ok: boolean, message?: string) => void;
	setError: (message: string) => void;
	reset: () => void;
}

export function useConnectController(opts: ConnectControllerOptions): ConnectController {
	const [phase, setPhase] = useState<ConnectPhase>({ kind: "method" });
	const loginRef = useRef<OAuthLoginHandle | null>(null);
	const phaseRef = useRef(phase);
	phaseRef.current = phase;
	const optsRef = useRef(opts);
	optsRef.current = opts;

	useEffect(
		() => () => {
			loginRef.current?.close();
			loginRef.current = null;
		},
		[],
	);

	const startOAuth = useCallback(() => {
		const current = phaseRef.current;
		if (current.kind !== "method" && current.kind !== "error") return;
		setPhase({ kind: "oauth-running" });

		void (async () => {
			let url: string | undefined;
			let deviceCode: { userCode: string; verificationUri: string } | undefined;
			let progress: string | undefined;
			let prompt: PendingPrompt | undefined;
			const handle = await startOAuthLogin(optsRef.current.providerId, () => {
				optsRef.current.onConnected?.();
			});
			loginRef.current = handle;
			const apply = () =>
				setPhase(prompt || url || deviceCode || progress ? { kind: "oauth-running", url, deviceCode, progress, prompt } : { kind: "oauth-running" });
			handle.onEvent((event: OAuthLoginEvent) => {
				switch (event.type) {
					case "auth":
						url = event.url;
						optsRef.current.onNavigate?.(event.url);
						apply();
						break;
					case "device_code":
						deviceCode = { userCode: event.userCode, verificationUri: event.verificationUri };
						optsRef.current.onNavigate?.(event.verificationUri);
						apply();
						break;
					case "prompt":
						prompt = {
							responseId: event.responseId,
							kind: "text",
							message: event.message,
							placeholder: event.placeholder,
							allowEmpty: event.allowEmpty === true,
						};
						apply();
						break;
					case "select":
						prompt = { responseId: event.responseId, kind: "select", message: event.message, options: event.options };
						apply();
						break;
					case "manual_code":
						prompt = { responseId: event.responseId, kind: "manual_code", message: event.message };
						apply();
						break;
					case "progress":
						progress = event.message;
						apply();
						break;
					case "connected":
						setPhase({ kind: "connected" });
						break;
					case "error":
						setPhase({ kind: "error", message: event.error });
						break;
					case "session":
					case "done":
						break;
				}
			});
			handle.onError((message) => {
				if (phaseRef.current.kind === "oauth-running") setPhase({ kind: "error", message });
			});
		})();
	}, []);

	const answerPrompt = useCallback(async (value: string) => {
		const sessionId = loginRef.current?.sessionId;
		const current = phaseRef.current;
		const prompt = current.kind === "oauth-running" ? current.prompt : undefined;
		if (!sessionId || !prompt) return;
		let ok: boolean;
		try {
			ok = await completeOAuthInteraction(sessionId, prompt.responseId, value);
		} catch (error) {
			setPhase({
				kind: "error",
				message: error instanceof Error ? error.message : "Could not reach the daemon.",
			});
			return;
		}
		if (!ok) {
			setPhase({ kind: "error", message: "The provider rejected that response. Try again." });
			return;
		}
		const latest = phaseRef.current;
		if (latest.kind === "oauth-running") setPhase({ ...latest, prompt: undefined });
	}, []);

	const cancelOAuth = useCallback(() => {
		loginRef.current?.close();
		loginRef.current = null;
		setPhase({ kind: "method" });
	}, []);

	const disconnect = useCallback(() => disconnectOAuthProvider(optsRef.current.providerId), []);

	const enterKeyMode = useCallback(() => {
		setPhase({ kind: "key-entry", key: "", reveal: false, validation: "empty" });
	}, []);

	const setKey = useCallback((value: string) => {
		const current = phaseRef.current;
		if (current.kind !== "key-entry") return;
		setPhase({ ...current, key: value, validation: validateApiKey(optsRef.current.providerId, value) });
	}, []);

	const toggleReveal = useCallback(() => {
		const current = phaseRef.current;
		if (current.kind === "key-entry") setPhase({ ...current, reveal: !current.reveal });
	}, []);

	const beginSaving = useCallback(() => setPhase({ kind: "saving" }), []);

	const finishSaved = useCallback((ok: boolean, message?: string) => {
		setPhase(ok ? { kind: "connected" } : { kind: "error", message: message ?? "Could not save the key." });
	}, []);

	const setError = useCallback((message: string) => setPhase({ kind: "error", message }), []);

	const reset = useCallback(() => {
		loginRef.current?.close();
		loginRef.current = null;
		setPhase({ kind: "method" });
	}, []);

	return {
		phase,
		singlePath: opts.supportsOAuth && !opts.supportsApiKey ? "oauth" : opts.supportsApiKey && !opts.supportsOAuth ? "key" : "choice",
		startOAuth,
		answerPrompt,
		cancelOAuth,
		disconnect,
		enterKeyMode,
		setKey,
		toggleReveal,
		beginSaving,
		finishSaved,
		setError,
		reset,
	};
}
