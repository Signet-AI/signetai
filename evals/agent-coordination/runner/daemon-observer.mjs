const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeObserver({
	baseUrl,
	token,
	agents,
	syntheticIds = new Set(),
	emit,
	fetchImpl = fetch,
	pollMs = 500,
	pageLimit = 200,
}) {
	const idToLabel = Object.fromEntries(Object.entries(agents).map(([l, a]) => [a.agentId, l]));
	const sessionToLabel = Object.fromEntries(
		Object.entries(agents)
			.filter(([, a]) => a.sessionKey)
			.map(([l, a]) => [a.sessionKey, l]),
	);
	const seenDm = new Set();
	const seenAck = new Set();
	const lastDelivery = new Map();
	const controllers = [];
	let stopped = false;
	let pollTimer = null;
	const headers = { authorization: `Bearer ${token}`, accept: "application/json" };

	const label = (agentId, sessionKey) =>
		idToLabel[agentId] ??
		sessionToLabel[sessionKey] ??
		(syntheticIds.has(agentId) ? "distractor" : agentId || sessionKey ? "unknown" : null);

	function observe(m, via) {
		const toId = m.toAgentId ?? m.toSessionAgentId;
		if (!seenDm.has(m.id)) {
			seenDm.add(m.id);
			emit({
				src: "daemon",
				type: "dm",
				daemonCreatedAt: m.createdAt,
				via,
				messageId: m.id,
				fromAgent: m.fromAgentId ?? null,
				fromSession: m.fromSessionKey ?? null,
				toAgent: toId ?? null,
				toSession: m.toSessionKey ?? null,
				broadcast: m.broadcast === true,
				toSynthetic: syntheticIds.has(toId),
				kind: m.type,
				content: m.content,
			});
		}
		const dState = `${m.deliveryStatus ?? ""}/${m.deliveryState ?? ""}/${m.deliveryAttempts ?? 0}`;
		if (lastDelivery.get(m.id) !== dState) {
			lastDelivery.set(m.id, dState);
			emit({
				src: "daemon",
				type: "dm_delivery",
				messageId: m.id,
				deliveryStatus: m.deliveryStatus ?? null,
				deliveryState: m.deliveryState ?? null,
				attempts: m.deliveryAttempts ?? 0,
				error: m.deliveryError ?? null,
			});
		}
		if (m.acknowledgedAt && !seenAck.has(m.id)) {
			seenAck.add(m.id);
			emit({
				src: "daemon",
				type: "dm_ack",
				daemonAckAt: m.acknowledgedAt,
				messageId: m.id,
				agent: label(toId, m.toSessionKey),
			});
		}
	}

	async function pollOnce() {
		for (const a of Object.values(agents)) {
			if (!a.sessionKey) continue;
			const q = new URLSearchParams({
				agent_id: a.agentId,
				session_key: a.sessionKey,
				include_sent: "true",
				include_broadcast: "true",
				order: "asc",
				limit: String(pageLimit),
			});
			try {
				const r = await fetchImpl(`${baseUrl}/api/cross-agent/messages?${q}`, { headers });
				if (!r.ok) {
					emit({ src: "observer", type: "poll_error", status: r.status });
					continue;
				}
				const body = await r.json();
				for (const m of body.messages ?? (Array.isArray(body) ? body : [])) observe(m, "poll");
			} catch (e) {
				emit({ src: "observer", type: "poll_error", message: String(e.message).slice(0, 200) });
			}
		}
	}

	async function streamOne(a) {
		let backoff = 250;
		while (!stopped) {
			const ac = new AbortController();
			controllers.push(ac);
			try {
				const q = new URLSearchParams({
					agent_id: a.agentId,
					session_key: a.sessionKey,
					include_sent: "true",
					include_self: "true",
				});
				const r = await fetchImpl(`${baseUrl}/api/cross-agent/stream?${q}`, {
					headers: { ...headers, accept: "text/event-stream" },
					signal: ac.signal,
				});
				if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
				backoff = 250;
				const dec = new TextDecoder();
				let buf = "";
				for await (const chunk of r.body) {
					buf += dec.decode(chunk, { stream: true });
					let i;
					while ((i = buf.indexOf("\n\n")) >= 0) {
						const frame = buf.slice(0, i);
						buf = buf.slice(i + 2);
						const data = frame
							.split("\n")
							.filter((l) => l.startsWith("data:"))
							.map((l) => l.slice(5).trimStart())
							.join("\n");
						if (!data) continue;
						let ev;
						try {
							ev = JSON.parse(data);
						} catch {
							continue;
						}
						if (ev.type === "message" && ev.message) observe(ev.message, "sse");
						else if (ev.type === "snapshot") for (const m of ev.messages ?? []) observe(m, "sse_snapshot");
						else if (ev.type === "presence")
							emit({
								src: "daemon",
								type: "presence",
								agent: label(ev.presence?.agentId, ev.presence?.sessionKey),
								harness: ev.presence?.harness ?? null,
							});
					}
				}
			} catch (e) {
				if (stopped) return;
				emit({
					src: "observer",
					type: "stream_retry",
					agent: label(a.agentId, a.sessionKey),
					message: String(e.message).slice(0, 120),
				});
			}
			await sleep(backoff);
			backoff = Math.min(backoff * 2, 4000);
		}
	}

	return {
		pollOnce,
		knows: (id) => seenDm.has(id),
		observe,
		start() {
			for (const a of Object.values(agents)) if (a.sessionKey) void streamOne(a);
			pollTimer = setInterval(() => void pollOnce(), pollMs);
		},
		async stop() {
			stopped = true;
			clearInterval(pollTimer);
			for (const c of controllers) c.abort();
			await pollOnce();
		},
	};
}
