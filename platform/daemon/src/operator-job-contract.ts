import { z } from "zod";
import type { ReadScope } from "./read-scope";
import type { EmbeddingConfig, PipelineV2Config } from "./memory-config";
import type { UnembeddedRow } from "./embedding-coverage";
export const operatorInputSchema = z
	.object({
		action: z.enum(["queue.requeue", "queue.cancel", "queue.prune", "embed.audit", "embed.backfill"]),
		agentId: z.string().min(1).max(200).optional(),
		options: z
			.object({
				dryRun: z.boolean().default(true),
				ids: z.array(z.string().min(1).max(200)).max(100).optional(),
				tables: z.array(z.literal("memory")).max(1).optional(),
				olderThanMs: z.number().int().min(0).max(31_536_000_000).optional(),
				errorPattern: z.string().max(128).optional(),
				retentionMs: z.number().int().min(0).max(31_536_000_000).optional(),
				maxBatch: z.number().int().min(1).max(100).default(20),
			})
			.strict()
			.default({ dryRun: true, maxBatch: 20 }),
	})
	.strict();
export type OperatorInput = z.infer<typeof operatorInputSchema>;
export interface OperatorActor {
	readonly userId: string;
	readonly credentialKind: "session" | "api_key";
	readonly credentialId: string;
	readonly permissions: readonly string[];
	readonly boundAgentId: string | null;
	readonly allowedProjects: readonly string[] | null;
}
export interface OperatorJobRow {
	readonly id: string;
	readonly kind: string;
	readonly status: string;
	readonly created_by: string;
	readonly params_json: string;
	readonly progress_json: string | null;
	readonly error: string | null;
	readonly created_at: string;
	readonly finished_at: string | null;
}
export type OperatorRequest =
	| {
			readonly op: "logs-access";
			readonly actor: OperatorActor;
			readonly audit: boolean;
			readonly runtimeId?: string;
			readonly subjectAgentId?: string;
	  }
	| import("./organization-upgrade-contract").UpgradeRequest
	| { readonly op: "settings"; readonly actor: OperatorActor; readonly input: unknown; readonly runtimeId?: string }
	| {
			readonly op: "agent-purge";
			readonly stage: "create" | "next" | "finish" | "fail" | "read";
			readonly actor: OperatorActor;
			readonly agentId?: string;
			readonly jobId?: string;
			readonly runtimeId: string;
	  }
	| { readonly op: "authorize-global"; readonly actor: OperatorActor; readonly runtimeId?: string }
	| {
			readonly op: "create";
			readonly actor: OperatorActor;
			readonly input: OperatorInput;
			readonly scope: ReadScope;
			readonly pipeline: PipelineV2Config;
			readonly embedding: EmbeddingConfig;
			readonly runtimeId: string;
	  }
	| { readonly op: "get"; readonly actor: OperatorActor; readonly jobId?: string; readonly runtimeId?: string }
	| { readonly op: "list"; readonly actor: OperatorActor; readonly runtimeId?: string }
	| {
			readonly op: "admit";
			readonly actor: OperatorActor;
			readonly jobId: string;
			readonly runtimeId: string;
			readonly memory: UnembeddedRow;
	  }
	| {
			readonly op: "commit";
			readonly actor: OperatorActor;
			readonly jobId: string;
			readonly runtimeId: string;
			readonly memory: UnembeddedRow;
			readonly vector: readonly number[];
			readonly embedding: EmbeddingConfig;
	  }
	| {
			readonly op: "finish";
			readonly actor: OperatorActor;
			readonly jobId: string;
			readonly runtimeId: string;
			readonly error: string | null;
	  };
