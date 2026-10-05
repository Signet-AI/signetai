const COUNT = "(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|a few|a couple of|couple of|few|several|\\d+)";
const UNIT = "(?:day|week|weekend|month|year|hour|night)s?";
const PERIOD =
	"(?:week|weekend|month|year|summer|winter|spring|fall|autumn|night|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)";
const MONTH =
	"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

const RELATIVE_TIME = new RegExp(
	[
		"\\b(?:yesterday|today|tonight|tomorrow)\\b",
		`(?<!\\bthe\\s)\\blast\\s+${PERIOD}\\b`,
		`\\b(?:this|next|past|coming)\\s+${PERIOD}\\b`,
		`\\b(?:earlier|later)\\s+this\\s+${PERIOD}\\b`,
		`\\b${COUNT}\\s+${UNIT}\\s+(?:ago|from now)\\b`,
	].join("|"),
	"i",
);

const ABSOLUTE_DATE = new RegExp(
	[
		"\\b\\d{4}-\\d{2}(?:-\\d{2})?\\b",
		`\\b${MONTH}\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?\\d{4}\\b`,
		`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?,?\\s+\\d{4}\\b`,
	].join("|"),
	"i",
);

export function findUnresolvedRelativeTime(text: string): string | null {
	const match = RELATIVE_TIME.exec(text);
	if (match === null || ABSOLUTE_DATE.test(text)) return null;
	return match[0];
}
