import assert from "node:assert/strict";
import { record, text } from "./http";

export interface ClaimTarget {
	agentId: string;
	sourceRef: string;
	quote: string;
	value: string;
}

export function claimProvider() {
	let target: ClaimTarget | undefined;
	const evidence: string[] = [];
	const results: string[] = [];
	const requests: string[] = [];
	let calls = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method === "HEAD") return new Response(null);
			if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "fixture" }] });
			assert(target, "Set the current evidence before triggering Dreaming");
			const body = record(await request.json());
			const messages = Array.isArray(body.messages) ? body.messages.map(record) : [];
			const available = new Set(
				Array.isArray(body.tools) ? body.tools.map((tool) => text(record(record(tool).function).name)) : [],
			);
			requests.push(JSON.stringify({ tools: [...available], messages }));
			const toolCalls = messages.flatMap((message) =>
				Array.isArray(message.tool_calls) ? message.tool_calls.map(record) : [],
			);
			const tools = messages.filter((message) => message.role === "tool");
			const outputs = (name: string) =>
				tools.filter((message) =>
					toolCalls.some((call) => call.id === message.tool_call_id && record(call.function).name === name),
				);
			for (const output of tools) results.push(text(output.content));
			const searches = outputs("search_evidence");
			let name: string | undefined;
			let args: object = { agentId: target.agentId };
			if (searches.length === 0 && available.has("search_evidence")) {
				name = "search_evidence";
				args = { ...args, sourceRef: target.sourceRef };
			} else if (searches.length > 0) {
				const raw = text(searches[0]?.content);
				const found = record(JSON.parse(raw));
				assert.equal(found.ok, true, raw);
				assert(Array.isArray(found.items) && found.items.length === 1, raw);
				const item = record(found.items[0]);
				assert.equal(item.sourceRef, target.sourceRef);
				assert(text(item.content).includes(target.quote), raw);
				const speaker = record(item.speaker);
				assert.equal(speaker.kind, "person");
				if (!evidence.includes(raw)) evidence.push(raw);
				const applied = outputs("apply_ontology_ops");
				for (const result of applied)
					assert.equal(record(JSON.parse(text(result.content))).ok, true, text(result.content));
				if (available.has("apply_ontology_ops") && applied.length < 2) {
					name = "apply_ontology_ops";
					let payload: object = { entityId: text(speaker.personEntityId), name: "preferences" };
					if (applied.length === 1) {
						const response = record(JSON.parse(text(applied[0]?.content)));
						assert(Array.isArray(response.items));
						const aspectId = text(record(record(response.items[0]).result).aspectId);
						payload = { entityId: text(speaker.personEntityId), aspectId, claimKey: "preference", value: target.value };
					}
					args = {
						...args,
						operations: [
							{
								operation: applied.length === 0 ? "create_aspect" : "add_claim_value",
								payload,
								evidence: [{ source_ref: target.sourceRef, quote: target.quote }],
								reason: "The authenticated speaker disclosed this preference.",
							},
						],
					};
				} else if (available.has("review_evidence") && outputs("review_evidence").length === 0) {
					name = "review_evidence";
					args = { ...args, items: [{ sourceRef: target.sourceRef, contentOffset: item.contentOffset }] };
				} else if (available.has("memory_head_commit") && outputs("memory_head_commit").length === 0) {
					name = "memory_head_commit";
					args = { ...args, entries: [] };
				}
			}
			const delta = name
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: `claim-${++calls}`,
								type: "function",
								function: { name, arguments: JSON.stringify(args) },
							},
						],
					}
				: { role: "assistant", content: "Filed the authenticated speaker's disclosed preference." };
			const chunk = (delta: object, finish_reason: string | null) =>
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
			return new Response(`${chunk(delta, null)}${chunk({}, name ? "tool_calls" : "stop")}data: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	return {
		server,
		evidence,
		results,
		requests,
		select(value: ClaimTarget) {
			target = value;
			evidence.length = 0;
			results.length = 0;
		},
	};
}
