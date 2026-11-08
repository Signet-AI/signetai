export const ONBOARDING_STEPS = [
	"Welcome",
	"How it works",
	"Identity",
	"Harnesses",
	"Connection",
	"Sources",
	"Search",
	"First memory",
	"Usage data",
	"Summary",
];

export function restoreOnboardingStep(step: unknown): number {
	if (typeof step === "string") return ONBOARDING_STEPS.indexOf(step);
	if (typeof step === "number" && Number.isInteger(step)) return [0, 2, 3, 4, 5, 6, 1, 7, 9][step] ?? -1;
	return -1;
}
