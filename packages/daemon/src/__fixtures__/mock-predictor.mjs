#!/usr/bin/env node
/**
 * Mock predictor sidecar for testing.
 * Reads JSON-RPC from stdin, writes responses to stdout.
 *
 * Behaviors controlled by argv:
 *   --hang       Don't respond to "score" requests (simulate timeout)
 *   --crash      Exit with code 1 after first request
 *   --slow=<ms>  Delay responses by N ms
 */

import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const hang = args.includes("--hang");
const crash = args.includes("--crash");
const slowArg = args.find((a) => a.startsWith("--slow="));
const slowMs = slowArg ? parseInt(slowArg.split("=")[1], 10) : 0;

let requestCount = 0;

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
	if (line.trim().length === 0) return;

	let req;
	try {
		req = JSON.parse(line);
	} catch {
		const resp = {
			jsonrpc: "2.0",
			id: null,
			error: { code: -32700, message: "parse error" },
		};
		process.stdout.write(JSON.stringify(resp) + "\n");
		return;
	}

	requestCount++;

	if (crash && requestCount > 1) {
		process.exit(1);
	}

	function respond() {
		let result;

		switch (req.method) {
			case "status":
				result = {
					trained: false,
					training_pairs: 0,
					model_version: 1,
					last_trained: null,
				};
				break;

			case "score":
				if (hang) return; // Don't respond
				result = {
					scores: (req.params.candidate_ids || []).map((id, i) => ({
						id,
						score: 1.0 / (i + 1),
					})),
				};
				break;

			case "train_from_db":
				result = {
					loss: 0.42,
					step: 1,
					samples_used: req.params.limit || 10,
					samples_skipped: 0,
					duration_ms: 100,
					canary_score_variance: 0.1,
					canary_topk_stability: 0.9,
					checkpoint_saved: false,
				};
				break;

			case "save_checkpoint":
				result = { saved: true };
				break;

			default:
				const errResp = {
					jsonrpc: "2.0",
					id: req.id,
					error: { code: -32601, message: "method not found" },
				};
				process.stdout.write(JSON.stringify(errResp) + "\n");
				return;
		}

		const resp = {
			jsonrpc: "2.0",
			id: req.id,
			result,
		};
		process.stdout.write(JSON.stringify(resp) + "\n");
	}

	if (slowMs > 0) {
		setTimeout(respond, slowMs);
	} else {
		respond();
	}
});

rl.on("close", () => {
	process.exit(0);
});
