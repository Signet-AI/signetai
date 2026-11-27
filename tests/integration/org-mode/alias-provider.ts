import assert from "node:assert/strict";
import { record, text } from "./http";

export function aliasProvider(target: {
	agentId: string;
	entityId: string;
	sourceRef: string;
	quote: string;
	alias: string;
}) {
	const requests: string[] = [];
	const results: string[] = [];
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let applied = false;
	let citationRejected = false;
	let calls = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 120,
		async fetch(request) {
			if (request.method === "HEAD") return new Response(null);
			if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "fixture" }] });
			const body = record(await request.json());
			const messages = Array.isArray(body.messages) ? body.messages.map(record) : [];
			const available = new Set(
				Array.isArray(body.tools) ? body.tools.map((tool) => text(record(record(tool).function).name)) : [],
			);
			requests.push(JSON.stringify({ tools: body.tools, messages }));
			const callsInHistory = messages.flatMap((message) =>
				Array.isArray(message.tool_calls) ? message.tool_calls.map(record) : [],
			);
			const outputs = (name: string) =>
				messages.filter(
					(message) =>
						message.role === "tool" &&
						callsInHistory.some((call) => call.id === message.tool_call_id && record(call.function).name === name),
				);
			let name: string | undefined;
			let args: object = { agentId: target.agentId };
			const searches = outputs("search_evidence");
			const appliedOutputs = outputs("apply_ontology_ops");
			if (searches.length === 0 && available.has("search_evidence")) {
				name = "search_evidence";
				args = { ...args, sourceRef: target.sourceRef };
			} else if (searches.length > 0) {
				const evidence = record(JSON.parse(text(searches[0]?.content)));
				assert.equal(evidence.ok, true);
				assert(Array.isArray(evidence.items) && evidence.items.length === 1);
				const item = record(evidence.items[0]);
				assert.equal(item.sourceRef, target.sourceRef);
				assert(text(item.content).includes(target.quote));
				if (available.has("apply_ontology_ops") && appliedOutputs.length === 0) {
					name = "apply_ontology_ops";
					args = {
						...args,
						operations: [
							{
								operation: "create_entity_alias",
								payload: { entity_id: target.entityId, alias: target.alias },
								reason: "The cited evidence gives the project's internal alias.",
								evidence: [{ source_ref: target.sourceRef, quote: target.quote }],
							},
						],
					};
				} else if (appliedOutputs.length > 0) {
					const raw = text(appliedOutputs[0]?.content);
					results.push(raw);
					const result = record(JSON.parse(raw));
					assert.equal(result.ok, true, raw);
					assert(Array.isArray(result.items) && result.items.length === 1, raw);
					assert.equal(record(result.items[0]).ok, true, raw);
					assert.equal(record(record(result.items[0]).result).alias, target.alias, raw);
					applied = true;
					await gate;
					if (appliedOutputs.length === 1) {
						name = "apply_ontology_ops";
						args = {
							agentId: target.agentId,
							operations: [
								{
									operation: "create_entity_alias",
									payload: { entity_id: target.entityId, alias: `${target.alias} rollback probe` },
									reason: "Exercise atomic citation failure.",
									evidence: [{ source_ref: target.sourceRef, quote: target.quote }],
								},
							],
						};
					} else {
						const rejected = record(JSON.parse(text(appliedOutputs[1]?.content)));
						assert(Array.isArray(rejected.items) && rejected.items.length === 1);
						const failed = record(rejected.items[0]);
						assert.equal(failed.ok, false);
						assert(text(failed.error).includes("alias_citation_atomicity_probe"));
						citationRejected = true;
					}
					if (!name && available.has("review_evidence") && outputs("review_evidence").length === 0) {
						name = "review_evidence";
						args = { ...args, items: [{ sourceRef: target.sourceRef, contentOffset: item.contentOffset }] };
					} else if (!name && available.has("memory_head_commit") && outputs("memory_head_commit").length === 0) {
						name = "memory_head_commit";
						args = { ...args, entries: [] };
					}
				}
			}
			const delta = name
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: `alias-${++calls}`,
								type: "function",
								function: { name, arguments: JSON.stringify(args) },
							},
						],
					}
				: { role: "assistant", content: "Recorded the cited alias." };
			const chunk = (delta: object, finish_reason: string | null) =>
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
			return new Response(`${chunk(delta, null)}${chunk({}, name ? "tool_calls" : "stop")}data: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	return {
		server,
		requests,
		results,
		release: () => release(),
		get applied() {
			return applied;
		},
		get citationRejected() {
			return citationRejected;
		},
	};
}
