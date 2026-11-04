import { resolveAgentId } from "./agent-id";
import { listBoardTopics, resolveBoardViewer } from "./board";
import { logger } from "./logger";
import { buildCrossAgentCapabilitySection, harnessHasCrossAgentTools } from "./session-start-format";

export interface CrossAgentSessionSectionRequest {
	readonly harness: string;
	readonly agentId?: string;
	readonly sessionKey?: string;
}

export async function buildCrossAgentSessionSection(req: CrossAgentSessionSectionRequest): Promise<string | null> {
	if (!harnessHasCrossAgentTools(req.harness)) return null;
	const agentId = resolveAgentId(req);
	let topics: readonly { readonly slug: string; readonly threadCount: number }[] = [];
	try {
		topics = await listBoardTopics(await resolveBoardViewer(agentId));
	} catch (error) {
		logger.warn("board", "Board topics unavailable for session start", {
			agentId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return buildCrossAgentCapabilitySection({ harness: req.harness, agentId, sessionKey: req.sessionKey, topics });
}
