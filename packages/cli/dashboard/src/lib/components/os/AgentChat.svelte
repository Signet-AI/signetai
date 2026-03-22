<script lang="ts">
	import { tick } from "svelte";
	import Send from "@lucide/svelte/icons/send";
	import Bot from "@lucide/svelte/icons/bot";
	import User from "@lucide/svelte/icons/user";
	import Wrench from "@lucide/svelte/icons/wrench";
	import ExternalLink from "@lucide/svelte/icons/external-link";
	import Cpu from "@lucide/svelte/icons/cpu";
	import { API_BASE } from "$lib/api";
	import { os, moveToGrid, fetchWidgetHtml, fetchTrayEntries, sendWidgetAction, getWidgetSandbox, setAgentSession } from "$lib/stores/os.svelte";

	interface ToolCall {
		tool: string;
		server: string;
		result?: unknown;
		error?: string;
	}

	interface ChatMessage {
		role: "user" | "agent";
		content: string;
		timestamp: number;
		toolCalls?: ToolCall[];
		openedWidget?: string;  // server ID of widget that was opened
	}

	let messages = $state<ChatMessage[]>([]);
	let input = $state("");
	let loading = $state(false);
	let loadingStatus = $state("");
	let chatEl: HTMLDivElement | null = $state(null);
	const AGENT_EXEC_TIMEOUT_MS = 30_000;

	async function scrollToBottom() {
		await tick();
		if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
	}

	/**
	 * Place a widget on the grid and load its HTML.
	 * Returns true if the widget was placed/already on grid.
	 */
	async function openWidgetForServer(serverId: string): Promise<boolean> {
		const entry = os.entries.find((e) => e.id === serverId);
		if (!entry) {
			// Refresh tray entries in case the server was just installed
			await fetchTrayEntries();
			const refreshed = os.entries.find((e) => e.id === serverId);
			if (!refreshed) return false;
		}

		const target = os.entries.find((e) => e.id === serverId);
		if (!target) return false;

		// Move to grid if not already there
		if (target.state !== "grid") {
			await moveToGrid(serverId);
		}

		// Ensure widget HTML is loaded
		await fetchWidgetHtml(serverId);

		// Highlight the widget briefly
		highlightWidget(serverId);

		return true;
	}

	/** Flash a highlight border on a widget to draw attention */
	function highlightWidget(serverId: string): void {
		const gridItems = document.querySelectorAll('.grid-item');
		for (const item of gridItems) {
			const card = item.querySelector('.widget-card');
			if (!card) continue;
			// Check if this grid item contains the target widget
			const titleEl = item.querySelector('.widget-title');
			const entry = os.entries.find((e) => e.id === serverId);
			if (titleEl && entry && titleEl.textContent?.toLowerCase().includes(entry.name.toLowerCase())) {
				item.classList.add('widget-chat-highlight');
				item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
				setTimeout(() => item.classList.remove('widget-chat-highlight'), 2000);
				break;
			}
		}
	}

	let agentRunning = $state(false);

	/**
	 * Execute a visual agent task — the AI cursor clicks through the widget
	 * while the user watches in real-time.
	 */
	async function executeAgentTask(serverId: string, task: string): Promise<string> {
		agentRunning = true;

		try {
			// 1. Open the widget on the grid
			loadingStatus = `opening ${serverId.replace('ghl-', '')}...`;
			const opened = await openWidgetForServer(serverId);
			if (!opened) throw new Error(`Could not open widget for ${serverId}`);

			// Wait for widget to be ready and PageController to initialize
			await new Promise((r) => setTimeout(r, 1500));

			// 2. Start agent session on daemon
			loadingStatus = "starting agent...";
			const ctl = new AbortController();
			const timeout = setTimeout(() => ctl.abort(), AGENT_EXEC_TIMEOUT_MS);
			let execRes: Response;
			try {
				execRes = await fetch(`${API_BASE}/api/os/agent-execute`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ serverId, task }),
					signal: ctl.signal,
				});
			} catch (err) {
				if (err instanceof Error && err.name === "AbortError") {
					throw new Error("Timed out while starting agent session");
				}

				throw err;
			} finally {
				clearTimeout(timeout);
			}
			const execData = await execRes.json();

			if (!execRes.ok || !execData.sessionId) {
				throw new Error(execData.error || "Failed to start agent session");
			}

			const sessionId = execData.sessionId;

			setAgentSession({
				serverId,
				status: "starting",
				currentStep: 0,
				totalSteps: 20,
			});

			// 3. Connect to SSE stream for agent events
			return await new Promise<string>((resolve, reject) => {
				const evtSource = new EventSource(`${API_BASE}/api/os/agent-events?session=${sessionId}`);
				let result = "Agent task completed";

				evtSource.onmessage = async (e) => {
					try {
						const event = JSON.parse(e.data);

						if (event.type === "connected") return;

						if (event.type === "agentStart") {
							// Tell the widget iframe to show the mask/cursor
							const sandbox = getWidgetSandbox(event.serverId);
							if (sandbox) sandbox.agentStart();
							return;
						}

						if (event.type === "agentStop") {
							// Tell the widget iframe to hide the mask/cursor
							const sandbox = getWidgetSandbox(event.serverId);
							if (sandbox) sandbox.agentStop();
							return;
						}

						if (event.type === "getDomState") {
							// Daemon is requesting DOM state — get it from the widget
							const sandbox = getWidgetSandbox(event.serverId);
							if (!sandbox) {
								await fetch(`${API_BASE}/api/os/agent-state`, {
									method: "POST",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({
										sessionId,
										domState: { success: false, error: "Widget sandbox not found" },
									}),
								});
								return;
							}

							try {
								const domState = await sandbox.getDomState();
								await fetch(`${API_BASE}/api/os/agent-state`, {
									method: "POST",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({ sessionId, domState }),
								});
							} catch (err) {
								await fetch(`${API_BASE}/api/os/agent-state`, {
									method: "POST",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({
										sessionId,
										domState: { success: false, error: err instanceof Error ? err.message : String(err) },
									}),
								});
							}
							return;
						}

						if (event.type === "executeAction") {
							// Daemon wants us to execute an action in the widget
							const sandbox = getWidgetSandbox(event.serverId);
							if (sandbox && event.data?.action) {
								try {
									await sandbox.executeAction(event.data.action);
								} catch (err) {
									console.warn("executeAction error:", err);
								}
							}
							return;
						}

						if (event.type === "status") {
							const d = event.data as { step?: number; status?: string; message?: string };
							loadingStatus = d?.message || `step ${d?.step}...`;
							setAgentSession({
								serverId: event.serverId,
								status: (d?.status as "observing" | "thinking" | "acting") || "starting",
								currentStep: d?.step || 0,
								totalSteps: 20,
								lastAction: d?.message,
							});
							scrollToBottom();
							return;
						}

						if (event.type === "done") {
							const d = event.data as { summary?: string };
							result = d?.summary || "Task completed";
							setAgentSession(null);
							evtSource.close();
							resolve(result);
							return;
						}

						if (event.type === "error") {
							const d = event.data as { error?: string };
							setAgentSession(null);
							evtSource.close();
							reject(new Error(d?.error || "Agent error"));
							return;
						}
					} catch (err) {
						console.warn("Agent SSE parse error:", err);
					}
				};

				evtSource.onerror = () => {
					setAgentSession(null);
					evtSource.close();
					reject(new Error("Agent event stream disconnected"));
				};

				// Timeout after 5 minutes
				setTimeout(() => {
					setAgentSession(null);
					evtSource.close();
					reject(new Error("Agent execution timed out"));
				}, 300000);
			});
		} finally {
			agentRunning = false;
			setAgentSession(null);
		}
	}

	async function send() {
		const text = input.trim();
		if (!text || loading) return;

		messages.push({ role: "user", content: text, timestamp: Date.now() });
		input = "";
		loading = true;
		loadingStatus = "thinking...";
		scrollToBottom();

		try {
			// Send to chat endpoint — LLM decides if this needs visual agent or direct tools
			const res = await fetch(`${API_BASE}/api/os/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: text }),
			});
			const data = await res.json();

			// ═══════════════════════════════════════════════════════════════
			// VISUAL AGENT MODE — LLM decided this needs the AI cursor
			// ═══════════════════════════════════════════════════════════════
			if (data.useAgent && data.agentServerId) {
				// Show the LLM's immediate response first
				messages.push({
					role: "agent",
					content: data.response ?? "starting visual agent...",
					timestamp: Date.now(),
				});
				scrollToBottom();

				loadingStatus = "starting visual agent...";

				try {
					const agentResult = await executeAgentTask(data.agentServerId, data.agentTask || text);
					messages.push({
						role: "agent",
						content: agentResult,
						timestamp: Date.now(),
						openedWidget: data.agentServerId,
					});
				} catch (err) {
					messages.push({
						role: "agent",
						content: `agent hit a wall: ${err instanceof Error ? err.message : String(err)}`,
						timestamp: Date.now(),
					});
				}

				loading = false;
				loadingStatus = "";
				scrollToBottom();
				return;
			}

			// ═══════════════════════════════════════════════════════════════
			// DIRECT TOOL MODE — standard tool calls (read operations)
			// ═══════════════════════════════════════════════════════════════
			const toolCalls: ToolCall[] = data.toolCalls ?? [];

			// If tools were called, open the related widget(s) and trigger actions
			let openedWidget: string | undefined;
			if (toolCalls.length > 0) {
				const serverIds = [...new Set(toolCalls.map((tc) => tc.server))];
				for (const sid of serverIds) {
					loadingStatus = `opening ${sid.replace('ghl-', '')}...`;
					const opened = await openWidgetForServer(sid);
					if (opened) openedWidget = sid;
				}

				for (const tc of toolCalls) {
					if (tc.error) continue;
					const tool = tc.tool;
					const sid = tc.server;

					// Mutation tools → refresh the widget to show changes
					const isMutation = tool.startsWith("create_") || tool.startsWith("update_") ||
						tool.startsWith("delete_") || tool.startsWith("add_") ||
						tool.startsWith("remove_") || tool.startsWith("merge_");

					if (isMutation) {
						loadingStatus = `updating ${sid.replace('ghl-', '')}...`;
						await new Promise((r) => setTimeout(r, 800));
						sendWidgetAction(sid, "refresh");
					}

					if (tc.result) {
						try {
							const resultData = typeof tc.result === "string" ? JSON.parse(tc.result) : tc.result;
							const content = resultData?.content?.[0]?.text;
							const parsed = content ? JSON.parse(content) : resultData;

							const firstName = parsed?.contact?.firstName || parsed?.firstName || "";
							const lastName = parsed?.contact?.lastName || parsed?.lastName || "";
							const name = `${firstName} ${lastName}`.trim() ||
								parsed?.contactName || parsed?.name || parsed?.title || null;

							if (name && isMutation) {
								await new Promise((r) => setTimeout(r, 3000));
								sendWidgetAction(sid, "highlight", { text: name });
							}
						} catch {
							// Result parsing failed — skip highlight
						}
					}
				}
			}

			messages.push({
				role: "agent",
				content: data.response ?? data.error ?? "No response",
				timestamp: Date.now(),
				toolCalls,
				openedWidget,
			});
		} catch (err) {
			messages.push({
				role: "agent",
				content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
				timestamp: Date.now(),
			});
		} finally {
			loading = false;
			loadingStatus = "";
			scrollToBottom();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}

	function formatTime(ts: number): string {
		return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	function getWidgetName(serverId: string): string {
		const entry = os.entries.find((e) => e.id === serverId);
		return entry?.name ?? serverId;
	}

	function scrollToWidget(serverId: string): void {
		highlightWidget(serverId);
	}

	// Agent mode is now auto-detected by the LLM in os-chat.ts
	// No manual /agent command needed — just type naturally
</script>

<div class="agent-chat">
	<!-- Message history -->
	<div class="chat-messages" bind:this={chatEl}>
		{#if messages.length === 0}
			<div class="chat-empty">
				<Bot class="size-5 opacity-30" />
				<span class="sig-label" style="color: var(--sig-text-muted)">
					Ask me anything — I'll pull up the right app and show you the data live.
				</span>
			</div>
		{/if}

		{#each messages as msg (msg.timestamp)}
			<div class="chat-msg chat-msg--{msg.role}">
				<div class="chat-msg-icon">
					{#if msg.role === "user"}
						<User class="size-3" />
					{:else}
						<Bot class="size-3" />
					{/if}
				</div>
				<div class="chat-msg-body">
					<div class="chat-msg-content">{msg.content}</div>
					{#if msg.toolCalls && msg.toolCalls.length > 0}
						<div class="chat-tool-calls">
							{#each msg.toolCalls as tc}
								<div class="chat-tool-call">
									<Wrench class="size-2.5" />
									<span class="chat-tool-name">{tc.server}/{tc.tool}</span>
									{#if tc.error}
										<span class="chat-tool-error">failed</span>
									{:else}
										<span class="chat-tool-ok">done</span>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
					{#if msg.openedWidget}
						<button
							class="chat-widget-link"
							onclick={() => scrollToWidget(msg.openedWidget!)}
						>
							<ExternalLink class="size-2.5" />
							<span>Showing in {getWidgetName(msg.openedWidget)}</span>
						</button>
					{/if}
					<span class="chat-msg-time">{formatTime(msg.timestamp)}</span>
				</div>
			</div>
		{/each}

		{#if loading}
			<div class="chat-msg chat-msg--agent">
				<div class="chat-msg-icon">
					{#if agentRunning}
						<Cpu class="size-3 agent-pulse" />
					{:else}
						<Bot class="size-3" />
					{/if}
				</div>
				<div class="chat-msg-body">
					<div class="chat-thinking" class:agent-active={agentRunning}>
						{#if agentRunning}
							<span class="agent-indicator"></span>
						{:else}
							<span class="dot"></span>
							<span class="dot"></span>
							<span class="dot"></span>
						{/if}
						<span class="chat-status-text">{loadingStatus}</span>
					</div>
				</div>
			</div>
		{/if}
	</div>

	<!-- Input bar -->
	<div class="chat-input-bar">
		<input
			type="text"
			class="chat-input"
			placeholder="Ask your agent..."
			bind:value={input}
			onkeydown={handleKeydown}
			disabled={loading}
		/>
		<button
			class="chat-send-btn"
			title="Send message"
			onclick={send}
			disabled={loading || !input.trim()}
		>
			<Send class="size-3.5" />
		</button>
	</div>
</div>

<style>
	.agent-chat {
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--sig-border);
		background: var(--sig-bg);
		max-height: 280px;
		min-height: 120px;
	}

	.chat-messages {
		flex: 1;
		overflow-y: auto;
		padding: var(--space-sm) var(--space-md);
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.chat-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: var(--space-lg) var(--space-md);
		text-align: center;
		opacity: 0.7;
	}

	.chat-msg {
		display: flex;
		gap: 8px;
		max-width: 85%;
		animation: chatFadeIn 0.15s ease-out;
	}

	.chat-msg--user {
		align-self: flex-end;
		flex-direction: row-reverse;
	}

	.chat-msg--agent {
		align-self: flex-start;
	}

	.chat-msg-icon {
		display: flex;
		align-items: flex-start;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: var(--sig-surface);
		border: 1px solid var(--sig-border);
		color: var(--sig-text-muted);
		flex-shrink: 0;
		padding-top: 4px;
	}

	.chat-msg--user .chat-msg-icon {
		background: color-mix(in srgb, var(--sig-accent) 15%, var(--sig-surface));
		border-color: color-mix(in srgb, var(--sig-accent) 30%, var(--sig-border));
		color: var(--sig-accent);
	}

	.chat-msg-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.chat-msg-content {
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 1.5;
		color: var(--sig-text);
		background: var(--sig-surface);
		border: 1px solid var(--sig-border);
		border-radius: 8px;
		padding: 6px 10px;
		word-break: break-word;
	}

	.chat-msg--user .chat-msg-content {
		background: color-mix(in srgb, var(--sig-accent) 8%, var(--sig-surface));
		border-color: color-mix(in srgb, var(--sig-accent) 20%, var(--sig-border));
	}

	.chat-msg-time {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		padding: 0 4px;
		opacity: 0.6;
	}

	.chat-msg--user .chat-msg-time {
		text-align: right;
	}

	.chat-tool-calls {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-top: 2px;
	}

	.chat-tool-call {
		display: flex;
		align-items: center;
		gap: 4px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		padding: 2px 6px;
		background: color-mix(in srgb, var(--sig-accent) 5%, var(--sig-bg));
		border-radius: 4px;
		border: 1px solid var(--sig-border);
	}

	.chat-tool-name {
		font-weight: 600;
		color: var(--sig-accent);
	}

	.chat-tool-ok {
		color: var(--sig-success, #5a7a5a);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.chat-tool-error {
		color: var(--sig-danger, #7a4a4a);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.chat-widget-link {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-accent);
		padding: 2px 8px;
		background: color-mix(in srgb, var(--sig-accent) 8%, var(--sig-bg));
		border: 1px solid color-mix(in srgb, var(--sig-accent) 25%, var(--sig-border));
		border-radius: 4px;
		cursor: pointer;
		margin-top: 2px;
		transition: all 0.15s ease;
	}

	.chat-widget-link:hover {
		background: color-mix(in srgb, var(--sig-accent) 15%, var(--sig-bg));
		border-color: var(--sig-accent);
	}

	/* Thinking dots */
	.chat-thinking {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 6px 10px;
		background: var(--sig-surface);
		border: 1px solid var(--sig-border);
		border-radius: 8px;
	}

	.chat-status-text {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		margin-left: 4px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--sig-text-muted);
		animation: dotPulse 1.2s ease-in-out infinite;
	}

	.dot:nth-child(2) {
		animation-delay: 0.2s;
	}

	.dot:nth-child(3) {
		animation-delay: 0.4s;
	}

	@keyframes dotPulse {
		0%, 60%, 100% {
			opacity: 0.2;
			transform: scale(0.8);
		}
		30% {
			opacity: 1;
			transform: scale(1);
		}
	}

	/* Agent mode styles */
	.agent-active {
		border-color: var(--sig-electric, #39b6ff) !important;
		background: color-mix(in srgb, var(--sig-electric, #39b6ff) 8%, var(--sig-surface)) !important;
	}

	.agent-indicator {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--sig-electric, #39b6ff);
		animation: agentPulse 1s ease-in-out infinite;
	}

	:global(.agent-pulse) {
		color: var(--sig-electric, #39b6ff) !important;
		animation: agentPulse 1s ease-in-out infinite;
	}

	@keyframes agentPulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	@keyframes chatFadeIn {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	/* Input bar */
	.chat-input-bar {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px var(--space-md);
		border-top: 1px solid var(--sig-border);
		background: var(--sig-surface);
		flex-shrink: 0;
	}

	.chat-input {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--sig-text);
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		border-radius: 6px;
		padding: 6px 10px;
		outline: none;
		transition: border-color var(--dur) var(--ease);
	}

	.chat-input::placeholder {
		color: var(--sig-text-muted);
		opacity: 0.6;
	}

	.chat-input:focus {
		border-color: var(--sig-accent);
	}

	.chat-input:disabled {
		opacity: 0.5;
	}

	.chat-send-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		padding: 0;
		border: 1px solid var(--sig-border);
		border-radius: 6px;
		background: var(--sig-surface);
		color: var(--sig-text-muted);
		cursor: pointer;
		transition: all var(--dur) var(--ease);
		flex-shrink: 0;
	}

	.chat-send-btn:hover:not(:disabled) {
		border-color: var(--sig-accent);
		color: var(--sig-accent);
		background: color-mix(in srgb, var(--sig-accent) 8%, var(--sig-surface));
	}

	.chat-send-btn:disabled {
		opacity: 0.3;
		cursor: default;
	}
</style>
