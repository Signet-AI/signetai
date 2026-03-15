/**
 * signet browse — CDP bridge
 *
 * Attaches to an existing Chrome instance via Chrome DevTools Protocol (CDP).
 * Supports: navigate, extract, watch, and agent-piloted task modes.
 *
 * Phase 1a implementation (Buba)
 */

import { Command } from "commander";
import chalk from "chalk";

// ============================================================================
// Types
// ============================================================================

const CDP_DEFAULT_PORT = 9222;
const DOM_CHANGE_THROTTLE_MS = 2000;
const DOM_CHANGE_MIN_DIFF_CHARS = 100;

interface CDPTab {
	id: string;
	title: string;
	url: string;
	webSocketDebuggerUrl?: string;
	type: string;
	description?: string;
}

interface CDPMessage {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code: number; message: string };
}

type EventListener = (params: Record<string, unknown>) => void;

// ============================================================================
// SignetOSEvent — matches the event bus envelope from the spec
// ============================================================================

interface BrowserNavigatePayload {
	url: string;
	title: string;
	tabId: string;
	timestamp: number;
}

interface BrowserFormField {
	name: string;
	type: string;
	label?: string;
}

interface BrowserFormPayload {
	fields: BrowserFormField[];
	action: string;
	tabId: string;
	timestamp: number;
}

interface BrowserDomChangePayload {
	diff: string;
	tabId: string;
	timestamp: number;
}

interface BrowserExtractPayload {
	data: unknown;
	source: string;
	tabId: string;
	timestamp: number;
}

interface BrowserCheckoutPayload {
	items?: string[];
	total?: number;
	tabId: string;
	timestamp: number;
}

interface BrowserLoginPayload {
	domain: string;
	tabId: string;
	timestamp: number;
}

type BrowserEventPayload =
	| BrowserNavigatePayload
	| BrowserFormPayload
	| BrowserDomChangePayload
	| BrowserExtractPayload
	| BrowserCheckoutPayload
	| BrowserLoginPayload;

interface SignetOSEvent {
	id: string;
	source: string;
	type: string;
	timestamp: number;
	payload: BrowserEventPayload;
}

function makeEventId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Event Transport Abstraction ─────────────────────────────────────────────
// Default: stdout. Phase 3 (event bus) swaps this to EventEmitter/Redis
// without touching any of the emit callsites.
type EventTransport = (event: SignetOSEvent) => void;

let activeTransport: EventTransport = (event) => {
	process.stdout.write(JSON.stringify(event) + "\n");
};

/** Replace the default stdout transport (Phase 3 hook point) */
export function setEventTransport(transport: EventTransport): void {
	activeTransport = transport;
}

function emitEvent(type: string, payload: BrowserEventPayload) {
	const event: SignetOSEvent = {
		id: makeEventId(),
		source: "browser",
		type,
		timestamp: Date.now(),
		payload,
	};
	activeTransport(event);
}

// ============================================================================
// CDP Client — minimal WebSocket-based client
// ============================================================================

class CDPClient {
	private ws: WebSocket | null = null;
	private commandId = 0;
	private pendingCommands = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	private eventListeners = new Map<string, EventListener[]>();
	private connectResolve: (() => void) | null = null;
	private connectReject: ((e: Error) => void) | null = null;
	private closed = false;
	private reconnectAttempts = 0;
	private maxReconnectAttempts = 5;
	private onReconnect: (() => Promise<void>) | null = null;

	constructor(private wsUrl: string) {}

	/** Set a callback to re-enable CDP domains after reconnect */
	setOnReconnect(cb: () => Promise<void>): void {
		this.onReconnect = cb;
	}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.connectResolve = resolve;
			this.connectReject = reject;
			this.closed = false;

			// WebSocket is available natively in Bun and Node.js ≥ 21.
			// The build target is Node ≥ 18, but the runtime (bun/node 22) supports it.
			// biome-ignore lint/suspicious/noExplicitAny: native global in bun/node22
			const WS = (globalThis as any).WebSocket;
			if (!WS) {
				reject(
					new Error(
						"WebSocket is not available in this runtime. " +
							"Run with Bun or Node.js ≥ 21.",
					),
				);
				return;
			}

			this.ws = new WS(this.wsUrl) as WebSocket;

			this.ws.onopen = () => {
				this.reconnectAttempts = 0; // Reset on successful connect
				this.connectResolve?.();
				this.connectResolve = null;
				this.connectReject = null;
			};

			this.ws.onerror = (evt: Event) => {
				const err = new Error(`CDP WebSocket error: ${this.wsUrl}`);
				if (this.connectReject) {
					this.connectReject(err);
					this.connectResolve = null;
					this.connectReject = null;
				}
				// Reject all pending commands
				for (const [, { reject: rej }] of this.pendingCommands) {
					rej(err);
				}
				this.pendingCommands.clear();
			};

			this.ws.onclose = () => {
				const err = new Error("CDP WebSocket closed unexpectedly");
				for (const [, { reject: rej }] of this.pendingCommands) {
					rej(err);
				}
				this.pendingCommands.clear();

				// Attempt reconnect with exponential backoff (unless intentionally closed)
				if (!this.closed && this.reconnectAttempts < this.maxReconnectAttempts) {
					this.reconnectAttempts++;
					const delayMs = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 16000);
					console.error(
						chalk.yellow(
							`  CDP connection lost. Reconnecting in ${delayMs}ms ` +
								`(attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`,
						),
					);
					setTimeout(async () => {
						try {
							await this.connect();
							console.error(chalk.green("  ✓ CDP reconnected."));
							// Re-enable CDP domains after reconnect
							if (this.onReconnect) {
								await this.onReconnect();
							}
						} catch {
							console.error(chalk.red("  CDP reconnect failed."));
						}
					}, delayMs);
				}
			};

			this.ws.onmessage = (evt: MessageEvent) => {
				let msg: CDPMessage;
				try {
					msg = JSON.parse(evt.data as string) as CDPMessage;
				} catch {
					return;
				}

				// Command response
				if (typeof msg.id === "number") {
					const pending = this.pendingCommands.get(msg.id);
					if (pending) {
						this.pendingCommands.delete(msg.id);
						if (msg.error) {
							pending.reject(new Error(msg.error.message));
						} else {
							pending.resolve(msg.result);
						}
					}
					return;
				}

				// Event
				if (msg.method) {
					const listeners = this.eventListeners.get(msg.method) ?? [];
					for (const listener of listeners) {
						try {
							listener((msg.params ?? {}) as Record<string, unknown>);
						} catch {
							// Swallow listener errors
						}
					}
				}
			};
		});
	}

	send(method: string, params?: Record<string, unknown>): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.ws || this.ws.readyState !== 1 /* OPEN */) {
				reject(new Error("CDP WebSocket is not connected"));
				return;
			}

			const id = ++this.commandId;
			this.pendingCommands.set(id, { resolve, reject });
			this.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
		});
	}

	on(event: string, callback: EventListener): void {
		const existing = this.eventListeners.get(event) ?? [];
		this.eventListeners.set(event, [...existing, callback]);
	}

	off(event: string, callback: EventListener): void {
		const existing = this.eventListeners.get(event) ?? [];
		this.eventListeners.set(
			event,
			existing.filter((l) => l !== callback),
		);
	}

	close(): void {
		this.closed = true;
		this.ws?.close();
		this.ws = null;
	}

	get isConnected(): boolean {
		return this.ws !== null && this.ws.readyState === 1;
	}
}

// ============================================================================
// Helpers
// ============================================================================

async function getCDPTabs(port: number): Promise<CDPTab[]> {
	let resp: Response;
	try {
		resp = await fetch(`http://localhost:${port}/json`, {
			signal: AbortSignal.timeout(3000),
		});
	} catch (err) {
		throw new Error(
			`Cannot reach Chrome CDP on port ${port}. ` +
				`Start Chrome with: google-chrome --remote-debugging-port=${port}\n` +
				`  (${(err as Error).message})`,
		);
	}
	if (!resp.ok) {
		throw new Error(`CDP HTTP ${resp.status} from localhost:${port}`);
	}
	return resp.json() as Promise<CDPTab[]>;
}

async function getActiveCDPTab(port: number): Promise<CDPTab> {
	const tabs = await getCDPTabs(port);
	const pageTabs = tabs.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
	if (pageTabs.length === 0) {
		throw new Error("No page tabs found with a WebSocket debugger URL.");
	}
	// Return the first page tab (most recently focused, per Chrome ordering)
	return pageTabs[0];
}

async function connectToTab(tab: CDPTab): Promise<CDPClient> {
	if (!tab.webSocketDebuggerUrl) {
		throw new Error(`Tab "${tab.title}" has no WebSocket debugger URL`);
	}
	const client = new CDPClient(tab.webSocketDebuggerUrl);
	await client.connect();
	return client;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Very simple diff: returns a summary string describing content change */
function simpleTextDiff(before: string, after: string): string {
	if (before === after) return "";
	const lenDiff = Math.abs(after.length - before.length);
	if (lenDiff < DOM_CHANGE_MIN_DIFF_CHARS) return "";
	// Return a short excerpt of added/changed content
	const preview = after.slice(0, 200).replace(/\s+/g, " ").trim();
	return `[Δ${lenDiff > 0 ? "+" : ""}${after.length - before.length} chars] ${preview}`;
}

/** Extract domain from URL */
function getDomain(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

// ============================================================================
// signet browse navigate <url>
// ============================================================================

async function cmdNavigate(
	url: string,
	opts: { port: number; passive: boolean },
): Promise<void> {
	if (opts.passive) {
		console.error(chalk.yellow("  --passive mode: cannot navigate (read-only). Use --active."));
		process.exit(1);
	}

	const tab = await getActiveCDPTab(opts.port);
	const client = await connectToTab(tab);

	try {
		await client.send("Page.enable");
		console.log(chalk.dim(`  Navigating to ${url}...`));

		let loadResolve: (() => void) | null = null;
		const loadPromise = new Promise<void>((res) => {
			loadResolve = res;
		});

		client.on("Page.loadEventFired", () => {
			loadResolve?.();
		});

		await client.send("Page.navigate", { url });
		await Promise.race([loadPromise, sleep(10000)]);

		// Get final URL and title
		const { result: urlResult } = (await client.send("Runtime.evaluate", {
			expression: "location.href",
			returnByValue: true,
		})) as { result: { value: string } };

		const { result: titleResult } = (await client.send("Runtime.evaluate", {
			expression: "document.title",
			returnByValue: true,
		})) as { result: { value: string } };

		console.log(chalk.green(`  ✓ Navigated to ${urlResult?.value ?? url}`));
		console.log(chalk.dim(`    Title: ${titleResult?.value ?? "(unknown)"}`));
	} finally {
		client.close();
	}
}

// ============================================================================
// signet browse extract "what to extract"
// ============================================================================

const EXTRACT_SCRIPT = (query: string) => `
(() => {
  const q = ${JSON.stringify(query)}.toLowerCase();

  // Helper: get all text content of an element
  const text = (el) => (el?.textContent ?? "").trim().replace(/\\s+/g, " ");

  // 1. Pricing / prices
  if (q.includes("price") || q.includes("cost") || q.includes("pric")) {
    const prices = [];
    document.querySelectorAll("[class*=price],[class*=cost],[class*=amount],[data-price]").forEach(el => {
      const t = text(el);
      if (t && t.length < 100) prices.push(t);
    });
    // Also grab things that look like dollar/euro amounts
    const allText = document.body.innerText;
    const matches = allText.match(/[€$£¥][\\d,]+\\.?\\d*/g) ?? [];
    return { type: "prices", query: q, items: [...new Set([...prices, ...matches])] };
  }

  // 2. Links
  if (q.includes("link") || q.includes("url") || q.includes("href")) {
    const links = [];
    document.querySelectorAll("a[href]").forEach(el => {
      const href = el.getAttribute("href");
      if (href && !href.startsWith("#") && !href.startsWith("javascript")) {
        const abs = new URL(href, location.href).href;
        links.push({ text: text(el), href: abs });
      }
    });
    return { type: "links", query: q, items: links.slice(0, 50) };
  }

  // 3. Forms / inputs
  if (q.includes("form") || q.includes("input") || q.includes("field")) {
    const forms = [];
    document.querySelectorAll("form").forEach(form => {
      const inputs = [];
      form.querySelectorAll("input,select,textarea").forEach(inp => {
        const label = inp.getAttribute("placeholder") ||
          inp.getAttribute("aria-label") ||
          inp.getAttribute("name") ||
          inp.getAttribute("id") || "unknown";
        inputs.push({ label, type: inp.tagName.toLowerCase() + (inp.type ? ':' + inp.type : '') });
      });
      forms.push({ action: form.action || location.href, method: form.method, inputs });
    });
    return { type: "forms", query: q, items: forms };
  }

  // 4. Images
  if (q.includes("image") || q.includes("img") || q.includes("photo") || q.includes("picture")) {
    const images = [];
    document.querySelectorAll("img[src]").forEach(el => {
      const src = new URL(el.getAttribute("src"), location.href).href;
      images.push({ src, alt: el.getAttribute("alt") ?? "", width: el.naturalWidth, height: el.naturalHeight });
    });
    return { type: "images", query: q, items: images.slice(0, 30) };
  }

  // 5. Headings / structure
  if (q.includes("heading") || q.includes("title") || q.includes("structure") || q.includes("section")) {
    const headings = [];
    document.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach(el => {
      headings.push({ tag: el.tagName.toLowerCase(), text: text(el) });
    });
    return { type: "headings", query: q, items: headings };
  }

  // 6. Table data
  if (q.includes("table") || q.includes("row") || q.includes("column") || q.includes("data")) {
    const tables = [];
    document.querySelectorAll("table").forEach(table => {
      const rows = [];
      table.querySelectorAll("tr").forEach(row => {
        const cells = [];
        row.querySelectorAll("td,th").forEach(cell => cells.push(text(cell)));
        if (cells.length) rows.push(cells);
      });
      if (rows.length) tables.push(rows);
    });
    return { type: "tables", query: q, items: tables };
  }

  // 7. Generic text / content fallback
  const paragraphs = [];
  document.querySelectorAll("p,li,article,section,main").forEach(el => {
    const t = text(el);
    if (t && t.length > 30 && t.length < 2000) paragraphs.push(t);
  });
  return { type: "text", query: q, items: [...new Set(paragraphs)].slice(0, 30), url: location.href, title: document.title };
})()
`;

async function cmdExtract(
	query: string,
	opts: { port: number },
): Promise<void> {
	const tab = await getActiveCDPTab(opts.port);
	const client = await connectToTab(tab);

	try {
		const evalResult = (await client.send("Runtime.evaluate", {
			expression: EXTRACT_SCRIPT(query),
			returnByValue: true,
			awaitPromise: false,
		})) as { result: { value: unknown; type: string }; exceptionDetails?: unknown };

		if (evalResult.exceptionDetails) {
			console.error(chalk.red("  Extract script threw an exception."));
			process.exit(1);
		}

		const data = evalResult.result?.value;

		// Emit as a browser.extract event
		emitEvent("browser.extract", {
			data,
			source: tab.url,
			tabId: tab.id,
			timestamp: Date.now(),
		});
	} finally {
		client.close();
	}
}

// ============================================================================
// signet browse watch
// ============================================================================

/** Detect checkout page heuristics */
function detectCheckout(url: string, title: string, body: string): boolean {
	const s = `${url} ${title} ${body}`.toLowerCase();
	return (
		s.includes("checkout") ||
		s.includes("cart") ||
		s.includes("payment") ||
		s.includes("billing") ||
		s.includes("order summary")
	);
}

/** Detect login page heuristics */
function detectLogin(url: string, title: string, body: string): boolean {
	const s = `${url} ${title}`.toLowerCase();
	return (
		s.includes("login") ||
		s.includes("sign in") ||
		s.includes("signin") ||
		s.includes("log in") ||
		s.includes("authenticate")
	);
}

// ── Form detection JS expression (injected into pages) ──────────────────────
const FORM_DETECT_EXPRESSION = `(() => {
	const forms = [];
	document.querySelectorAll("form").forEach(form => {
		const fields = [];
		form.querySelectorAll("input,select,textarea").forEach(inp => {
			const name = inp.getAttribute("name") || inp.getAttribute("id") || "unknown";
			const type = inp.tagName.toLowerCase() === "select" ? "select"
				: inp.tagName.toLowerCase() === "textarea" ? "textarea"
				: (inp.getAttribute("type") || "text");
			const label = inp.getAttribute("aria-label")
				|| inp.getAttribute("placeholder")
				|| (() => {
					const id = inp.getAttribute("id");
					if (id) {
						const lbl = document.querySelector("label[for='" + id + "']");
						if (lbl) return lbl.textContent?.trim();
					}
					return undefined;
				})()
				|| undefined;
			fields.push({ name, type, ...(label ? { label } : {}) });
		});
		if (fields.length > 0) forms.push({ fields, action: form.action || location.href });
	});
	return forms;
})()`;

// ── Checkout extraction JS expression ────────────────────────────────────────
const CHECKOUT_EXTRACT_EXPRESSION = `(() => {
	const items = [];
	document.querySelectorAll("[class*=item],[class*=product],[class*=cart-line]").forEach(el => {
		const t = (el.textContent ?? "").trim().replace(/\\s+/g, " ");
		if (t && t.length < 200) items.push(t);
	});
	const totalEl = document.querySelector("[class*=total],[class*=grand-total],[data-total]");
	const totalText = totalEl?.textContent?.trim() ?? null;
	const totalMatch = totalText?.match(/[€$£¥][\\d,]+\\.?\\d*/);
	return { items: [...new Set(items)].slice(0, 20), total: totalMatch ? parseFloat(totalMatch[0].replace(/[^\\d.]/g, "")) : null };
})()`;

// ── Tab state type ───────────────────────────────────────────────────────────
interface TabWatchState {
	lastDomChangeAt: number;
	lastBodyText: string;
	title: string;
	url: string;
}

/**
 * Wire all event handlers for a watched tab.
 * Single source of truth — used for both initial tabs and dynamically discovered ones.
 */
function wireTabEventHandlers(
	client: CDPClient,
	tabId: string,
	tabState: Map<string, TabWatchState>,
): void {
	// ── browser.navigate ────────────────────────────────────────────────
	client.on("Page.frameNavigated", async (params) => {
		const frame = params.frame as Record<string, unknown> | undefined;
		if (!frame || frame.parentId) return; // Only top-level frame

		const url = (frame.url as string) ?? "";
		const state = tabState.get(tabId);
		if (state) state.url = url;

		// Resolve title via Runtime.evaluate — frame.name is almost always empty
		let title = "";
		try {
			const { result: titleResult } = (await client.send("Runtime.evaluate", {
				expression: "document.title",
				returnByValue: true,
			})) as { result: { value: string } };
			title = titleResult?.value ?? "";
			if (state) state.title = title;
		} catch {
			// Page might not be ready yet — title will be updated on loadEventFired
		}

		emitEvent("browser.navigate", { url, title, tabId, timestamp: Date.now() });
	});

	// ── Page load: title update + form/checkout/login detection ──────────
	client.on("Page.loadEventFired", async () => {
		const state = tabState.get(tabId);
		if (!state) return;

		try {
			// Update title
			const { result: titleResult } = (await client.send("Runtime.evaluate", {
				expression: "document.title",
				returnByValue: true,
			})) as { result: { value: string } };
			if (titleResult?.value) state.title = titleResult.value;

			// Detect forms — emit rich field objects per spec
			const { result: formsResult } = (await client.send("Runtime.evaluate", {
				expression: FORM_DETECT_EXPRESSION,
				returnByValue: true,
			})) as { result: { value: Array<{ fields: BrowserFormField[]; action: string }> } };

			for (const form of formsResult?.value ?? []) {
				emitEvent("browser.form", {
					fields: form.fields,
					action: form.action,
					tabId,
					timestamp: Date.now(),
				});
			}

			// Detect checkout / login pages
			const body = ((
				await client.send("Runtime.evaluate", {
					expression: "document.body?.innerText?.slice(0, 1000) ?? ''",
					returnByValue: true,
				}).catch(() => ({ result: { value: "" } }))
			) as { result: { value: string } }).result?.value ?? "";

			if (detectCheckout(state.url, state.title, body)) {
				const { result: checkoutResult } = (await client.send("Runtime.evaluate", {
					expression: CHECKOUT_EXTRACT_EXPRESSION,
					returnByValue: true,
				}).catch(() => ({ result: { value: { items: [], total: null } } }))) as {
					result: { value: { items: string[]; total: number | null } };
				};

				emitEvent("browser.checkout", {
					items: checkoutResult?.value?.items,
					total: checkoutResult?.value?.total ?? undefined,
					tabId,
					timestamp: Date.now(),
				});
			}

			if (detectLogin(state.url, state.title, body)) {
				emitEvent("browser.login", {
					domain: getDomain(state.url),
					tabId,
					timestamp: Date.now(),
				});
			}
		} catch {
			// Best-effort
		}
	});

	// ── browser.dom.change (throttled) ───────────────────────────────────
	client.on("DOM.documentUpdated", async () => {
		const state = tabState.get(tabId);
		if (!state) return;

		const now = Date.now();
		if (now - state.lastDomChangeAt < DOM_CHANGE_THROTTLE_MS) return;

		try {
			const { result: bodyResult } = (await client.send("Runtime.evaluate", {
				expression: "document.body?.innerText?.slice(0, 5000) ?? ''",
				returnByValue: true,
			})) as { result: { value: string } };

			const newBody = bodyResult?.value ?? "";
			const diff = simpleTextDiff(state.lastBodyText, newBody);
			if (!diff) return;

			state.lastBodyText = newBody;
			state.lastDomChangeAt = now;

			emitEvent("browser.dom.change", { diff, tabId, timestamp: now });
		} catch {
			// Best-effort
		}
	});
}

/** Enable CDP domains on a client and set up reconnect handler */
async function enableCDPDomains(client: CDPClient): Promise<void> {
	await Promise.all([
		client.send("Page.enable").catch(() => {}),
		client.send("DOM.enable").catch(() => {}),
		client.send("Runtime.enable").catch(() => {}),
	]);
	client.setOnReconnect(async () => {
		await Promise.all([
			client.send("Page.enable").catch(() => {}),
			client.send("DOM.enable").catch(() => {}),
			client.send("Runtime.enable").catch(() => {}),
		]);
	});
}

async function cmdWatch(opts: { port: number; passive: boolean }): Promise<void> {
	console.error(
		chalk.dim(
			`  Attaching to Chrome CDP on port ${opts.port}...` +
				(opts.passive ? " (passive)" : " (active)"),
		),
	);

	const tabs = await getCDPTabs(opts.port);
	const pageTabs = tabs.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);

	if (pageTabs.length === 0) {
		console.error(chalk.red("  No page tabs found. Is Chrome running with --remote-debugging-port?"));
		process.exit(1);
	}

	const tabState = new Map<string, TabWatchState>();
	const clients: CDPClient[] = [];
	const attachedTabIds = new Set<string>();

	// Attach to all existing page tabs
	for (const tab of pageTabs) {
		if (!tab.webSocketDebuggerUrl) continue;

		let client: CDPClient;
		try {
			client = await connectToTab(tab);
		} catch (err) {
			console.error(chalk.yellow(`  Skipping tab "${tab.title}": ${(err as Error).message}`));
			continue;
		}

		clients.push(client);
		attachedTabIds.add(tab.id);

		tabState.set(tab.id, {
			lastDomChangeAt: 0,
			lastBodyText: "",
			title: tab.title,
			url: tab.url,
		});

		await enableCDPDomains(client);
		wireTabEventHandlers(client, tab.id, tabState);
	}

	if (clients.length === 0) {
		console.error(chalk.red("  Could not attach to any Chrome tabs."));
		process.exit(1);
	}

	console.error(
		chalk.green(`  ✓ Watching ${clients.length} tab(s). Streaming events to stdout.`),
	);
	console.error(chalk.dim("  Press Ctrl+C to stop.\n"));

	// Poll for new tabs every 5 seconds
	const TAB_POLL_INTERVAL_MS = 5000;
	const tabPollTimer = setInterval(async () => {
		try {
			const currentTabs = await getCDPTabs(opts.port);
			const newPageTabs = currentTabs.filter(
				(t) => t.type === "page" && t.webSocketDebuggerUrl && !attachedTabIds.has(t.id),
			);

			for (const tab of newPageTabs) {
				if (!tab.webSocketDebuggerUrl) continue;
				try {
					const client = await connectToTab(tab);
					clients.push(client);
					attachedTabIds.add(tab.id);

					tabState.set(tab.id, {
						lastDomChangeAt: 0,
						lastBodyText: "",
						title: tab.title,
						url: tab.url,
					});

					await enableCDPDomains(client);
					wireTabEventHandlers(client, tab.id, tabState);

					console.error(chalk.green(`  ✓ New tab attached: "${tab.title}" (${tab.id})`));
				} catch {
					// Failed to attach — skip, retry next poll
				}
			}
		} catch {
			// Tab poll failed — Chrome might be busy, retry next interval
		}
	}, TAB_POLL_INTERVAL_MS);

	// Keep process alive until SIGINT
	await new Promise<void>((resolve) => {
		process.on("SIGINT", () => {
			clearInterval(tabPollTimer);
			for (const c of clients) {
				try { c.close(); } catch {}
			}
			resolve();
		});
	});
}

// ============================================================================
// signet browse "<task>" — agent-piloted mode
// ============================================================================

async function cmdTask(
	task: string,
	opts: { port: number; passive: boolean },
): Promise<void> {
	// CDP attach & context snapshot — LLM integration is Phase 3
	const tab = await getActiveCDPTab(opts.port);
	const client = await connectToTab(tab);

	try {
		await client.send("Page.enable");
		await client.send("Runtime.enable");

		const { result: titleResult } = (await client.send("Runtime.evaluate", {
			expression: "document.title",
			returnByValue: true,
		})) as { result: { value: string } };

		const { result: urlResult } = (await client.send("Runtime.evaluate", {
			expression: "location.href",
			returnByValue: true,
		})) as { result: { value: string } };

		const { result: bodyResult } = (await client.send("Runtime.evaluate", {
			expression: "document.body?.innerText?.slice(0, 2000) ?? ''",
			returnByValue: true,
		})) as { result: { value: string } };

		const title = titleResult?.value ?? "(unknown)";
		const url = urlResult?.value ?? tab.url;
		const body = bodyResult?.value ?? "";

		console.log(chalk.bold(`\n  Task: ${task}`));
		console.log(chalk.dim(`  Mode: ${opts.passive ? "passive (observe only)" : "active (agent drives)"}`));
		console.log();
		console.log(chalk.cyan("  Current Context:"));
		console.log(chalk.dim(`    URL:   ${url}`));
		console.log(chalk.dim(`    Title: ${title}`));
		if (body) {
			console.log(chalk.dim(`    Body:  ${body.slice(0, 300).replace(/\n/g, " ")}...`));
		}
		console.log();

		if (opts.passive) {
			console.log(
				chalk.yellow(
					"  --passive mode: context captured. Agent observation only.\n" +
						"  (LLM-driven task execution requires --active and Phase 3 integration.)",
				),
			);
		} else {
			console.log(
				chalk.yellow(
					"  --active mode: CDP bridge ready.\n" +
						"  Full LLM-driven task execution lands in Phase 3 (event bus integration).\n" +
						"  For now: context is captured and available for agent use.",
				),
			);
		}

		// Emit the context as an extract event so it's on the event bus
		emitEvent("browser.extract", {
			data: { task, title, url, bodyPreview: body.slice(0, 500), mode: opts.passive ? "passive" : "active" },
			source: url,
			tabId: tab.id,
			timestamp: Date.now(),
		});
	} finally {
		client.close();
	}
}

// ============================================================================
// Commander command builder
// ============================================================================

export function registerBrowseCommand(program: Command): void {
	const browseCmd = program
		.command("browse")
		.description("CDP browser bridge — pilot, observe, and extract from Chrome")
		.option("-p, --port <port>", "Chrome CDP debug port", String(CDP_DEFAULT_PORT))
		.option("--passive", "Observe only — never click or navigate (default)", false)
		.option("--active", "Agent drives — allows navigation and interaction", false)
		.addHelpText(
			"after",
			`
Examples:
  signet browse "find cheapest flight to NYC"   # agent pilots (active mode)
  signet browse navigate https://example.com    # direct navigation
  signet browse extract "all pricing tiers"     # structured pull from current tab
  signet browse watch                           # stream page events to stdout
		`,
		);

	// signet browse navigate <url>
	browseCmd
		.command("navigate <url>")
		.description("Navigate the active Chrome tab to a URL")
		.action(async (url: string) => {
			const opts = browseCmd.opts() as { port: string; passive: boolean; active: boolean };
			const port = Number.parseInt(opts.port, 10) || CDP_DEFAULT_PORT;
			const passive = opts.passive || !opts.active; // default passive
			try {
				await cmdNavigate(url, { port, passive });
			} catch (err) {
				console.error(chalk.red(`  Error: ${(err as Error).message}`));
				process.exit(1);
			}
		});

	// signet browse extract "<query>"
	browseCmd
		.command("extract <query>")
		.description("Extract structured data from the active tab")
		.action(async (query: string) => {
			const opts = browseCmd.opts() as { port: string };
			const port = Number.parseInt(opts.port, 10) || CDP_DEFAULT_PORT;
			try {
				await cmdExtract(query, { port });
			} catch (err) {
				console.error(chalk.red(`  Error: ${(err as Error).message}`));
				process.exit(1);
			}
		});

	// signet browse watch
	browseCmd
		.command("watch")
		.description("Stream page events as JSON to stdout (navigate, form, dom.change, checkout, login)")
		.action(async () => {
			const opts = browseCmd.opts() as { port: string; passive: boolean; active: boolean };
			const port = Number.parseInt(opts.port, 10) || CDP_DEFAULT_PORT;
			const passive = !opts.active;
			try {
				await cmdWatch({ port, passive });
			} catch (err) {
				console.error(chalk.red(`  Error: ${(err as Error).message}`));
				process.exit(1);
			}
		});

	// signet browse "<task>" — agent-piloted (default action / positional arg)
	browseCmd.argument("[task]", "Natural language task for the agent to execute in Chrome").action(
		async (task: string | undefined) => {
			if (!task) {
				browseCmd.help();
				return;
			}

			const opts = browseCmd.opts() as { port: string; passive: boolean; active: boolean };
			const port = Number.parseInt(opts.port, 10) || CDP_DEFAULT_PORT;
			const passive = opts.passive || !opts.active;

			try {
				await cmdTask(task, { port, passive });
			} catch (err) {
				console.error(chalk.red(`  Error: ${(err as Error).message}`));
				process.exit(1);
			}
		},
	);
}
