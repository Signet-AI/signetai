/**
 * OS Agent routes — visual GUI agent execution for Signet OS widgets.
 *
 * Implements the observe-think-act loop:
 *   1. OBSERVE: Request DOM state from the dashboard (via SSE → postMessage → iframe)
 *   2. THINK: Call LLM with simplified HTML + user task
 *   3. ACT: Send action command to dashboard (via SSE → postMessage → iframe)
 *   4. WAIT: Let DOM settle
 *   5. LOOP: Repeat until done or max steps reached
 *
 * Routes:
 *   POST /api/os/agent-execute  — start an agent execution session
 *   POST /api/os/agent-state    — dashboard sends DOM state back to daemon
 *   GET  /api/os/agent-events   — SSE stream of agent commands for the dashboard
 */

import type { Hono } from "hono";
import { logger } from "../logger.js";
import { getSecret } from "../secrets.js";

// ============================================================================
// Agent Session State (in-memory)
// ============================================================================

interface AgentSessionState {
	id: string;
	serverId: string;
	task: string;
	status: "running" | "done" | "error";
	step: number;
	maxSteps: number;
	/** Pending DOM state request — resolved when dashboard POSTs back */
	pendingDomState: {
		resolve: (state: unknown) => void;
		reject: (err: Error) => void;
	} | null;
	/** SSE listeners waiting for agent commands */
	sseListeners: Array<(event: AgentEvent) => void>;
	/** Conversation history for the LLM */
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
	/** Final result */
	result?: string;
	error?: string;
}

interface AgentEvent {
	type: "getDomState" | "executeAction" | "agentStart" | "agentStop" | "status" | "done" | "error";
	sessionId: string;
	serverId: string;
	data?: unknown;
}

const activeSessions = new Map<string, AgentSessionState>();

let sessionCounter = 0;

function createSessionId(): string {
	return `agent_${Date.now()}_${++sessionCounter}`;
}

// ============================================================================
// LLM Integration
// ============================================================================

let cachedApiKey: string | null = null;

async function getApiKey(): Promise<string> {
	if (!cachedApiKey) {
		cachedApiKey = process.env.OPENAI_API_KEY || (await getSecret("OPENAI_API_KEY").catch(() => ""));
	}
	if (!cachedApiKey) throw new Error("OPENAI_API_KEY not found");
	return cachedApiKey;
}

const AGENT_SYSTEM_PROMPT = `You are a GUI automation agent operating inside a web widget. You can see the page as simplified HTML with indexed interactive elements like [0]<button>Click me</button>.

Available actions (respond with exactly ONE action per turn as JSON):

1. Click an element:
   {"action": "click_element", "index": 0, "thought": "clicking the button to open the form"}

2. Type text into an input:
   {"action": "input_text", "index": 1, "text": "hello world", "thought": "entering search query"}

3. Select a dropdown option:
   {"action": "select_option", "index": 2, "text": "Option A", "thought": "selecting the filter"}

4. Scroll the page:
   {"action": "scroll", "direction": "down", "amount": 1, "thought": "scrolling to see more content"}

5. Task is complete:
   {"action": "done", "thought": "the contact has been created successfully", "summary": "Created contact John Doe with email john@example.com"}

Rules:
- Respond with ONLY the JSON object, no markdown fences, no explanation
- Always include a "thought" field explaining your reasoning
- Element indices correspond to [N] in the HTML — use the exact index shown
- After clicking something that opens a dialog/form, wait to see the new state
- If you see the expected result in the DOM, respond with "done"
- Be efficient — don't scroll unnecessarily, click directly if the element is visible
- For input fields: click first to focus, then input_text in the next step if needed
- Actually the click is already handled by input_text, so just use input_text directly
- Maximum steps allowed: 20. Be efficient.`;

interface AgentAction {
	action: "click_element" | "input_text" | "select_option" | "scroll" | "done";
	index?: number;
	text?: string;
	direction?: string;
	amount?: number;
	thought?: string;
	summary?: string;
}

async function callAgentLlm(messages: Array<{ role: string; content: string }>): Promise<AgentAction> {
	const apiKey = await getApiKey();

	const res = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: "gpt-4o",
			max_tokens: 512,
			temperature: 0.1,
			messages,
		}),
	});

	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`OpenAI API ${res.status}: ${errText.slice(0, 200)}`);
	}

	const data = (await res.json()) as {
		choices: Array<{ message: { content: string } }>;
	};
	const raw = data.choices?.[0]?.message?.content ?? "";

	// Parse the action JSON
	let cleaned = raw.trim();
	if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
	else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
	if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
	cleaned = cleaned.trim();

	try {
		return JSON.parse(cleaned) as AgentAction;
	} catch {
		// Try to extract JSON from within text
		const jsonMatch = cleaned.match(/\{[\s\S]*"action"[\s\S]*\}/);
		if (jsonMatch) {
			return JSON.parse(jsonMatch[0]) as AgentAction;
		}
		throw new Error(`Failed to parse agent response: ${cleaned.slice(0, 200)}`);
	}
}

// ============================================================================
// Agent Execution Loop
// ============================================================================

async function runAgentLoop(session: AgentSessionState): Promise<void> {
	try {
		// Notify dashboard to start agent mode (show mask + cursor)
		broadcastToSession(session, {
			type: "agentStart",
			sessionId: session.id,
			serverId: session.serverId,
		});

		// Initialize conversation
		session.messages = [
			{ role: "system", content: AGENT_SYSTEM_PROMPT },
			{ role: "user", content: `Task: ${session.task}` },
		];

		for (let step = 1; step <= session.maxSteps; step++) {
			session.step = step;

			// --- OBSERVE ---
			broadcastToSession(session, {
				type: "status",
				sessionId: session.id,
				serverId: session.serverId,
				data: { step, status: "observing", message: `Step ${step}: Reading page...` },
			});

			const domState = await requestDomState(session);

			if (!domState || !(domState as Record<string, unknown>).success) {
				const errMsg = (domState as Record<string, unknown>)?.error || "Failed to get DOM state";
				logger.warn("os-agent", `DOM state error: ${errMsg}`);
				// Retry once
				await sleep(500);
				continue;
			}

			const browserState = (domState as Record<string, unknown>).state as {
				header: string;
				content: string;
				footer: string;
			};

			// Build observation message for LLM
			const observation = `${browserState.header}\n\n${browserState.content}\n\n${browserState.footer}`;

			// Add observation to conversation
			session.messages.push({
				role: "user",
				content: `Current page state:\n${observation}`,
			});

			// --- THINK ---
			broadcastToSession(session, {
				type: "status",
				sessionId: session.id,
				serverId: session.serverId,
				data: { step, status: "thinking", message: `Step ${step}: Thinking...` },
			});

			let action: AgentAction;
			try {
				action = await callAgentLlm(session.messages);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logger.warn("os-agent", `LLM error at step ${step}: ${msg}`);
				session.messages.push({
					role: "assistant",
					content: JSON.stringify({ action: "done", thought: "LLM error", summary: msg }),
				});
				break;
			}

			logger.info("os-agent", `Step ${step}: ${action.action}`, {
				thought: action.thought?.slice(0, 100),
			});

			// Add assistant response to conversation
			session.messages.push({
				role: "assistant",
				content: JSON.stringify(action),
			});

			// --- DONE CHECK ---
			if (action.action === "done") {
				session.status = "done";
				session.result = action.summary || action.thought || "Task completed";

				broadcastToSession(session, {
					type: "done",
					sessionId: session.id,
					serverId: session.serverId,
					data: { step, summary: session.result },
				});
				break;
			}

			// --- ACT ---
			broadcastToSession(session, {
				type: "status",
				sessionId: session.id,
				serverId: session.serverId,
				data: {
					step,
					status: "acting",
					message: `Step ${step}: ${describeAction(action)}`,
				},
			});

			// Map agent action to iframe action format
			const iframeAction = mapToIframeAction(action);

			broadcastToSession(session, {
				type: "executeAction",
				sessionId: session.id,
				serverId: session.serverId,
				data: { action: iframeAction },
			});

			// Wait for the dashboard to relay the action and DOM to settle
			// The dashboard will execute the action immediately, we don't need to wait for a response
			await sleep(800);

			// Add action result context for next observation
			session.messages.push({
				role: "user",
				content: `Action executed: ${describeAction(action)}. The page may have changed. Observe the new state.`,
			});
		}

		// If we exhausted steps without completing
		if (session.status === "running") {
			session.status = "done";
			session.result = "Reached maximum steps without completing the task.";
			broadcastToSession(session, {
				type: "done",
				sessionId: session.id,
				serverId: session.serverId,
				data: { step: session.step, summary: session.result },
			});
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		session.status = "error";
		session.error = msg;
		logger.warn("os-agent", `Agent error: ${msg}`);

		broadcastToSession(session, {
			type: "error",
			sessionId: session.id,
			serverId: session.serverId,
			data: { error: msg },
		});
	} finally {
		// Notify dashboard to stop agent mode
		broadcastToSession(session, {
			type: "agentStop",
			sessionId: session.id,
			serverId: session.serverId,
		});

		// Clean up after a delay to let SSE clients receive final events
		setTimeout(() => {
			activeSessions.delete(session.id);
		}, 30000);
	}
}

function mapToIframeAction(action: AgentAction): Record<string, unknown> {
	switch (action.action) {
		case "click_element":
			return { type: "click_element", index: action.index };
		case "input_text":
			return { type: "input_text", index: action.index, text: action.text };
		case "select_option":
			return { type: "select_option", index: action.index, text: action.text };
		case "scroll":
			return {
				type: "scroll",
				direction: action.direction || "down",
				amount: action.amount || 1,
			};
		default:
			return { type: action.action };
	}
}

function describeAction(action: AgentAction): string {
	switch (action.action) {
		case "click_element":
			return `Clicking element [${action.index}]`;
		case "input_text":
			return `Typing "${action.text?.slice(0, 30)}" into element [${action.index}]`;
		case "select_option":
			return `Selecting "${action.text}" in element [${action.index}]`;
		case "scroll":
			return `Scrolling ${action.direction || "down"}`;
		case "done":
			return "Task complete";
		default:
			return action.action;
	}
}

async function requestDomState(session: AgentSessionState): Promise<unknown> {
	return new Promise((resolve, reject) => {
		session.pendingDomState = { resolve, reject };

		// Broadcast request to dashboard via SSE
		broadcastToSession(session, {
			type: "getDomState",
			sessionId: session.id,
			serverId: session.serverId,
		});

		// Timeout after 15s
		setTimeout(() => {
			if (session.pendingDomState) {
				session.pendingDomState = null;
				reject(new Error("DOM state request timeout"));
			}
		}, 15000);
	});
}

function broadcastToSession(session: AgentSessionState, event: AgentEvent): void {
	const listeners = session.sseListeners.slice();
	for (let i = 0; i < listeners.length; i++) {
		try {
			listeners[i](event);
		} catch {
			// Listener may have disconnected
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// HTTP Routes
// ============================================================================

export function mountOsAgentRoutes(app: Hono): void {
	/**
	 * POST /api/os/agent-execute — Start an agent execution session.
	 *
	 * Body: { serverId: string, task: string }
	 * Returns: { sessionId: string } — connect to /api/os/agent-events?session=<id> for updates
	 */
	app.post("/api/os/agent-execute", async (c) => {
		let body: { serverId?: string; task?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON" }, 400);
		}

		const serverId = body.serverId?.trim();
		const task = body.task?.trim();

		if (!serverId || !task) {
			return c.json({ error: "serverId and task are required" }, 400);
		}

		// Check if there's already an active session for this server
		const existingSessions = Array.from(activeSessions.values());
		for (let i = 0; i < existingSessions.length; i++) {
			if (existingSessions[i].serverId === serverId && existingSessions[i].status === "running") {
				return c.json({ error: "An agent session is already running for this server" }, 409);
			}
		}

		const sessionId = createSessionId();

		const session: AgentSessionState = {
			id: sessionId,
			serverId,
			task,
			status: "running",
			step: 0,
			maxSteps: 20,
			pendingDomState: null,
			sseListeners: [],
			messages: [],
		};

		activeSessions.set(sessionId, session);

		logger.info("os-agent", `Starting agent session ${sessionId}`, {
			serverId,
			task: task.slice(0, 100),
		});

		// Start the agent loop asynchronously (don't await — return session ID immediately)
		// Small delay to let the SSE client connect first
		setTimeout(() => runAgentLoop(session), 500);

		return c.json({ sessionId, serverId });
	});

	/**
	 * POST /api/os/agent-state — Dashboard sends DOM state back to the daemon.
	 *
	 * Body: { sessionId: string, domState: unknown }
	 */
	app.post("/api/os/agent-state", async (c) => {
		let body: { sessionId?: string; domState?: unknown };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON" }, 400);
		}

		const sessionId = body.sessionId;
		if (!sessionId) {
			return c.json({ error: "sessionId is required" }, 400);
		}

		const session = activeSessions.get(sessionId);
		if (!session) {
			return c.json({ error: "Session not found" }, 404);
		}

		// Resolve the pending DOM state promise
		if (session.pendingDomState) {
			session.pendingDomState.resolve(body.domState);
			session.pendingDomState = null;
		}

		return c.json({ success: true });
	});

	/**
	 * GET /api/os/agent-events — SSE stream of agent commands for the dashboard.
	 *
	 * Query params:
	 *   ?session=<sessionId> — filter to a specific session (optional)
	 *
	 * The dashboard listens here and relays commands to the appropriate widget iframe.
	 */
	app.get("/api/os/agent-events", (c) => {
		const sessionFilter = c.req.query("session") || undefined;
		const encoder = new TextEncoder();

		const stream = new ReadableStream({
			start(controller) {
				const onEvent = (event: AgentEvent) => {
					try {
						const data = `data: ${JSON.stringify(event)}\n\n`;
						controller.enqueue(encoder.encode(data));
					} catch {
						// Client disconnected
					}
				};

				// If session specified, attach to that session only
				if (sessionFilter) {
					const session = activeSessions.get(sessionFilter);
					if (session) {
						session.sseListeners.push(onEvent);

						// Send initial connected event
						controller.enqueue(
							encoder.encode(
								`data: ${JSON.stringify({
									type: "connected",
									sessionId: session.id,
									serverId: session.serverId,
								})}\n\n`,
							),
						);
					} else {
						controller.enqueue(
							encoder.encode(`data: ${JSON.stringify({ type: "error", data: { error: "Session not found" } })}\n\n`),
						);
					}
				} else {
					// Listen to ALL sessions (broadcast mode)
					// Register on all current sessions
					Array.from(activeSessions.values()).forEach((session) => {
						session.sseListeners.push(onEvent);
					});
				}

				// Heartbeat
				const heartbeat = setInterval(() => {
					try {
						controller.enqueue(encoder.encode(": heartbeat\n\n"));
					} catch {
						clearInterval(heartbeat);
					}
				}, 15000);

				// Cleanup on disconnect
				c.req.raw.signal.addEventListener("abort", () => {
					clearInterval(heartbeat);
					// Remove listener from all sessions
					Array.from(activeSessions.values()).forEach((session) => {
						const idx = session.sseListeners.indexOf(onEvent);
						if (idx >= 0) session.sseListeners.splice(idx, 1);
					});
				});
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	});

	/**
	 * GET /api/os/agent-sessions — List active agent sessions.
	 */
	app.get("/api/os/agent-sessions", (c) => {
		const sessions = Array.from(activeSessions.values()).map((s) => ({
			id: s.id,
			serverId: s.serverId,
			task: s.task,
			status: s.status,
			step: s.step,
			maxSteps: s.maxSteps,
			result: s.result,
			error: s.error,
		}));

		return c.json({ sessions, count: sessions.length });
	});
}
