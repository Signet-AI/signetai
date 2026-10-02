import { formatRecallText, parseRecallPayload } from "@signet/core";
import type { RecallPayload } from "@signet/core";

export function projectRecall(payload: RecallPayload | null): {
	rows: ReturnType<typeof parseRecallPayload>["rows"];
	meta: ReturnType<typeof parseRecallPayload>["meta"];
	text: string | undefined;
} {
	const { rows, meta } = parseRecallPayload(payload);
	return {
		rows,
		meta,
		text: rows.length > 0 ? formatRecallText(payload) : undefined,
	};
}
