import type { RoutingPrivacyTier } from "@signet/core";
import type { Hono } from "hono";
import { getInferenceRouterOrNull } from "../inference-router.js";
import { getInteractiveLlmProviderOrNull } from "../llm.js";
import { logger } from "../logger.js";

interface AgentSessionState {
	id: string;
	serverId: string;
	task: string;
	agentId?: string;
	taskClass?: string;
	privacy?: RoutingPrivacyTier;
	status: "running" | "done" | "error";
	step: number;
	maxSteps: number;
	pendingDomState: {
		resolve: (state: unknown) => void;
		reject: (err: Error) => void;
	} | null;
	sseListeners: Array<(event: AgentEvent) => void>;
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
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

function buildAgentPrompt(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>): string {
	const transcript = messages
		.filter((message) => message.role !== "system")
		.map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
		.join("\n\n");
	return `${AGENT_SYSTEM_PROMPT}\n\nConversation:\n${transcript}\n\nRespond with exactly one JSON action.`;
}

async function callAgentLlm(
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
	route?: {
		readonly agentId?: string;
		readonly taskClass?: string;
		readonly privacy?: RoutingPrivacyTier;
	},
): Promise<AgentAction> {
	let raw: string;
	const router = getInferenceRouterOrNull();
	if (router && (await router.hasWorkload("interactive"))) {
		const routed = await router.execute(
			{
				agentId: route?.agentId,
				operation: "os_agent",
				taskClass: route?.taskClass,
				privacy: route?.privacy,
				promptPreview: messages[messages.length - 1]?.content,
			},
			buildAgentPrompt(messages),
			{ maxTokens: 512 },
		);
		if (routed.ok) {
			raw = routed.value.text;
		} else {
			logger.warn("os-agent", "Inference router failed, falling back to legacy interactive provider", {
				error: routed.error.message,
			});
			raw = "";
		}
	} else {
		raw = "";
	}
	if (!raw) {
		const provider = getInteractiveLlmProviderOrNull();
		if (!provider) {
			throw new Error("Interactive inference provider is not configured");
		}
		raw = await provider.generate(buildAgentPrompt(messages), {
			maxTokens: 512,
		});
	}
	let cleaned = raw.trim();
	if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
	else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
	if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
	cleaned = cleaned.trim();

	try {
		return JSON.parse(cleaned) as AgentAction;
	} catch {
		const jsonMatch = cleaned.match(/\{[\s\S]*"action"[\s\S]*\}/);
		if (jsonMatch) {
			return JSON.parse(jsonMatch[0]) as AgentAction;
		}
		throw new Error(`Failed to parse agent response: ${cleaned.slice(0, 200)}`);
	}
}

async function runAgentLoop(session: AgentSessionState): Promise<void> {
	try {
		broadcastToSession(session, {
			type: "agentStart",
			sessionId: session.id,
			serverId: session.serverId,
		});
		session.messages = [
			{ role: "system", content: AGENT_SYSTEM_PROMPT },
			{ role: "user", content: `Task: ${session.task}` },
		];

		for (let step = 1; step <= session.maxSteps; step++) {
			session.step = step;
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
				await sleep(500);
				continue;
			}

			const browserState = (domState as Record<string, unknown>).state as {
				header: string;
				content: string;
				footer: string;
			};
			const observation = `${browserState.header}\n\n${browserState.content}\n\n${browserState.footer}`;
			session.messages.push({
				role: "user",
				content: `Current page state:\n${observation}`,
			});
			broadcastToSession(session, {
				type: "status",
				sessionId: session.id,
				serverId: session.serverId,
				data: { step, status: "thinking", message: `Step ${step}: Thinking...` },
			});

			let action: AgentAction;
			try {
				action = await callAgentLlm(session.messages, {
					agentId: session.agentId,
					taskClass: session.taskClass,
					privacy: session.privacy,
				});
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
			session.messages.push({
				role: "assistant",
				content: JSON.stringify(action),
			});
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
			const iframeAction = mapToIframeAction(action);

			broadcastToSession(session, {
				type: "executeAction",
				sessionId: session.id,
				serverId: session.serverId,
				data: { action: iframeAction },
			});
			await sleep(800);
			session.messages.push({
				role: "user",
				content: `Action executed: ${describeAction(action)}. The page may have changed. Observe the new state.`,
			});
		}
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
		broadcastToSession(session, {
			type: "agentStop",
			sessionId: session.id,
			serverId: session.serverId,
		});
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
		broadcastToSession(session, {
			type: "getDomState",
			sessionId: session.id,
			serverId: session.serverId,
		});
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
		} catch {}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function mountOsAgentRoutes(app: Hono): void {
	app.post("/api/os/agent-execute", async (c) => {
		let body: { serverId?: string; task?: string; agentId?: string; taskClass?: string; privacy?: RoutingPrivacyTier };
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
			agentId: body.agentId?.trim() || undefined,
			taskClass: body.taskClass?.trim() || undefined,
			privacy: body.privacy,
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
		setTimeout(() => runAgentLoop(session), 500);

		return c.json({ sessionId, serverId });
	});
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
		if (session.pendingDomState) {
			session.pendingDomState.resolve(body.domState);
			session.pendingDomState = null;
		}

		return c.json({ success: true });
	});
	app.get("/api/os/agent-events", (c) => {
		const sessionFilter = c.req.query("session") || undefined;
		const encoder = new TextEncoder();

		const stream = new ReadableStream({
			start(controller) {
				const onEvent = (event: AgentEvent) => {
					try {
						const data = `data: ${JSON.stringify(event)}\n\n`;
						controller.enqueue(encoder.encode(data));
					} catch {}
				};
				if (sessionFilter) {
					const session = activeSessions.get(sessionFilter);
					if (session) {
						session.sseListeners.push(onEvent);
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
					for (const session of activeSessions.values()) {
						session.sseListeners.push(onEvent);
					}
				}
				const heartbeat = setInterval(() => {
					try {
						controller.enqueue(encoder.encode(": heartbeat\n\n"));
					} catch {
						clearInterval(heartbeat);
					}
				}, 15000);
				c.req.raw.signal.addEventListener("abort", () => {
					clearInterval(heartbeat);
					for (const session of activeSessions.values()) {
						const idx = session.sseListeners.indexOf(onEvent);
						if (idx >= 0) session.sseListeners.splice(idx, 1);
					}
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
