const COUNT = "(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|a few|a couple of|couple of|few|several|\\d+)";
const UNIT = "(?:day|week|weekend|month|year|hour|night)s?";
const PERIOD =
	"(?:week|weekend|month|year|summer|winter|spring|fall|autumn|night|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)";

const RELATIVE_TIME = new RegExp(
	[
		"\\b(?:yesterday|today|tonight|tomorrow)\\b",
		`(?<!\\bthe\\s)\\blast\\s+${PERIOD}\\b`,
		`\\b(?:this|next|past|coming)\\s+${PERIOD}\\b`,
		`\\b(?:earlier|later)\\s+this\\s+${PERIOD}\\b`,
		`\\b${COUNT}\\s+${UNIT}\\s+(?:ago|from now)\\b`,
		`\\bin\\s+${COUNT}\\s+${UNIT}\\b`,
	].join("|"),
	"i",
);

export function findUnresolvedRelativeTime(text: string): string | null {
	const match = RELATIVE_TIME.exec(text);
	return match === null ? null : match[0];
}
