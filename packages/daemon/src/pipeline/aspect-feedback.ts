import type { DbAccessor } from "../db-accessor";

export interface AspectFeedbackResult {
	readonly aspectsUpdated: number;
	readonly totalFtsConfirmations: number;
}

export interface FeedbackTelemetrySnapshot {
	readonly lastRunAt: string | null;
	readonly feedbackAspectsUpdated: number;
	readonly feedbackFtsConfirmations: number;
	readonly feedbackDecayedAspects: number;
	readonly feedbackPropagatedAttributes: number;
}

const feedbackTelemetry: {
	lastRunAt: string | null;
	feedbackAspectsUpdated: number;
	feedbackFtsConfirmations: number;
	feedbackDecayedAspects: number;
	feedbackPropagatedAttributes: number;
} = {
	lastRunAt: null,
	feedbackAspectsUpdated: 0,
	feedbackFtsConfirmations: 0,
	feedbackDecayedAspects: 0,
	feedbackPropagatedAttributes: 0,
};

const sessionDecayCounters = new Map<string, number>();

function now(): string {
	return new Date().toISOString();
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export function recordFeedbackTelemetry(update: {
	readonly feedbackAspectsUpdated?: number;
	readonly feedbackFtsConfirmations?: number;
	readonly feedbackDecayedAspects?: number;
	readonly feedbackPropagatedAttributes?: number;
}): void {
	feedbackTelemetry.lastRunAt = now();
	feedbackTelemetry.feedbackAspectsUpdated +=
		update.feedbackAspectsUpdated ?? 0;
	feedbackTelemetry.feedbackFtsConfirmations +=
		update.feedbackFtsConfirmations ?? 0;
	feedbackTelemetry.feedbackDecayedAspects +=
		update.feedbackDecayedAspects ?? 0;
	feedbackTelemetry.feedbackPropagatedAttributes +=
		update.feedbackPropagatedAttributes ?? 0;
}

export function getFeedbackTelemetry(): FeedbackTelemetrySnapshot {
	return { ...feedbackTelemetry };
}

export function shouldRunSessionDecay(
	agentId: string,
	decayIntervalSessions: number,
): boolean {
	if (decayIntervalSessions <= 1) return true;
	const next = (sessionDecayCounters.get(agentId) ?? 0) + 1;
	if (next >= decayIntervalSessions) {
		sessionDecayCounters.set(agentId, 0);
		return true;
	}
	sessionDecayCounters.set(agentId, next);
	return false;
}

export function applyFtsOverlapFeedback(
	accessor: DbAccessor,
	sessionKey: string,
	agentId: string,
	config: {
		readonly delta: number;
		readonly maxWeight: number;
		readonly minWeight: number;
	},
): AspectFeedbackResult {
	const result = accessor.withWriteTx((db) => {
		const confirmedRows = db
			.prepare(
				`SELECT memory_id, fts_hit_count
				 FROM session_memories
				 WHERE session_key = ? AND fts_hit_count > 0`,
			)
			.all(sessionKey) as Array<Record<string, unknown>>;
		if (confirmedRows.length === 0) {
			return {
				aspectsUpdated: 0,
				totalFtsConfirmations: 0,
			};
		}

		const aspectConfirmations = new Map<string, number>();
		let totalFtsConfirmations = 0;
		const aspectLookup = db.prepare(
			`SELECT aspect_id
			 FROM entity_attributes
			 WHERE memory_id = ?
			   AND agent_id = ?
			   AND status = 'active'
			 LIMIT 1`,
		);
		for (const row of confirmedRows) {
			if (typeof row.memory_id !== "string") continue;
			const confirmations = Number(row.fts_hit_count ?? 0);
			if (!Number.isFinite(confirmations) || confirmations <= 0) continue;
			const aspect = aspectLookup.get(
				row.memory_id,
				agentId,
			) as Record<string, unknown> | undefined;
			if (typeof aspect?.aspect_id !== "string") continue;
			aspectConfirmations.set(
				aspect.aspect_id,
				(aspectConfirmations.get(aspect.aspect_id) ?? 0) + confirmations,
			);
			totalFtsConfirmations += confirmations;
		}

		if (aspectConfirmations.size === 0) {
			return {
				aspectsUpdated: 0,
				totalFtsConfirmations,
			};
		}

		const lookupAspect = db.prepare(
			"SELECT weight FROM entity_aspects WHERE id = ? AND agent_id = ?",
		);
		const updateAspect = db.prepare(
			`UPDATE entity_aspects
			 SET weight = ?, updated_at = ?
			 WHERE id = ? AND agent_id = ?`,
		);
		const ts = now();
		let aspectsUpdated = 0;
		for (const [aspectId, confirmations] of aspectConfirmations) {
			const row = lookupAspect.get(
				aspectId,
				agentId,
			) as Record<string, unknown> | undefined;
			const currentWeight = Number(row?.weight ?? Number.NaN);
			if (!Number.isFinite(currentWeight)) continue;
			updateAspect.run(
				clamp(
					currentWeight + config.delta * confirmations,
					config.minWeight,
					config.maxWeight,
				),
				ts,
				aspectId,
				agentId,
			);
			aspectsUpdated++;
		}

		return {
			aspectsUpdated,
			totalFtsConfirmations,
		};
	});

	recordFeedbackTelemetry({
		feedbackAspectsUpdated: result.aspectsUpdated,
		feedbackFtsConfirmations: result.totalFtsConfirmations,
	});
	return result;
}

export function decayAspectWeights(
	accessor: DbAccessor,
	agentId: string,
	config: {
		readonly decayRate: number;
		readonly minWeight: number;
		readonly staleDays: number;
	},
): number {
	const decayed = accessor.withWriteTx((db) => {
		const staleRows = db
			.prepare(
				`SELECT id, weight
				 FROM entity_aspects
				 WHERE agent_id = ?
				   AND updated_at < datetime('now', ?)
				   AND weight > ?`,
			)
			.all(
				agentId,
				`-${config.staleDays} days`,
				config.minWeight,
			) as Array<Record<string, unknown>>;
		if (staleRows.length === 0) return 0;

		const updateAspect = db.prepare(
			`UPDATE entity_aspects
			 SET weight = ?, updated_at = ?
			 WHERE id = ? AND agent_id = ?`,
		);
		const ts = now();
		let count = 0;
		for (const row of staleRows) {
			if (typeof row.id !== "string") continue;
			const weight = Number(row.weight ?? Number.NaN);
			if (!Number.isFinite(weight)) continue;
			updateAspect.run(
				Math.max(config.minWeight, weight - config.decayRate),
				ts,
				row.id,
				agentId,
			);
			count++;
		}
		return count;
	});
	return decayed;
}
