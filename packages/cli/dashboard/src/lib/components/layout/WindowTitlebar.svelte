<script lang="ts">
	import { titlebar, type DecorationMode } from "$lib/stores/titlebar.svelte";
	import Minus from "@lucide/svelte/icons/minus";
	import Square from "@lucide/svelte/icons/square";
	import X from "@lucide/svelte/icons/x";
	import Copy from "@lucide/svelte/icons/copy";
	import Monitor from "@lucide/svelte/icons/monitor";
	import AppWindowMac from "@lucide/svelte/icons/app-window-mac";
	import EyeOff from "@lucide/svelte/icons/eye-off";

	const isTauri =
		typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

	let maximized = $state(false);
	let hovered = $state(false);

	// Tauri window API — lazy loaded to avoid errors in browser
	let windowApi: typeof import("@tauri-apps/api/window") | null = null;

	async function ensureApi() {
		if (!isTauri) return null;
		if (!windowApi) {
			windowApi = await import("@tauri-apps/api/window");
		}
		return windowApi;
	}

	// Track maximized state via resize event (no polling).
	// onResized fires synchronously on maximize/restore/resize.
	// Guard: if teardown happens while init() is still awaiting, check
	// `cancelled` after onResized resolves and immediately unlisten.
	$effect(() => {
		if (!isTauri) return;
		let unlisten: (() => void) | null = null;
		let cancelled = false;

		async function init() {
			const api = await ensureApi();
			if (!api || cancelled) return;
			const win = api.getCurrentWindow();
			maximized = await win.isMaximized();
			const stop = await win.onResized(async () => {
				if (cancelled) return;
				maximized = await win.isMaximized();
			});
			// If teardown ran while we were awaiting onResized, unlisten immediately
			if (cancelled) {
				stop();
				return;
			}
			unlisten = stop;
		}

		init();
		return () => {
			cancelled = true;
			unlisten?.();
		};
	});

	// Native dimensions in logical pixels, scaled to match OS chrome.
	// macOS: 28px titlebar, 12px traffic lights, 8px gap
	// Windows: 32px titlebar, 46x32px caption buttons
	// We scale relative to 1x baseline so higher DPI displays get
	// correctly proportioned chrome.
	const MACOS_HEIGHT = 28;
	const MACOS_DOT = 12;
	const MACOS_GAP = 8;
	const WIN_HEIGHT = 32;
	const WIN_BTN_W = 46;

	const barHeight = $derived(
		titlebar.mode === "macos" ? MACOS_HEIGHT : WIN_HEIGHT,
	);
	const dotSize = $derived(MACOS_DOT);
	const dotGap = $derived(MACOS_GAP);
	const winBtnWidth = $derived(WIN_BTN_W);

	async function minimize() {
		const api = await ensureApi();
		if (!api) return;
		await api.getCurrentWindow().minimize();
	}

	async function toggleMaximize() {
		const api = await ensureApi();
		if (!api) return;
		await api.getCurrentWindow().toggleMaximize();
	}

	async function close() {
		const api = await ensureApi();
		if (!api) return;
		await api.getCurrentWindow().close();
	}

	function cycleMode() {
		const modes: DecorationMode[] = ["macos", "windows", "none"];
		const idx = modes.indexOf(titlebar.mode);
		titlebar.mode = modes[(idx + 1) % modes.length];
	}

	const modeLabel: Record<DecorationMode, string> = {
		macos: "macOS",
		windows: "Windows",
		none: "None",
	};

	const ModeIcon = $derived(
		titlebar.mode === "macos"
			? AppWindowMac
			: titlebar.mode === "windows"
				? Monitor
				: EyeOff,
	);
</script>

{#if isTauri && !titlebar.visible}
	<!-- "none" mode: invisible drag strip so the window stays movable.
	     Without this, `decorations: false` + no titlebar = permanently stuck. -->
	<div class="titlebar__drag-strip" data-tauri-drag-region></div>
{/if}

{#if isTauri && titlebar.visible}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="titlebar titlebar--{titlebar.mode}"
		data-tauri-drag-region
		style="--tb-h: {barHeight}px; --tb-dot: {dotSize}px; --tb-dot-gap: {dotGap}px; --tb-win-btn: {winBtnWidth}px;"
		onmouseenter={() => (hovered = true)}
		onmouseleave={() => (hovered = false)}
	>
		{#if titlebar.mode === "macos"}
			<!-- macOS: traffic lights left, title center -->
			<div class="titlebar__controls titlebar__controls--macos">
				<button
					class="traffic-light traffic-light--close"
					onclick={close}
					title="Close"
					aria-label="Close"
				>
					<span class="traffic-light__icon">
						<X size={8} strokeWidth={2.5} />
					</span>
				</button>
				<button
					class="traffic-light traffic-light--minimize"
					onclick={minimize}
					title="Minimize"
					aria-label="Minimize"
				>
					<span class="traffic-light__icon">
						<Minus size={8} strokeWidth={2.5} />
					</span>
				</button>
				<button
					class="traffic-light traffic-light--maximize"
					onclick={toggleMaximize}
					title={maximized ? "Restore" : "Maximize"}
					aria-label={maximized ? "Restore" : "Maximize"}
				>
					<span class="traffic-light__icon">
						{#if maximized}
							<Copy size={7} strokeWidth={2.5} />
						{:else}
							<Square size={7} strokeWidth={2.5} />
						{/if}
					</span>
				</button>
			</div>

			<span class="titlebar__title" data-tauri-drag-region>SIGNET</span>

			<div class="titlebar__spacer">
				<button
					class="titlebar__mode-btn"
					onclick={cycleMode}
					title="Window style: {modeLabel[titlebar.mode]}"
					aria-label="Toggle window style"
				>
					<ModeIcon size={12} />
				</button>
			</div>
		{:else}
			<!-- Windows: title left, controls right -->
			<div class="titlebar__left">
				<button
					class="titlebar__mode-btn"
					onclick={cycleMode}
					title="Window style: {modeLabel[titlebar.mode]}"
					aria-label="Toggle window style"
				>
					<ModeIcon size={12} />
				</button>
				<span class="titlebar__title" data-tauri-drag-region>SIGNET</span>
			</div>

			<div class="titlebar__controls titlebar__controls--windows">
				<button
					class="win-btn win-btn--minimize"
					onclick={minimize}
					title="Minimize"
					aria-label="Minimize"
				>
					<Minus size={14} strokeWidth={1.5} />
				</button>
				<button
					class="win-btn win-btn--maximize"
					onclick={toggleMaximize}
					title={maximized ? "Restore" : "Maximize"}
					aria-label={maximized ? "Restore" : "Maximize"}
				>
					{#if maximized}
						<Copy size={12} strokeWidth={1.5} />
					{:else}
						<Square size={12} strokeWidth={1.5} />
					{/if}
				</button>
				<button
					class="win-btn win-btn--close"
					onclick={close}
					title="Close"
					aria-label="Close"
				>
					<X size={14} strokeWidth={1.5} />
				</button>
			</div>
		{/if}
	</div>
{/if}

<style>
	/* ── Platform color tokens (intentionally platform-specific, not theme tokens) ──
	   macOS traffic lights use the exact system colors for authentic look.
	   Windows close hover uses the system red. These are not interchangeable
	   with --sig-danger or --sig-success which carry semantic UI meaning. */
	:root {
		--tb-mac-close: #ff5f57;
		--tb-mac-minimize: #febc2e;
		--tb-mac-maximize: #28c840;
		--tb-win-close-bg: #c42b1c;
		--tb-win-close-fg: #fff;
	}

	/* ── Drag strip for "none" mode — keeps window movable when titlebar is hidden ── */
	.titlebar__drag-strip {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: 8px;
		z-index: 9999;
	}

	/* ── Shared titlebar ── */
	.titlebar {
		display: flex;
		align-items: center;
		height: var(--tb-h);
		width: 100%;
		background: var(--sig-surface);
		border-bottom: 1px solid var(--sig-border);
		user-select: none;
		-webkit-user-select: none;
		flex-shrink: 0;
		z-index: 9999;
		font-family: var(--font-mono);
	}

	.titlebar__title {
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
		pointer-events: none;
	}

	.titlebar__mode-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border: none;
		background: transparent;
		color: var(--sig-text-muted);
		border-radius: 4px;
		cursor: pointer;
		transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
	}

	.titlebar__mode-btn:hover {
		background: var(--sig-surface-raised);
		color: var(--sig-text-bright);
	}

	/* ── macOS traffic lights ── */
	.titlebar--macos {
		justify-content: space-between;
		padding: 0 12px;
	}

	.titlebar--macos .titlebar__title {
		position: absolute;
		left: 50%;
		transform: translateX(-50%);
	}

	.titlebar__spacer {
		display: flex;
		align-items: center;
		width: 80px;
		justify-content: flex-end;
	}

	.titlebar__controls--macos {
		display: flex;
		align-items: center;
		gap: var(--tb-dot-gap);
	}

	.traffic-light {
		width: var(--tb-dot);
		height: var(--tb-dot);
		border-radius: 50%;
		border: none;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: filter var(--dur) var(--ease);
		position: relative;
	}

	.traffic-light__icon {
		display: flex;
		align-items: center;
		justify-content: center;
		opacity: 0;
		color: rgba(0, 0, 0, 0.6);
		transition: opacity var(--dur) var(--ease);
	}

	.titlebar:hover .traffic-light__icon {
		opacity: 1;
	}

	.traffic-light--close {
		background: var(--tb-mac-close);
	}
	.traffic-light--close:hover {
		filter: brightness(1.1);
	}

	.traffic-light--minimize {
		background: var(--tb-mac-minimize);
	}
	.traffic-light--minimize:hover {
		filter: brightness(1.1);
	}

	.traffic-light--maximize {
		background: var(--tb-mac-maximize);
	}
	.traffic-light--maximize:hover {
		filter: brightness(1.1);
	}

	/* Unfocused state — all grey */
	.titlebar--macos:not(:hover) .traffic-light--close,
	.titlebar--macos:not(:hover) .traffic-light--minimize,
	.titlebar--macos:not(:hover) .traffic-light--maximize {
		background: var(--sig-text-muted);
		opacity: 0.4;
	}

	/* ── Windows controls ── */
	.titlebar--windows {
		justify-content: space-between;
		padding: 0 0 0 8px;
	}

	.titlebar__left {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.titlebar__controls--windows {
		display: flex;
		align-items: stretch;
		height: 100%;
	}

	.win-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: var(--tb-win-btn);
		height: 100%;
		border: none;
		background: transparent;
		color: var(--sig-text-muted);
		cursor: pointer;
		transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
	}

	.win-btn:hover {
		background: var(--sig-surface-raised);
		color: var(--sig-text-bright);
	}

	.win-btn--close:hover {
		background: var(--tb-win-close-bg);
		color: var(--tb-win-close-fg);
	}
</style>
